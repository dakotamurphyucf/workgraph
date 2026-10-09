open Core

let invalid message = Error (Problem.create Invalid_argument message)

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

let id_codec of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:128)
    ~decode:of_string
    ~encode:to_string
    ~description:"Validated typed identity"
;;

module Scope = struct
  module T = struct
    type t =
      | Workspace
      | Project of Id.Project.t
      | Milestone of Id.Milestone.t
      | Ticket of Id.Ticket.t
    [@@deriving sexp, compare, equal]
  end

  include T
  include Comparable.Make (T)

  let target = function
    | Workspace -> Entity_ref.Workspace
    | Project id -> Project id
    | Milestone id -> Milestone id
    | Ticket id -> Ticket id
  ;;

  module Wire = struct
    type ('project, 'milestone, 'ticket) t =
      | Workspace
      | Project of 'project
      | Milestone of 'milestone
      | Ticket of 'ticket

    let codec project milestone ticket =
      let branch kind fields ~decode ~encode =
        Api_codec.object_
          (Api_codec.Fields.map
             (Api_codec.Fields.both
                (Api_codec.Fields.required "kind" (Api_codec.literal kind))
                fields)
             ~decode:(fun ((), value) -> decode value)
             ~encode:(fun value -> (), encode value))
      in
      let wrong () = Json.fail Invalid_argument "scope mismatch" in
      Api_codec.tagged
        ~discriminator:"kind"
        ~select:(function
          | Workspace -> "workspace"
          | Project _ -> "project"
          | Milestone _ -> "milestone"
          | Ticket _ -> "ticket")
        ~cases:
          [ ( "workspace"
            , branch
                "workspace"
                Api_codec.Fields.empty
                ~decode:(fun () -> Workspace)
                ~encode:(function
                  | Workspace -> ()
                  | Project _ | Milestone _ | Ticket _ -> wrong ()) )
          ; ( "project"
            , branch
                "project"
                (Api_codec.Fields.required "id" project)
                ~decode:(fun id -> Project id)
                ~encode:(function
                  | Project id -> id
                  | Workspace | Milestone _ | Ticket _ -> wrong ()) )
          ; ( "milestone"
            , branch
                "milestone"
                (Api_codec.Fields.required "id" milestone)
                ~decode:(fun id -> Milestone id)
                ~encode:(function
                  | Milestone id -> id
                  | Workspace | Project _ | Ticket _ -> wrong ()) )
          ; ( "ticket"
            , branch
                "ticket"
                (Api_codec.Fields.required "id" ticket)
                ~decode:(fun id -> Ticket id)
                ~encode:(function
                  | Ticket id -> id
                  | Workspace | Project _ | Milestone _ -> wrong ()) )
          ]
    ;;
  end

  let project = id_codec Id.Project.of_string Id.Project.to_string
  let milestone = id_codec Id.Milestone.of_string Id.Milestone.to_string
  let ticket = id_codec Id.Ticket.of_string Id.Ticket.to_string

  let codec =
    Api_codec.map
      (Wire.codec project milestone ticket)
      ~decode:(function
        | Wire.Workspace -> Ok Workspace
        | Project id -> Ok (Project id)
        | Milestone id -> Ok (Milestone id)
        | Ticket id -> Ok (Ticket id))
      ~encode:(function
        | Workspace -> Wire.Workspace
        | Project id -> Project id
        | Milestone id -> Milestone id
        | Ticket id -> Ticket id)
      ~description:"An explicit fact scope; values never inherit between scopes."
  ;;

  let raw_codec =
    Api_codec.as_json
      (Wire.codec
         (Api_codec.reference project)
         (Api_codec.reference milestone)
         (Api_codec.reference ticket))
  ;;
end

module Key = struct
  type t = string [@@deriving sexp_of, compare, equal]

  let of_string text =
    match Api_codec.decode (Api_codec.text ~max_bytes:128) (`String text) with
    | Error problem -> Error problem
    | Ok _ ->
      if
        String.is_empty (String.strip text)
        || Uutf.String.fold_utf_8
             (fun found _ decoded ->
                match decoded with
                | `Uchar character ->
                  let scalar = Stdlib.Uchar.to_int character in
                  found || scalar < 32 || (scalar >= 127 && scalar <= 159)
                | `Malformed _ -> true)
             false
             text
      then invalid "fact key must be nonblank without controls"
      else Ok text
  ;;

  let t_of_sexp sexp = unwrap (of_string (String.t_of_sexp sexp))
  let to_string t = t

  let codec =
    Api_codec.map
      (Api_codec.text ~max_bytes:128)
      ~decode:of_string
      ~encode:to_string
      ~description:
        "Nonblank exact case-sensitive key without controls, 1..128 UTF-8 bytes"
  ;;
end

module Value = struct
  type t = Jsonaf.t

  let codec = Api_codec.json ~max_bytes:4096 ~max_depth:16
  let of_json = Api_codec.decode codec
  let sexp_of_t t = Sexp.Atom (Json.canonical t)

  let t_of_sexp sexp =
    unwrap (Result.bind (Json.parse (String.t_of_sexp sexp)) ~f:of_json)
  ;;

  let to_json t = t

  let type_name = function
    | `Null -> "null"
    | `True | `False -> "boolean"
    | `Number _ -> "number"
    | `String _ -> "string"
    | `Array _ -> "array"
    | `Object _ -> "object"
  ;;
end

module Command = struct
  type t =
    | Put of
        { scope : Scope.t
        ; key : Key.t
        ; expected_revision : int
        ; value : Value.t
        }
    | Delete of
        { scope : Scope.t
        ; key : Key.t
        ; expected_revision : int
        }
  [@@deriving sexp]

  let common_fields scope =
    let open Api_codec in
    Fields.both
      (Fields.required "scope" scope)
      (Fields.both
         (Fields.required "key" Key.codec)
         (Fields.required "expected_revision" (decimal ~max:Int.max_value)))
  ;;

  let put_fields scope =
    Api_codec.Fields.both
      (common_fields scope)
      (Api_codec.Fields.required "value" Value.codec)
  ;;

  let raw_codec method_ =
    let raw fields = Api_codec.as_json (Api_codec.object_ fields) in
    match method_ with
    | "fact.put" -> Ok (raw (put_fields Scope.raw_codec))
    | "fact.delete" -> Ok (raw (common_fields Scope.raw_codec))
    | _ -> invalid "unknown fact mutation"
  ;;

  let codec method_ =
    let open Api_codec in
    match method_ with
    | "fact.put" ->
      Ok
        (object_
           (Fields.map
              (put_fields Scope.codec)
              ~decode:(fun ((scope, (key, expected_revision)), value) ->
                Put { scope; key; expected_revision; value })
              ~encode:(function
                | Put { scope; key; expected_revision; value } ->
                  (scope, (key, expected_revision)), value
                | Delete _ -> Json.fail Invalid_argument "command mismatch")))
    | "fact.delete" ->
      Ok
        (object_
           (Fields.map
              (common_fields Scope.codec)
              ~decode:(fun (scope, (key, expected_revision)) ->
                Delete { scope; key; expected_revision })
              ~encode:(function
                | Delete { scope; key; expected_revision } ->
                  scope, (key, expected_revision)
                | Put _ -> Json.fail Invalid_argument "command mismatch")))
    | _ -> invalid "unknown fact mutation"
  ;;

  let decode ~method_ ~params =
    Result.bind (codec method_) ~f:(fun codec -> Api_codec.decode codec params)
  ;;

  let encode command =
    let method_ =
      match command with
      | Put _ -> "fact.put"
      | Delete _ -> "fact.delete"
    in
    Result.bind (codec method_) ~f:(fun codec ->
      Result.map (Api_codec.encode codec command) ~f:(fun params -> method_, params))
  ;;

  let target = function
    | Put { scope; _ } | Delete { scope; _ } -> Scope.target scope
  ;;
end

module Change = struct
  type t =
    { scope : Scope.t
    ; key : Key.t
    ; revision : int
    ; value : Value.t option
    ; actor_id : Id.Actor.t
    ; run_id : Id.Run.t option
    ; timestamp : string
    ; sequence : int
    }

  let to_json t =
    Json.obj
      ([ "scope", unwrap (Api_codec.encode Scope.codec t.scope)
       ; "key", Json.string t.key
       ; "revision", Json.int t.revision
       ; ("deleted", if Option.is_none t.value then `True else `False)
       ; "actor_id", Id.Actor.jsonaf_of_t t.actor_id
       ; "timestamp", Json.string t.timestamp
       ; "changed_at_revision", Json.int t.sequence
       ]
       @ Option.to_list
           (Option.map t.run_id ~f:(fun id -> "run_id", Id.Run.jsonaf_of_t id))
       @ Option.to_list (Option.map t.value ~f:(fun value -> "value", value)))
  ;;

  let of_json json =
    Json.decode (fun () ->
      Json.fields
        json
        ~allowed:
          [ "scope"
          ; "key"
          ; "revision"
          ; "deleted"
          ; "value"
          ; "actor_id"
          ; "run_id"
          ; "timestamp"
          ; "changed_at_revision"
          ];
      let scope = unwrap (Api_codec.decode Scope.codec (Json.field json "scope")) in
      let key = unwrap (Api_codec.decode Key.codec (Json.field json "key")) in
      let revision = Json.integer (Json.field json "revision") in
      let sequence = Json.integer (Json.field json "changed_at_revision") in
      if revision < 1 || sequence < 1
      then Json.fail Invalid_argument "fact revisions must be positive";
      let deleted =
        unwrap (Api_codec.decode Api_codec.boolean (Json.field json "deleted"))
      in
      let value = Json.optional json "value" in
      if Bool.equal deleted (Option.is_some value)
      then Json.fail Invalid_argument "deleted/value mismatch";
      if deleted && revision = 1
      then Json.fail Invalid_argument "first fact revision cannot be deletion";
      let value = Option.map value ~f:(fun json -> unwrap (Value.of_json json)) in
      let actor_id = Id.Actor.t_of_jsonaf (Json.field json "actor_id") in
      let run_id = Option.map (Json.optional json "run_id") ~f:Id.Run.t_of_jsonaf in
      let timestamp =
        unwrap
          (Api_codec.decode (Api_codec.text ~max_bytes:128) (Json.field json "timestamp"))
      in
      if String.is_empty timestamp then Json.fail Invalid_argument "empty timestamp";
      { scope; key; revision; value; actor_id; run_id; timestamp; sequence })
  ;;

  let codec =
    let module F = Api_codec.Fields in
    let ( ++ ) = F.both in
    Api_codec.map
      (Api_codec.object_
         (F.map
            (F.required "scope" Scope.codec
             ++ F.required "key" Key.codec
             ++ F.required "revision" (Api_codec.decimal ~max:Int.max_value)
             ++ F.required "deleted" Api_codec.boolean
             ++ F.optional "value" Value.codec
             ++ F.required
                  "actor_id"
                  (Coordination_wire.id Id.Actor.of_string Id.Actor.to_string)
             ++ F.optional
                  "run_id"
                  (Coordination_wire.id Id.Run.of_string Id.Run.to_string)
             ++ F.required "timestamp" (Coordination_wire.nonblank ~max_bytes:128)
             ++ F.required "changed_at_revision" (Api_codec.decimal ~max:Int.max_value))
            ~decode:
              (fun
                ( ( ((((((scope, key), revision), deleted), value), actor_id), run_id)
                  , timestamp )
                , sequence ) ->
              if Bool.equal deleted (Option.is_some value)
              then Json.fail Invalid_argument "deleted/value mismatch";
              { scope; key; revision; value; actor_id; run_id; timestamp; sequence })
            ~encode:
              (fun
                { scope; key; revision; value; actor_id; run_id; timestamp; sequence } ->
              ( ( ( (((((scope, key), revision), Option.is_none value), value), actor_id)
                  , run_id )
                , timestamp )
              , sequence ))))
      ~decode:(fun value ->
        if
          value.revision > 0
          && value.sequence > 0
          && not (Option.is_none value.value && value.revision = 1)
        then Ok value
        else Error (Problem.create Invalid_argument "invalid fact revision/deletion"))
      ~encode:Fn.id
      ~description:
        "Exact retained immutable fact value or tombstone, actor/run attribution and \
         planning source revision."
  ;;

  let sexp_of_t t = Sexp.Atom (Json.canonical (to_json t))

  let t_of_sexp sexp =
    unwrap (Result.bind (Json.parse (String.t_of_sexp sexp)) ~f:of_json)
  ;;

  let jsonaf_of_t = to_json
  let t_of_jsonaf json = unwrap (of_json json)
  let target t = Scope.target t.scope
  let scope t = t.scope
  let key t = t.key
  let revision t = t.revision
  let value t = t.value
  let actor t = t.actor_id
  let run t = t.run_id
  let sequence t = t.sequence
  let timestamp t = t.timestamp
end

module Address = struct
  module T = struct
    type t = Scope.t * string [@@deriving sexp_of, compare]
  end

  include T
  include Comparator.Make (T)
end

type t =
  { entries : Change.t list Map.M(Address).t
  ; retained_bytes : int
  }

let empty = { entries = Map.empty (module Address); retained_bytes = 2 }
let to_json t = `Array (Map.data t.entries |> List.concat |> List.map ~f:Change.to_json)

let apply t change =
  Result.bind
    (Change.of_json (Change.to_json change))
    ~f:(fun change ->
      let address = change.Change.scope, change.key in
      let previous = Option.value (Map.find t.entries address) ~default:[] in
      let revision =
        match previous with
        | [] -> 0
        | head :: _ -> head.Change.revision
      in
      if revision = Int.max_value || change.revision <> revision + 1
      then Error (Problem.create Corrupt_store "noncontiguous fact revision")
      else if List.is_empty previous && Option.is_none change.value
      then Error (Problem.create Corrupt_store "deletion requires existing key")
      else if
        Option.is_none change.value
        &&
        match previous with
        | head :: _ -> Option.is_none head.Change.value
        | [] -> false
      then Error (Problem.create Corrupt_store "fact already deleted")
      else if
        match previous with
        | head :: _ -> head.Change.sequence > change.sequence
        | [] -> false
      then Error (Problem.create Corrupt_store "fact sequence must not decrease")
      else (
        let entries = Map.set t.entries ~key:address ~data:(change :: previous) in
        let retained_bytes =
          t.retained_bytes
          + String.length (Json.canonical (Change.to_json change))
          + if Map.is_empty t.entries then 0 else 1
        in
        let next = { entries; retained_bytes } in
        if
          Map.length entries > Admission.Limit.maximum Fact_keys
          || retained_bytes > Admission.Limit.maximum Fact_version_bytes
        then Error (Problem.create Blocked "fact retained capacity exceeded")
        else Ok next))
;;

let prepare t command ~actor ~run ~timestamp ~sequence =
  let scope, key, expected_revision, value =
    match command with
    | Command.Put { scope; key; expected_revision; value } ->
      scope, key, expected_revision, Some value
    | Delete { scope; key; expected_revision } -> scope, key, expected_revision, None
  in
  let previous = Map.find t.entries (scope, key) in
  let current =
    match previous with
    | Some (head :: _) -> head.Change.revision
    | None | Some [] -> 0
  in
  if expected_revision <> current
  then Error (Problem.create Conflict "fact revision guard mismatch")
  else if
    Option.is_none value
    &&
    match previous with
    | Some (head :: _) -> Option.is_none head.Change.value
    | None | Some [] -> false
  then Error (Problem.create Conflict "fact already deleted")
  else if current = Int.max_value
  then Error (Problem.create Blocked "fact revision exhausted")
  else if current = 0 && Option.is_none value
  then Error (Problem.create Not_found "fact key does not exist")
  else (
    let change =
      { Change.scope
      ; key
      ; revision = current + 1
      ; value
      ; actor_id = actor
      ; run_id = run
      ; timestamp
      ; sequence
      }
    in
    Result.map (apply t change) ~f:(fun _ ->
      let receipt =
        match Change.to_json change with
        | `Object fields ->
          Json.obj
            (fields
             @ Option.to_list
                 (Option.map value ~f:(fun value ->
                    "value_type", Json.string (Value.type_name value))))
        | _ -> assert false
      in
      change, receipt))
