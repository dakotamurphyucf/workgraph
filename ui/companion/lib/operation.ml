open Core
open Workgraph
module Id = Workgraph.Id.Resource

module Context = struct
  type t =
    { workspace : Workgraph.Id.Workspace.t option
    ; project : Workgraph.Id.Project.t option
    ; writer : Writer.t
    }

  let create ~workspace ~project ~writer = { workspace; project; writer }
  let workspace t = t.workspace
  let project t = t.project
  let writer t = t.writer

  let to_json t =
    Json.obj
      [ ( "workspace_id"
        , Option.value_map
            t.workspace
            ~default:`Null
            ~f:Workgraph.Id.Workspace.jsonaf_of_t )
      ; ( "project_id"
        , Option.value_map t.project ~default:`Null ~f:Workgraph.Id.Project.jsonaf_of_t )
      ; "writer", Writer.to_json t.writer
      ]
  ;;

  let of_json value =
    Json.decode (fun () ->
      Json.fields value ~allowed:[ "workspace_id"; "project_id"; "writer" ];
      let nullable field decode =
        match Json.field value field with
        | `Null -> None
        | value -> Some (decode value)
      in
      create
        ~workspace:(nullable "workspace_id" Workgraph.Id.Workspace.t_of_jsonaf)
        ~project:(nullable "project_id" Workgraph.Id.Project.t_of_jsonaf)
        ~writer:(Writer.of_json (Json.field value "writer") |> Disk.unwrap))
  ;;
end

module Preparation = struct
  type t =
    { intention_id : string
    ; connection : Connection_profile.t
    ; context : Context.t
    ; method_ : string
    ; params : Jsonaf.t
    }

  let intention_id t = t.intention_id
  let connection t = t.connection
  let context t = t.context
  let method_ t = t.method_
  let params t = t.params

  let to_json t =
    Json.obj
      [ "intention_id", Json.string t.intention_id
      ; "connection", Connection_profile.to_json t.connection
      ; "context", Context.to_json t.context
      ; "method", Json.string t.method_
      ; "params", t.params
      ]
  ;;

  let input_hash t = Json.hash (Json.canonical (to_json t))

  let create ~intention_id ~connection ~context ~method_ ~params =
    Json.decode (fun () ->
      ignore (Id.of_string intention_id |> Disk.unwrap : Id.t);
      let request =
        Protocol.Request.create ~id:"ui-validation" ~method_ ~params |> Disk.unwrap
      in
      (* The native constructor checks the byte envelope. Check its actual frame
         nesting too, before any local admission or generated identity. *)
      ignore
        (Json.parse (Json.canonical (Protocol.Request.to_json request)) |> Disk.unwrap
         : Jsonaf.t);
      match Api_catalog.find method_ with
      | None -> Json.fail Not_found "method is absent from the executable catalog"
      | Some (Api_method.Packed.Pack descriptor) ->
        (match Api_method.mode descriptor with
         | Read ->
           Json.fail Invalid_argument "prepare accepts write or mutation descriptors only"
         | Write | Mutation -> ());
        let validation_params =
          if
            Cli_mutation_identity.required request
            && Option.is_none (Json.optional params "mutation_id")
          then (
            match params with
            | `Object fields ->
              Json.obj (("mutation_id", Json.string "ui-validation") :: fields)
            | _ -> Json.fail Invalid_argument "params must be an object")
          else params
        in
        ignore
          (Api_codec.decode (Api_method.request_codec descriptor) validation_params
           |> Disk.unwrap);
        let fields = Api_catalog.request_fields method_ |> Option.value ~default:[] in
        let writer = Context.writer context in
        if List.mem fields "actor_id" ~equal:String.equal
        then (
          let actual =
            Json.optional params "actor_id"
            |> Option.map ~f:Workgraph.Id.Actor.t_of_jsonaf
          in
          if
            not
              (Option.equal Workgraph.Id.Actor.equal actual (Some (Writer.actor writer)))
          then
            Json.fail
              Invalid_argument
              "effective draft writer differs from actual actor_id parameter");
        if List.mem fields "run_id" ~equal:String.equal
        then (
          let actual =
            Json.optional params "run_id" |> Option.map ~f:Workgraph.Id.Run.t_of_jsonaf
          in
          if not (Option.equal Workgraph.Id.Run.equal actual (Writer.run writer))
          then
            Json.fail
              Invalid_argument
              "effective draft writer differs from actual run_id parameter");
        { intention_id; connection; context; method_; params })
  ;;

  let of_json value =
    Json.decode (fun () ->
      Json.fields
        value
        ~allowed:[ "intention_id"; "connection"; "context"; "method"; "params" ];
      create
        ~intention_id:(Json.text (Json.field value "intention_id"))
        ~connection:
          (Connection_profile.of_json (Json.field value "connection") |> Disk.unwrap)
        ~context:(Context.of_json (Json.field value "context") |> Disk.unwrap)
        ~method_:(Json.text (Json.field value "method"))
        ~params:(Json.field value "params")
      |> Disk.unwrap)
  ;;
