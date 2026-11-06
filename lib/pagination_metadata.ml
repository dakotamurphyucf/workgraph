open Core
module F = Api_codec.Fields

let ( ++ ) = F.both

let unwrap = function
  | Ok value -> value
  | Error p -> raise (Json.Decode_error p)
;;

module Stop = struct
  type t =
    | Complete
    | Page_limit
    | Byte_limit
    | No_progress
    | Needs_larger_budget
    | Indexing_incomplete
    | Server_field_omissions
    | Server_item_omissions
    | Error
    | Metadata_limit
  [@@deriving equal, sexp]

  let names =
    [ "complete", Complete
    ; "page_limit", Page_limit
    ; "byte_limit", Byte_limit
    ; "no_progress", No_progress
    ; "needs_larger_budget", Needs_larger_budget
    ; "indexing_incomplete", Indexing_incomplete
    ; "server_field_omissions", Server_field_omissions
    ; "server_item_omissions", Server_item_omissions
    ; "error", Error
    ; "metadata_limit", Metadata_limit
    ]
  ;;

  let to_string t =
    List.find_map_exn names ~f:(fun (name, value) ->
      if equal t value then Some name else None)
  ;;

  let codec = Api_codec.enum names ~equal
end

let maximum = 65536
let count = Api_codec.decimal ~max:Int.max_value
let bounded_text maximum = Api_codec.text ~max_bytes:maximum

let nonblank maximum =
  Api_codec.map
    (bounded_text maximum)
    ~decode:(fun value ->
      if String.is_empty value
      then Error (Problem.create Invalid_argument "empty pagination request field")
      else Ok value)
    ~encode:Fn.id
    ~description:"Nonempty exact request field."
;;

let checked codec validate =
  Api_codec.map
    codec
    ~decode:(fun value ->
      Json.decode (fun () ->
        validate value;
        value))
    ~encode:Fn.id
    ~description:
      "Validated bounded client-added continuation metadata; daemon payload budget \
       remains separate."
;;