;;

let validate_targets t ~exists =
  if Map.keys t.entries |> List.for_all ~f:(fun (scope, _) -> exists (Scope.target scope))
  then Ok ()
  else Error (Problem.create Corrupt_store "fact scope does not exist")
;;

let mutation_methods = [ "fact.put"; "fact.delete" ]

let query_methods =
  [ "fact.get"
  ; "fact.multi_get"
  ; "fact.list"
  ; "fact.keys"
  ; "fact.history"
  ; "fact.search"
  ]
;;

let current_json ?(metadata = false) change =
  match Change.to_json change with
  | `Object fields ->
    Json.obj
      (List.filter fields ~f:(fun (key, _) -> not (metadata && String.equal key "value"))
       @ Option.to_list
           (Option.map change.Change.value ~f:(fun value ->
              "value_type", Json.string (Value.type_name value))))
  | _ -> assert false
;;

let current t ~scope ~key =
  Option.bind (Map.find t.entries (scope, Key.to_string key)) ~f:List.hd
;;

let current_versions t ~scope ?prefix () =
  Map.to_alist t.entries
  |> List.filter_map ~f:(fun ((candidate, key), versions) ->
    if
      Scope.equal candidate scope
      && Option.for_all prefix ~f:(fun prefix -> String.is_prefix key ~prefix)
    then List.hd versions
    else None)
;;

let current_record change = current_json change

let keys t ~scope ~limit =
  let visible =
    Map.to_alist t.entries
    |> List.filter_map ~f:(fun ((candidate, _), versions) ->
      if Scope.equal candidate scope
      then
        Option.bind (List.hd versions) ~f:(fun head ->
          if Option.is_some head.Change.value then Some head else None)
      else None)
  in
  let selected = List.take visible (Int.max 0 (Int.min 100 limit)) in
  Json.obj
    [ "items", `Array (List.map selected ~f:(current_json ~metadata:true))
    ; "total", Json.int (List.length visible)
    ; "remaining", Json.int (List.length visible - List.length selected)
    ]