end

type state =
  | Prepared_unsent
  | Sending
  | Committed of Api_response.t
  | Observed of Api_response.t
  | Rejected of Problem.t
  | Outcome_unknown of Problem.t

type t =
  { id : Id.t
  ; preparation : Preparation.t
  ; request : Protocol.Request.t
  ; journal_path : string option
  ; revision : int
  ; state : state
  ; diagnostic : Problem.t option
  }

let create ~id ~preparation ~request ~journal_path =
  { id
  ; preparation
  ; request
  ; journal_path
  ; revision = 1
  ; state = Prepared_unsent
  ; diagnostic = None
  }
;;

let id t = t.id
let preparation t = t.preparation
let request t = t.request
let journal_path t = t.journal_path
let state t = t.state
let revision t = t.revision

let with_state t state =
  if t.revision = Int.max_value
  then Json.fail Conflict "operation observation revision exhausted";
  { t with state; revision = t.revision + 1; diagnostic = None }
;;

let with_diagnostic t diagnostic =
  if t.revision = Int.max_value
  then Json.fail Conflict "operation observation revision exhausted";
  { t with diagnostic = Some diagnostic; revision = t.revision + 1 }
;;

let state_kind = function
  | Prepared_unsent -> "prepared_unsent"
  | Sending -> "sending"
  | Committed _ -> "committed"
  | Observed _ -> "observed"
  | Rejected _ -> "rejected"
  | Outcome_unknown _ -> "outcome_unknown"
;;

let state_json state =
  let fields =
    match state with
    | Prepared_unsent | Sending -> []
    | Committed response | Observed response ->
      [ "response", Api_response.to_json response ]
    | Rejected problem | Outcome_unknown problem -> [ "problem", Problem.to_json problem ]
  in
  Json.obj (("kind", Json.string (state_kind state)) :: fields)
;;

let diagnostic_json t = Option.value_map t.diagnostic ~default:`Null ~f:Problem.to_json

let to_json t =
  Json.obj
    [ "format", Json.string "workgraph-ui-operation-1"
    ; "operation_id", Id.jsonaf_of_t t.id
    ; "preparation", Preparation.to_json t.preparation
    ; "preparation_input_hash", Json.string (Preparation.input_hash t.preparation)
    ; "connection", Connection_profile.to_json (Preparation.connection t.preparation)
    ; "request", Protocol.Request.to_json t.request
    ; "journal_path", Option.value_map t.journal_path ~default:`Null ~f:Json.string
    ; "revision", Json.int t.revision
    ; "state", state_json t.state
    ; "diagnostic", diagnostic_json t
    ; ( "receipt_lookup_supported"
      , if Acknowledgement.receipt_lookup_supported t.request then `True else `False )
    ]
;;