let request_codec =
  Api_codec.object_
    (F.map
       (F.required "jsonrpc" (Api_codec.literal "2.0")
        ++ F.required
             "workgraph_api"
             (Api_codec.literal (Current_format.value Application_api |> Json.text))
        ++ F.required "id" (nonblank 256)
        ++ F.required "method" (nonblank 128)
        ++ F.required
             "params"
             (checked
                (Api_codec.json ~max_bytes:(4 * 1024 * 1024) ~max_depth:64)
                (function
                  | `Object _ -> ()
                  | _ -> Json.fail Invalid_argument "continuation params require object"))
       )
       ~decode:(fun (((((), ()), id), method_), params) ->
         Json.obj
           [ "jsonrpc", Json.string "2.0"
           ; "workgraph_api", Current_format.value Application_api
           ; "id", Json.string id
           ; "method", Json.string method_
           ; "params", params
           ])
       ~encode:(fun value ->
         ( ( (((), ()), Json.text (Json.field value "id"))
           , Json.text (Json.field value "method") )
         , Json.field value "params" )))
;;

let consistency =
  Api_codec.enum
    (List.map
       [ "snapshot_guard"
       ; "current_revision_guard"
       ; "opaque_captured_cursor"
       ; "current_revision_cursor"
       ; "notification_through"
       ; "immutable_history_head"
       ; "run_revision_and_history_head"
       ]
       ~f:(fun value -> value, value))
    ~equal:String.equal
;;

let validate_capture kind capture =
  let counter name = ignore (Json.integer (Json.field capture name) : int) in
  let digest value =
    let text = Json.text value in
    if
      String.length text <> 64
      || not
           (String.for_all text ~f:(fun c ->
              Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
    then Json.fail Invalid_argument "invalid continuation capture digest"
  in
  match kind with
  | "snapshot_guard" ->
    Json.fields capture ~allowed:[ "snapshot" ];
    digest (Json.field capture "snapshot")
  | "current_revision_guard" ->
    if Option.is_some (Json.optional capture "workspace_revision")
    then (
      Json.fields capture ~allowed:[ "workspace_revision" ];
      counter "workspace_revision")
    else (
      Json.fields
        capture
        ~allowed:[ "query_revision"; "query_scope"; "discussion_serial"; "head" ];
      counter "query_revision";
      Option.iter (Json.optional capture "head") ~f:(function
        | `Null -> ()
        | head -> digest head);
      let scope = Json.text (Json.field capture "query_scope") in
      if
        not
          (List.mem
             [ "communication"; "runs"; "evidence"; "policy" ]
             scope
             ~equal:String.equal)
      then Json.fail Invalid_argument "invalid continuation query scope";
      Option.iter (Json.optional capture "discussion_serial") ~f:(fun _ ->
        if not (String.equal scope "communication")
        then Json.fail Invalid_argument "discussion capture requires communication scope";
        counter "discussion_serial"))
  | "opaque_captured_cursor" ->
    if Option.is_some (Json.optional capture "captured_now_unix_ms")
    then (
      Json.fields capture ~allowed:[ "captured_now_unix_ms" ];
      counter "captured_now_unix_ms")
    else (
      Json.fields capture ~allowed:[ "through"; "lineage"; "source" ];
      counter "through";
      Option.iter (Json.optional capture "lineage") ~f:digest;
      Option.iter (Json.optional capture "source") ~f:(fun value ->
        if not (List.mem [ "planning"; "history" ] (Json.text value) ~equal:String.equal)
        then Json.fail Invalid_argument "invalid continuation feed source"))
  | "current_revision_cursor" ->
    Json.fields capture ~allowed:[ "workspace_revision"; "observed_unix_ms" ];
    counter "workspace_revision";
    Option.iter (Json.optional capture "observed_unix_ms") ~f:(fun value ->
      ignore (Json.integer value : int))
  | "notification_through" ->
    Json.fields capture ~allowed:[ "through" ];
    counter "through"
  | "run_revision_and_history_head" ->
    Json.fields capture ~allowed:[ "head"; "run_revision" ];
    counter "run_revision";
    (match Json.field capture "head" with
     | `Null -> ()
     | head -> digest head)
  | "immutable_history_head" ->
    Json.fields capture ~allowed:[ "head" ];
    (match Json.field capture "head" with
     | `Null -> ()
     | head -> digest head)
  | _ -> Json.fail Invalid_argument "unknown continuation consistency"
;;

let validate_requests ~complete ~stop ~next_request ~retry_request =
  if not (Bool.equal complete (Stop.equal stop Complete))
  then Json.fail Invalid_argument "continuation completion differs from stop";
  if complete && (Option.is_some next_request || Option.is_some retry_request)
  then Json.fail Invalid_argument "complete continuation cannot carry requests";
  if Option.is_some next_request && Option.is_some retry_request
  then Json.fail Invalid_argument "continuation cannot advance and retry simultaneously";
  if not (Bool.equal (Stop.equal stop Page_limit) (Option.is_some next_request))
  then Json.fail Invalid_argument "next request differs from available-page stop"
;;

module Section = struct
  type t =
    { path : string
    ; response_path : string option
    ; complete : bool
    ; stop : Stop.t
    ; next_request : Jsonaf.t option
    ; retry_request : Jsonaf.t option
    }

  let codec =
    Api_codec.object_
      (F.map
         (F.required "path" (bounded_text 256)
          ++ F.optional "response_path" (bounded_text 256)
          ++ F.required "complete" Api_codec.boolean
          ++ F.required "stop" Stop.codec
          ++ F.required "next_request" (Api_codec.nullable request_codec)
          ++ F.required "retry_request" (Api_codec.nullable request_codec))
         ~decode:
           (fun
             (((((path, response_path), complete), stop), next_request), retry_request) ->
           { path; response_path; complete; stop; next_request; retry_request })
         ~encode:
           (fun
             { path; response_path; complete; stop; next_request; retry_request } ->
           ((((path, response_path), complete), stop), next_request), retry_request))
    |> fun codec ->
    checked codec (fun t ->
      if not (String.is_prefix t.path ~prefix:"/data/")
      then Json.fail Invalid_argument "section path must identify returned data";
      Option.iter t.response_path ~f:(fun path ->
        if not (String.equal path "/data" || String.is_prefix path ~prefix:"/data/")
        then
          Json.fail Invalid_argument "section response path must identify returned data");
      validate_requests
        ~complete:t.complete
        ~stop:t.stop
        ~next_request:t.next_request
        ~retry_request:t.retry_request)
  ;;
end

let sections_stop sections =
  if List.for_all sections ~f:(fun s -> s.Section.complete)
  then Stop.Complete
  else if
    List.exists sections ~f:(fun s -> Stop.equal s.Section.stop Server_field_omissions)
  then Server_field_omissions
  else if List.exists sections ~f:(fun s -> Option.is_some s.Section.next_request)
  then Page_limit
  else (List.find_exn sections ~f:(fun s -> not s.Section.complete)).stop
;;

type t =
  { complete : bool
  ; stop : Stop.t
  ; consistency : string
  ; capture : Jsonaf.t
  ; next_request : Jsonaf.t option
  ; retry_request : Jsonaf.t option
  ; required_bytes : int option
  ; returned_bytes : int
  ; sections : Section.t list option
  }

let core_base =
  Api_codec.object_
    (F.map
       (F.required "complete" Api_codec.boolean
        ++ F.required "stop" Stop.codec
        ++ F.required "consistency" consistency
        ++ F.required "capture" (Api_codec.json ~max_bytes:4096 ~max_depth:4)
        ++ F.required "next_request" (Api_codec.nullable request_codec)
        ++ F.required "retry_request" (Api_codec.nullable request_codec)
        ++ F.required "required_bytes" (Api_codec.nullable count)
        ++ F.required
             "returned_bytes"
             (Api_codec.map
                count
                ~decode:Result.return
                ~encode:Fn.id
                ~description:
                  "Canonical UTF-8 bytes of this continuation metadata object only; not \
                   the returned page. Page bytes are reported in \
                   meta.budget.returned_bytes when available.")
        ++ F.required
             "max_bytes"
             (Api_codec.map
                (Api_codec.literal "65536")
                ~decode:Result.return
                ~encode:Fn.id
                ~description:
                  "Fixed cap on this continuation metadata object only. Independent of \
                   the request max_bytes and the daemon page budget in \
                   meta.budget.max_bytes."))
       ~decode:
         (fun
           ( ( ( ( ((((complete, stop), consistency), capture), next_request)
                 , retry_request )
               , required_bytes )
             , returned_bytes )
           , () ) ->
         { complete
         ; stop
         ; consistency
         ; capture
         ; next_request
         ; retry_request
         ; required_bytes
         ; returned_bytes
         ; sections = None
         })
       ~encode:(fun t ->
         ( ( ( ( ((((t.complete, t.stop), t.consistency), t.capture), t.next_request)
               , t.retry_request )
             , t.required_bytes )
           , t.returned_bytes )
         , () )))
;;

let base =
  Api_codec.merge_objects
    core_base
    (Api_codec.object_
       (F.optional "sections" (Api_codec.list Section.codec ~max_items:32)))
  |> Api_codec.map
       ~decode:(fun (t, sections) -> Ok { t with sections })
       ~encode:(fun t -> t, t.sections)
       ~description:
         "Flat continuation or independently paged nested sections. Section paths \
          identify the portion to consume from each subsequent response."
;;

let codec =
  checked base (fun t ->
    validate_capture t.consistency t.capture;
    if not (Bool.equal t.complete (Stop.equal t.stop Complete))
    then Json.fail Invalid_argument "continuation completion differs from stop";
    (match t.sections with
     | None ->
       validate_requests
         ~complete:t.complete
         ~stop:t.stop
         ~next_request:t.next_request
         ~retry_request:t.retry_request
     | Some sections ->
       if
         List.is_empty sections
         || List.contains_dup
              (List.map sections ~f:(fun s -> s.Section.path))
              ~compare:String.compare
         || (not (Stop.equal t.stop (sections_stop sections)))
         || Option.is_some t.next_request
         || Option.is_some t.retry_request
       then Json.fail Invalid_argument "invalid nested continuation summary");
    if Stop.equal t.stop Metadata_limit
    then (
      if
        Option.is_some t.next_request
        || Option.is_some t.retry_request
        || not (Option.exists t.required_bytes ~f:(fun n -> n > maximum))
      then
        Json.fail
          Invalid_argument
          "metadata limit marker requires an omitted exact continuation")
    else if Option.is_some t.required_bytes
    then Json.fail Invalid_argument "available continuation cannot declare omitted bytes";
    let bytes = Api_codec.encode base t |> unwrap |> Json.canonical |> String.length in
    if bytes <> t.returned_bytes || bytes > maximum
    then Json.fail Invalid_argument "continuation byte count or budget differs")
;;

let create_internal
      ?sections
      ~complete
      ~stop
      ~consistency
      ~capture
      ~next_request
      ~retry_request
      ()
  =
  Json.decode (fun () ->
    (* Validate the caller's original envelopes before encoding can reconstruct
       their fixed fields, or an oversized marker can omit their requests. *)
    List.iter [ next_request; retry_request ] ~f:(fun request ->
      Option.iter request ~f:(fun json ->
        ignore (Api_codec.decode request_codec json |> unwrap : Jsonaf.t)));
    let rec sized t =
      let bytes = Api_codec.encode base t |> unwrap |> Json.canonical |> String.length in
      if bytes = t.returned_bytes then t else sized { t with returned_bytes = bytes }
    in
    let t =
      sized
        { complete
        ; stop
        ; consistency
        ; capture
        ; next_request
        ; retry_request
        ; required_bytes = None
        ; returned_bytes = 0
        ; sections
        }
    in
    let t =
      if t.returned_bytes <= maximum
      then t
      else
        sized
          { t with
            complete = false
          ; stop = Metadata_limit
          ; next_request = None
          ; retry_request = None
          ; required_bytes = Some t.returned_bytes
          ; returned_bytes = 0
          ; sections = None
          }
    in
    ignore (Api_codec.encode codec t |> unwrap : Jsonaf.t);
    t)
;;

let create ~complete ~stop ~consistency ~capture ~next_request ~retry_request =
  create_internal ~complete ~stop ~consistency ~capture ~next_request ~retry_request ()
;;

let create_sections ~consistency ~capture ~sections =
  Json.decode (fun () ->
    if List.is_empty sections then Json.fail Invalid_argument "empty nested continuation";
    if
      List.contains_dup
        (List.map sections ~f:(fun s -> s.Section.path))
        ~compare:String.compare
    then Json.fail Invalid_argument "duplicate nested continuation path";
    List.iter sections ~f:(fun section ->
      List.iter [ section.Section.next_request; section.retry_request ] ~f:(fun request ->
        Option.iter request ~f:(fun json ->
          ignore (Api_codec.decode request_codec json |> unwrap : Jsonaf.t))));
    let stop = sections_stop sections in
    create_internal
      ~sections
      ~consistency
      ~capture
      ~complete:(Stop.equal stop Complete)
      ~stop
      ~next_request:None
      ~retry_request:None
      ()
    |> unwrap)
;;

let complete t = t.complete
let stop t = t.stop
let next_request t = t.next_request
let retry_request t = t.retry_request
let to_json t = Api_codec.encode codec t |> unwrap