;;

let search_documents t =
  Map.data t.entries
  |> List.filter_map ~f:(function
    | [] -> None
    | head :: _ ->
      Option.map head.Change.value ~f:(fun value ->
        { Search.Document.source =
            Search.Source.Fact { scope = Scope.target head.scope; key = head.key }
        ; target = Scope.target head.scope
        ; revision = head.revision
        ; fields = [ "key", head.key; "value", Json.canonical value ]
        }))
;;

let readable_files t =
  Map.to_alist t.entries
  |> List.fold
       ~init:(Map.empty (module Scope))
       ~f:(fun groups ((scope, _), versions) ->
         Map.update groups scope ~f:(fun previous ->
           versions @ Option.value previous ~default:[]))
  |> Map.to_sequence
  |> Sequence.map ~f:(fun (scope, versions) ->
    let filename =
      match scope with
      | Scope.Workspace -> "facts/workspace.json"
      | Project id -> "facts/project-" ^ Id.Project.to_string id ^ ".json"
      | Milestone id -> "facts/milestone-" ^ Id.Milestone.to_string id ^ ".json"
      | Ticket id -> "facts/ticket-" ^ Id.Ticket.to_string id ^ ".json"
    in
    filename, Json.pretty (`Array (List.map versions ~f:Change.to_json)))
;;

module Query = struct
  type t =
    { scope : Scope.t
    ; key : Key.t option
    ; keys : Key.t list option
    ; text : string option
    ; limit : int option
    ; offset : int option
    ; at_revision : int option
    ; max_bytes : int option
    ; include_deleted : bool option
    ; prefix : string option
    }

  let validate request =
    if
      Option.exists request.limit ~f:(fun limit -> limit < 1)
      || Option.exists request.max_bytes ~f:(fun bytes -> bytes < 4096)
    then invalid "invalid fact query bounds"
    else if
      Option.value request.offset ~default:0 > 0 && Option.is_none request.at_revision
    then invalid "pagination requires at_revision"
    else if
      Option.exists request.text ~f:(fun text -> String.is_empty (String.strip text))
    then invalid "empty fact search"
    else Ok request
  ;;

  let structural_codec method_ =
    if not (List.mem query_methods method_ ~equal:String.equal)
    then invalid "unknown fact query"
    else
      let open Api_codec in
      let field_key =
        if List.mem [ "fact.get"; "fact.history" ] method_ ~equal:String.equal
        then
          Fields.map
            (Fields.required "key" Key.codec)
            ~decode:Option.some
            ~encode:(fun key -> Option.value_exn key)
        else Fields.map Fields.empty ~decode:(fun () -> None) ~encode:(fun _ -> ())
      in
      let field_keys =
        if String.equal method_ "fact.multi_get"
        then
          Fields.map
            (Fields.required "keys" (list Key.codec ~max_items:100))
            ~decode:Option.some
            ~encode:Option.value_exn
        else Fields.map Fields.empty ~decode:(fun () -> None) ~encode:(fun _ -> ())
      in
      let field_text =
        if String.equal method_ "fact.search"
        then
          Fields.map
            (Fields.required "text" (text ~max_bytes:256))
            ~decode:Option.some
            ~encode:Option.value_exn
        else Fields.map Fields.empty ~decode:(fun () -> None) ~encode:(fun _ -> ())
      in
      let base_fields =
        Fields.both
          (Fields.required "scope" Scope.codec)
          (Fields.both
             field_key
             (Fields.both
                field_keys
                (Fields.both
                   field_text
                   (Fields.both
                      (if String.equal method_ "fact.get"
                       then
                         Fields.map
                           Fields.empty
                           ~decode:(fun () -> None)
                           ~encode:(fun _ -> ())
                       else Fields.optional "limit" (decimal ~max:100))
                      (Fields.both
                         (if String.equal method_ "fact.get"
                          then
                            Fields.map
                              Fields.empty
                              ~decode:(fun () -> None)
                              ~encode:(fun _ -> ())
                          else Fields.optional "offset" (decimal ~max:Int.max_value))
                         (Fields.both
                            (Fields.optional "at_revision" (decimal ~max:Int.max_value))
                            (Fields.both
                               (Fields.optional "max_bytes" (decimal ~max:(1024 * 1024)))
                               (if
                                  List.mem
                                    [ "fact.list"; "fact.keys" ]
                                    method_
                                    ~equal:String.equal
                                then Fields.optional "include_deleted" boolean
                                else
                                  Fields.map
                                    Fields.empty
                                    ~decode:(fun () -> None)
                                    ~encode:(fun _ -> ())))))))))
      in
      let fields =
        Fields.both
          base_fields
          (if List.mem [ "fact.list"; "fact.keys" ] method_ ~equal:String.equal
           then Fields.optional "prefix" (text ~max_bytes:128)
           else Fields.map Fields.empty ~decode:(fun () -> None) ~encode:(fun _ -> ()))
      in
      Ok
        (object_
           (Fields.map
              fields
              ~decode:
                (fun
                  ( ( scope
                    , ( key
                      , ( keys
                        , ( text
                          , (limit, (offset, (at_revision, (max_bytes, include_deleted))))
                          ) ) ) )
                  , prefix ) ->
                { scope
                ; key
                ; keys
                ; text
                ; limit
                ; offset
                ; at_revision
                ; max_bytes
                ; include_deleted
                ; prefix
                })
              ~encode:
                (fun
                  { scope
                  ; key
                  ; keys
                  ; text
                  ; limit
                  ; offset
                  ; at_revision
                  ; max_bytes
                  ; include_deleted
                  ; prefix
                  } ->
                let base =
                  ( scope
                  , ( key
                    , ( keys
                      , ( text
                        , (limit, (offset, (at_revision, (max_bytes, include_deleted))))
                        ) ) ) )
                in
                base, prefix)))
  ;;

  let codec method_ =
    Result.map (structural_codec method_) ~f:(fun codec ->
      Api_codec.map
        codec
        ~decode:validate
        ~encode:Fn.id
        ~description:
          "Limit is 1..100; max_bytes is 4096..1048576; offset>0 requires at_revision; \
           search text is nonblank.")
  ;;
end

let query_codec = Query.codec

let query t ~workspace_revision ~method_ ~params =
  Result.bind (Query.codec method_) ~f:(fun codec ->
    Result.bind (Api_codec.decode codec params) ~f:(fun request ->
      Json.decode (fun () ->
        let limit = Option.value request.limit ~default:50 in
        let offset = Option.value request.offset ~default:0 in
        let max_bytes = Option.value request.max_bytes ~default:65536 in
        Option.iter request.at_revision ~f:(fun revision ->
          if revision <> workspace_revision
          then Json.fail Conflict "workspace revision changed");
        let histories =
          Map.to_alist t.entries
          |> List.filter_map ~f:(fun ((scope, key), versions) ->
            if
              Scope.equal scope request.scope
              && Option.for_all request.prefix ~f:(fun prefix ->
                String.is_prefix key ~prefix)
            then Some (key, versions)
            else None)
        in
        let find key =
          Option.bind (List.Assoc.find histories key ~equal:Key.equal) ~f:List.hd
        in
        let include_deleted = Option.value request.include_deleted ~default:false in
        let visible head = include_deleted || Option.is_some head.Change.value in
        let items =
          match method_ with
          | "fact.get" ->
            let key = Option.value_exn request.key in
            (match find key with
             | Some head -> [ current_json head ]
             | None -> Json.fail Not_found "fact key does not exist")
          | "fact.multi_get" ->
            List.map (Option.value_exn request.keys) ~f:(fun key ->
              match find key with
              | Some head -> current_json head
              | None ->
                Json.obj
                  [ "scope", unwrap (Api_codec.encode Scope.codec request.scope)
                  ; "key", Json.string key
                  ; "missing", `True
                  ])
          | "fact.history" ->
            (match
               List.Assoc.find histories (Option.value_exn request.key) ~equal:Key.equal
             with
             | None -> Json.fail Not_found "fact key does not exist"
             | Some versions -> List.rev_map versions ~f:current_json)
          | "fact.list" | "fact.keys" ->
            List.filter_map histories ~f:(fun (_, versions) ->
              Option.bind (List.hd versions) ~f:(fun head ->
                if visible head
                then Some (current_json ~metadata:(String.equal method_ "fact.keys") head)
                else None))
          | "fact.search" ->
            let text = Option.value_exn request.text in
            let documents =
              search_documents t
              |> List.filter ~f:(fun doc ->
                Entity_ref.equal doc.Search.Document.target (Scope.target request.scope))
            in
            List.concat_map documents ~f:(fun document ->
              (Search.matches [ document ] ~text ~kinds:None ~offset:0 ~limit:1).items)
          | _ -> Json.fail Invalid_argument "unknown fact query"
        in
        let total = List.length items in
        let selected = List.take (List.drop items offset) limit in
        let response selected bytes =
          let count = List.length selected in
          let remaining = Int.max 0 (total - offset - count) in
          let omitted = List.length (List.take (List.drop items offset) limit) - count in
          let data =
            if String.equal method_ "fact.get"
            then (
              match selected with
              | [ item ] -> item
              | [] -> `Null
              | _ -> assert false)
            else
              Json.obj
                [ "items", `Array selected
                ; "offset", Json.int offset
                ; "remaining", Json.int remaining
                ; ( "next_offset"
                  , if remaining > 0 then Json.int (offset + count) else `Null )
                ]
          in
          Json.obj
            [ "data", data
            ; "workspace_revision", Json.int workspace_revision
            ; ( "budget"
              , Json.obj
                  [ "max_bytes", Json.int max_bytes
                  ; "returned_bytes", Json.int bytes
                  ; ("truncated", if omitted > 0 then `True else `False)
                  ; "omitted_fields", Json.int 0
                  ; "omitted_items", Json.int omitted
                  ; "details", `Array []
                  ; ("details_complete", if omitted = 0 then `True else `False)
                  ] )
            ]
        in
        let sized selected =
          let rec loop bytes =
            let result = response selected bytes in
            let actual = Api_response.encoded_size Planning_read result in
            if actual = bytes then result, actual else loop actual
          in
          loop 0
        in
        let rec fit selected =
          let result, bytes = sized selected in
          if bytes <= max_bytes
          then result
          else (
            match List.rev selected with
            | [] -> Json.fail Invalid_argument "fact query budget cannot fit metadata"
            | _ :: rest -> fit (List.rev rest))
        in
        let result = fit selected in
        let returned =
          if String.equal method_ "fact.get"
          then (
            match Json.field result "data" with
            | `Null -> []
            | item -> [ item ])
          else Json.list (Json.field (Json.field result "data") "items")
        in
        if (not (List.is_empty selected)) && List.is_empty returned
        then Json.fail Invalid_argument "no fact item fits budget; increase max_bytes";
        result)))
;;

module Response = struct
  let json_codec codec =
    Api_codec.map
      codec
      ~decode:(Api_codec.encode codec)
      ~encode:(fun json -> unwrap (Api_codec.decode codec json))
      ~description:"Validated JSON projection"
  ;;

  let required name codec =
    Api_codec.Fields.map
      (Api_codec.Fields.required name (json_codec codec))
      ~decode:(fun value -> [ name, value ])
      ~encode:(fun fields -> List.Assoc.find_exn fields name ~equal:String.equal)
  ;;

  let optional name codec =
    Api_codec.Fields.map
      (Api_codec.Fields.optional name (json_codec codec))
      ~decode:(fun value ->
        Option.to_list (Option.map value ~f:(fun value -> name, value)))
      ~encode:(fun fields -> List.Assoc.find fields name ~equal:String.equal)
  ;;

  let object_fields fields =
    let combined =
      List.fold
        fields
        ~init:
          (Api_codec.Fields.map
             Api_codec.Fields.empty
             ~decode:(fun () -> [])
             ~encode:(fun _ -> ()))
        ~f:(fun accumulated field ->
          let names = Api_codec.Fields.names field in
          Api_codec.Fields.map
            (Api_codec.Fields.both accumulated field)
            ~decode:(fun (a, b) -> a @ b)
            ~encode:(fun values ->
              ( List.filter values ~f:(fun (name, _) ->
                  not (List.mem names name ~equal:String.equal))
              , List.filter values ~f:(fun (name, _) ->
                  List.mem names name ~equal:String.equal) )))
    in
    Api_codec.object_
      (Api_codec.Fields.map combined ~decode:Json.obj ~encode:(function
         | `Object fields -> fields
         | _ -> Json.fail Invalid_argument "response must be object"))
  ;;

  let count = Api_codec.decimal ~max:Int.max_value

  let value_type =
    Api_codec.enum
      (List.map
         [ "null"; "boolean"; "number"; "string"; "array"; "object" ]
         ~f:(fun value -> value, value))
      ~equal:String.equal
  ;;

  let record ~metadata ~missing =
    let field = if missing then optional else required in
    let fields =
      [ required "scope" Scope.codec
      ; required "key" Key.codec
      ; field "revision" count
      ; field "deleted" Api_codec.boolean
      ; field "actor_id" (id_codec Id.Actor.of_string Id.Actor.to_string)
      ; optional "run_id" (id_codec Id.Run.of_string Id.Run.to_string)
      ; field "timestamp" (Api_codec.text ~max_bytes:128)
      ; field "changed_at_revision" count
      ; optional "value_type" value_type
      ]
      @ (if metadata then [] else [ optional "value" Value.codec ])
      @ if missing then [ optional "missing" Api_codec.boolean ] else []
    in
    Api_codec.map
      (object_fields fields)
      ~encode:Fn.id
      ~description:
        "Attributed current fact or retained tombstone; JSON null is a present value. \
         Multi-get may instead return an explicit missing key."
      ~decode:(fun json ->
        Json.decode (fun () ->
          match Json.optional json "missing" with
          | Some `True ->
            Json.fields json ~allowed:[ "scope"; "key"; "missing" ];
            json
          | Some `False
          | Some `Null
          | Some (`String _)
          | Some (`Number _)
          | Some (`Array _)
          | Some (`Object _) -> Json.fail Invalid_argument "missing marker must be true"
          | None ->
            let deleted =
              unwrap (Api_codec.decode Api_codec.boolean (Json.field json "deleted"))
            in
            let revision = Json.integer (Json.field json "revision") in
            let sequence = Json.integer (Json.field json "changed_at_revision") in
            if revision < 1 || sequence < 1 || (deleted && revision = 1)
            then Json.fail Invalid_argument "invalid fact response revision";
            ignore (Json.field json "actor_id" : Jsonaf.t);
            if String.is_empty (Json.text (Json.field json "timestamp"))
            then Json.fail Invalid_argument "empty fact response timestamp";
            let value = Json.optional json "value" in
            let type_ = Json.optional json "value_type" in
            if deleted
            then (
              if Option.is_some value || Option.is_some type_
              then Json.fail Invalid_argument "deleted fact cannot carry a value")
            else if metadata
            then ignore (Json.field json "value_type" : Jsonaf.t)
            else (
              let value = Json.field json "value" in
              let type_ = Json.text (Json.field json "value_type") in
              if not (String.equal type_ (Value.type_name value))
              then Json.fail Invalid_argument "fact value type mismatch");
            json))
  ;;

  let source =
    object_fields
      [ required "kind" (Api_codec.enum [ "fact", () ] ~equal:Unit.equal)
      ; required "scope" Scope.codec
      ; required "key" Key.codec
      ; required "revision" count
      ]
  ;;

  let match_ =
    object_fields
      [ required
          "field"
          (Api_codec.enum [ "key", "key"; "value", "value" ] ~equal:String.equal)
      ; required "match_offset" count
      ; required "match_bytes" count
      ; required "snippet_offset" count
      ; required "snippet" (Api_codec.text ~max_bytes:512)
      ]
  ;;

  let search_item =
    object_fields
      [ required "source" source
      ; required "target" Scope.codec
      ; required "matches" (Api_codec.list match_ ~max_items:2)
      ]
  ;;

  let page item =
    object_fields
      [ required "items" (Api_codec.list item ~max_items:100)
      ; required "offset" count
      ; required "remaining" count
      ; required "next_offset" (Api_codec.nullable count)
      ]
  ;;

  let codec method_ =
    match method_ with
    | "fact.put" | "fact.delete" | "fact.get" ->
      Ok (record ~metadata:false ~missing:false)
    | "fact.keys" -> Ok (page (record ~metadata:true ~missing:false))
    | "fact.multi_get" -> Ok (page (record ~metadata:false ~missing:true))
    | "fact.list" | "fact.history" -> Ok (page (record ~metadata:false ~missing:false))
    | "fact.search" -> Ok (page search_item)
    | _ -> invalid "unknown fact method"
  ;;
end

let key_metadata_codec = Response.record ~metadata:true ~missing:false
let response_codec = Response.codec

let request_schema method_ =
  if List.mem mutation_methods method_ ~equal:String.equal
  then Result.map (Command.codec method_) ~f:Api_codec.schema
  else Result.map (Query.codec method_) ~f:Api_codec.schema
;;

let response_schema method_ = Result.map (Response.codec method_) ~f:Api_codec.schema

let admission t =
  let checked = function
    | Ok x -> x
    | Error e -> raise (Json.Decode_error e)
  in
  [ checked (Admission.create Fact_keys ~used:(Map.length t.entries))
  ; checked (Admission.create Fact_version_bytes ~used:t.retained_bytes)
  ]
;;