let summary t =
  let connection = Preparation.connection t.preparation in
  let params = Protocol.Request.params t.request in
  Json.obj
    [ "operation_id", Id.jsonaf_of_t t.id
    ; "intention_id", Json.string (Preparation.intention_id t.preparation)
    ; ( "connection_id"
      , Connection_profile.Id.jsonaf_of_t (Connection_profile.id connection) )
    ; ( "generation"
      , Connection_profile.Generation.jsonaf_of_t
          (Connection_profile.generation connection) )
    ; "method", Json.string (Protocol.Request.method_ t.request)
    ; "revision", Json.int t.revision
    ; "state_kind", Json.string (state_kind t.state)
    ; "workspace_id", Option.value (Json.optional params "workspace_id") ~default:`Null
    ; "actor_id", Option.value (Json.optional params "actor_id") ~default:`Null
    ; "run_id", Option.value (Json.optional params "run_id") ~default:`Null
    ; "diagnostic", diagnostic_json t
    ; ( "receipt_lookup_supported"
      , if Acknowledgement.receipt_lookup_supported t.request then `True else `False )
    ]
;;

let validate_request preparation request =
  let params = Protocol.Request.params request in
  let original = Preparation.params preparation in
  let comparable =
    if
      Option.is_none (Json.optional original "mutation_id")
      && Cli_mutation_identity.required request
    then (
      match params with
      | `Object fields ->
        Json.obj (List.Assoc.remove fields ~equal:String.equal "mutation_id")
      | _ -> params)
    else params
  in
  if
    not
      (String.equal (Preparation.method_ preparation) (Protocol.Request.method_ request)
       && String.equal (Json.canonical original) (Json.canonical comparable))
  then Json.fail Corrupt_store "saved request differs from immutable preparation";
  match
    Api_catalog.validate_request ~method_:(Protocol.Request.method_ request) ~params
  with
  | Some result -> Disk.unwrap result
  | None -> Json.fail Corrupt_store "saved request method is absent from catalog"
;;

let of_json value =
  Json.decode (fun () ->
    Json.fields
      value
      ~allowed:
        [ "format"
        ; "operation_id"
        ; "preparation"
        ; "preparation_input_hash"
        ; "connection"
        ; "request"
        ; "journal_path"
        ; "revision"
        ; "state"
        ; "diagnostic"
        ; "receipt_lookup_supported"
        ];
    if
      not
        (String.equal (Json.text (Json.field value "format")) "workgraph-ui-operation-1")
    then Json.fail Unsupported_version "unsupported operation storage representation";
    let preparation =
      Preparation.of_json (Json.field value "preparation") |> Disk.unwrap
    in
    if
      not
        (String.equal
           (Preparation.input_hash preparation)
           (Json.text (Json.field value "preparation_input_hash")))
    then Json.fail Corrupt_store "preparation input hash mismatch";
    if
      not
        (String.equal
           (Json.canonical
              (Connection_profile.to_json (Preparation.connection preparation)))
           (Json.canonical (Json.field value "connection")))
    then Json.fail Corrupt_store "operation connection snapshot mismatch";
    let request = Protocol.Request.of_json (Json.field value "request") |> Disk.unwrap in
    validate_request preparation request;
    let supported =
      if Acknowledgement.receipt_lookup_supported request then `True else `False
    in
    if
      not
        (String.equal
           (Json.canonical supported)
           (Json.canonical (Json.field value "receipt_lookup_supported")))
    then Json.fail Corrupt_store "operation receipt capability mismatch";
    let journal_path =
      match Json.field value "journal_path" with
      | `Null -> None
      | value ->
        let path = Json.text value in
        Disk.absolute path;
        Some path
    in
    if Cli_mutation_identity.required request && Option.is_none journal_path
    then Json.fail Corrupt_store "durable operation lacks exact request journal";
    let revision = Json.integer (Json.field value "revision") in
    if revision < 1 then Json.fail Corrupt_store "operation revision must be positive";
    let state_value = Json.field value "state" in
    let state_kind = Json.text (Json.field state_value "kind") in
    let revision =
      if String.equal state_kind "sending"
      then (
        if revision = Int.max_value
        then
          Json.fail
            Conflict
            "operation revision exhausted; cannot publish interrupted-send recovery, \
             retain saved request for exact receipt inspection";
        revision + 1)
      else revision
    in
    let state =
      match state_kind with
      | "prepared_unsent" ->
        Json.fields state_value ~allowed:[ "kind" ];
        Prepared_unsent
      | "sending" ->
        Json.fields state_value ~allowed:[ "kind" ];
        Outcome_unknown
          (Problem.create
             Outcome_unknown
             "companion restarted after durable send admission; exchange outcome is \
              unknown")
      | ("committed" | "observed") as kind ->
        Json.fields state_value ~allowed:[ "kind"; "response" ];
        let response =
          Api_response.of_json (Json.field state_value "response") |> Disk.unwrap
        in
        (match Acknowledgement.validate request ~response |> Disk.unwrap with
         | Committed response when String.equal kind "committed" -> Committed response
         | Observed response when String.equal kind "observed" -> Observed response
         | Committed _ | Observed _ ->
           Json.fail Corrupt_store "operation acknowledgement state mismatch")
      | ("rejected" | "outcome_unknown") as kind ->
        Json.fields state_value ~allowed:[ "kind"; "problem" ];
        let problem =
          Problem_wire.of_json (Json.field state_value "problem") |> Disk.unwrap
        in
        if String.equal kind "outcome_unknown"
        then Outcome_unknown problem
        else if Problem.equal_kind problem.kind Outcome_unknown
        then Json.fail Corrupt_store "Outcome_unknown cannot be stored as rejection"
        else Rejected problem
      | _ -> Json.fail Corrupt_store "unknown operation state"
    in
    let diagnostic =
      match Json.field value "diagnostic" with
      | `Null -> None
      | value -> Some (Problem_wire.of_json value |> Disk.unwrap)
    in
    { id = Id.t_of_jsonaf (Json.field value "operation_id")
    ; preparation
    ; request
    ; journal_path
    ; revision
    ; state
    ; diagnostic
    })
;;

let map_field value field ~f =
  match value with
  | `Object fields ->
    Json.obj
      (List.map fields ~f:(fun (key, value) ->
         key, if String.equal key field then f value else value))
  | _ -> Json.fail Corrupt_store "stored JSON document must be an object"
;;

let encode_payload value = Json.string (Json.canonical value)
let decode_payload value = Json.parse (Json.text value) |> Disk.unwrap

let storage_document key value ~encode =
  let payload = if encode then encode_payload else decode_payload in
  match key with
  | "preparation" | "request" -> map_field value "params" ~f:payload
  | "state" ->
    map_field value "response" ~f:(fun response -> map_field response "data" ~f:payload)
  | _ -> value
;;

let to_storage_json t =
  let fields =
    match to_json t with
    | `Object fields -> fields
    | _ -> assert false
  in
  let fields =
    List.map fields ~f:(fun (key, value) ->
      if List.mem [ "preparation"; "request"; "state" ] key ~equal:String.equal
      then key, storage_document key value ~encode:true
      else key, value)
  in
  Json.obj
    [ "format", Json.string "workgraph-ui-operation-storage-1"
    ; "operation", Json.obj fields
    ]
;;

let of_storage_json value =
  Json.decode (fun () ->
    Json.fields value ~allowed:[ "format"; "operation" ];
    if
      not
        (String.equal
           (Json.text (Json.field value "format"))
           "workgraph-ui-operation-storage-1")
    then Json.fail Unsupported_version "unsupported companion operation storage";
    let fields =
      match Json.field value "operation" with
      | `Object fields -> fields
      | _ -> Json.fail Corrupt_store "stored operation must be an object"
    in
    let fields =
      List.map fields ~f:(fun (key, value) ->
        if List.mem [ "preparation"; "request"; "state" ] key ~equal:String.equal
        then key, storage_document key value ~encode:false
        else key, value)
    in
    of_json (Json.obj fields) |> Disk.unwrap)
;;
