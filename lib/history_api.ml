open Core
module Fields = Api_codec.Fields

let ( ++ ) = Fields.both

let unwrap = function
  | Ok value -> value
  | Error problem -> raise (Json.Decode_error problem)
;;

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Resolved local identity."
;;

let session_id = id Session_id.of_string Session_id.to_string
let decimal = Api_codec.decimal ~max:Int.max_value

let bounded ~min ~max description =
  Api_codec.map
    (Api_codec.decimal ~max)
    ~decode:(fun value ->
      if value < min
      then Error (Problem.create Invalid_argument description)
      else Ok value)
    ~encode:Fn.id
    ~description
;;

let limit = bounded ~min:1 ~max:100 "limit requires 1..100"
let budget = bounded ~min:4096 ~max:(1024 * 1024) "history budget requires 4KiB..1MiB"

let title =
  Api_codec.map
    (Api_codec.text ~max_bytes:512)
    ~decode:(fun value ->
      if String.is_empty value
      then Error (Problem.create Invalid_argument "session title must not be empty")
      else Ok value)
    ~encode:Fn.id
    ~description:"Nonempty session title."
;;

let scopes =
  Api_codec.map
    (Api_codec.list History_wire.scope ~max_items:100)
    ~decode:(fun scopes ->
      if List.contains_dup scopes ~compare:Entity_ref.compare
      then Error (Problem.create Invalid_argument "duplicate session scope")
      else Ok scopes)
    ~encode:Fn.id
    ~description:"At most 100 distinct resolved local scopes."
;;

let inputs =
  Api_codec.map
    (Api_codec.list History_wire.input ~max_items:128)
    ~decode:(fun inputs ->
      let bytes =
        List.sum
          (module Int)
          inputs
          ~f:(fun input ->
            List.sum
              (module Int)
              (Session_event.Input.contents input)
              ~f:(function
                | Session_event.Content.Inline bytes -> String.length bytes
                | Blob _ -> 0))
      in
      if List.is_empty inputs
      then Error (Problem.create Invalid_argument "append requires 1..128 events")
      else if bytes > 16 * 1024 * 1024
      then Error (Problem.create Invalid_argument "append inline bytes exceed 16MiB")
      else Ok inputs)
    ~encode:Fn.id
    ~description:"1..128 adapter events with at most 16MiB total inline bytes."
;;

module Command = struct
  type t =
    | Create of
        { id : Session_id.t
        ; title : string
        ; parent : Session.Event_ref.t option
        ; scopes : Entity_ref.t list
        }
    | Archive of Session_id.t
    | Append of
        { session : Session_id.t
        ; inputs : Session_event.Input.t list
        }

  let entries =
    [ ( "session.create"
      , Api_codec.map
          (Api_codec.object_
             (Fields.required "session_id" session_id
              ++ Fields.required "title" title
              ++ Fields.optional "parent_event" History_wire.event_ref
              ++ Fields.optional "scopes" scopes))
          ~decode:(fun (((id, title), parent), scopes) ->
            Ok (Create { id; title; parent; scopes = Option.value scopes ~default:[] }))
          ~encode:(function
            | Create { id; title; parent; scopes } -> ((id, title), parent), Some scopes
            | _ -> Json.fail Invalid_argument "wrong history command")
          ~description:
            "Create immutable session metadata; parent event must already be committed." )
    ; ( "session.archive"
      , Api_codec.map
          (Api_codec.object_ (Fields.required "session_id" session_id))
          ~decode:(fun id -> Ok (Archive id))
          ~encode:(function
            | Archive id -> id
            | _ -> Json.fail Invalid_argument "wrong history command")
          ~description:"Archive a session; preserve metadata and payload access." )
    ; ( "session.append"
      , Api_codec.map
          (Api_codec.object_
             (Fields.required "session_id" session_id ++ Fields.required "events" inputs))
          ~decode:(fun (session, inputs) -> Ok (Append { session; inputs }))
          ~encode:(function
            | Append { session; inputs } -> session, inputs
            | _ -> Json.fail Invalid_argument "wrong history command")
          ~description:
            "Atomically append preserved adapter events to the independent journal." )
    ]
  ;;

  let decode ~method_ ~params =
    match List.Assoc.find entries method_ ~equal:String.equal with
    | None -> Error (Problem.create Invalid_argument "unknown history mutation")
    | Some codec -> Api_codec.decode codec params
  ;;

  let encode command =
    let name =
      match command with
      | Create _ -> "session.create"
      | Archive _ -> "session.archive"
      | Append _ -> "session.append"
    in
    let codec = List.Assoc.find_exn entries name ~equal:String.equal in
    Result.map (Api_codec.encode codec command) ~f:(fun params -> name, params)
  ;;
end

module Query = struct
  module Part = struct
    type t =
      | Payload
      | Searchable_text
      | Attachment of int

    let codec =
      let unit_branch name value =
        Api_codec.map
          (Api_codec.object_ (Fields.required "kind" (Api_codec.literal name)))
          ~decode:(fun () -> Ok value)
          ~encode:(fun _ -> ())
          ~description:("Retrieve complete bytes of " ^ name)
      in
      let attachment =
        Api_codec.map
          (Api_codec.object_
             (Fields.required "kind" (Api_codec.literal "attachment")
              ++ Fields.required "index" (Api_codec.decimal ~max:99)))
          ~decode:(fun ((), index) -> Ok (Attachment index))
          ~encode:(function
            | Attachment index -> (), index
            | _ -> Json.fail Invalid_argument "wrong payload part")
          ~description:"Zero-based attachment index."
      in
      Api_codec.tagged
        ~discriminator:"kind"
        ~cases:
          [ "payload", unit_branch "payload" Payload
          ; "searchable_text", unit_branch "searchable_text" Searchable_text
          ; "attachment", attachment
          ]
        ~select:(function
          | Payload -> "payload"
          | Searchable_text -> "searchable_text"
          | Attachment _ -> "attachment")
    ;;
  end

  type t =
    | Session_get of Session_id.t
    | Session_list of
        { offset : int
        ; limit : int
        ; include_archived : bool
        }
    | Get of Session.Event_ref.t
    | Read of
        { session : Session_id.t
        ; anchor : int
        ; direction : History_query.direction
        ; limit : int
        }
    | Search of
        { text : string
        ; session : Session_id.t option
        ; kinds : string list option
        ; after : Session.Event_ref.t option
        ; limit : int
        }
    | Payload of
        { event : Session.Event_ref.t
        ; part : Part.t
        ; offset : int
        ; length : int
        }

  type request =
    { query : t
    ; max_bytes : int
    ; head : string option option
    }

  let direction =
    Api_codec.enum
      [ "before", History_query.Before; "after", After; "around", Around ]
      ~equal:History_query.equal_direction
  ;;

  let search_text =
    Api_codec.map
      (Api_codec.text ~max_bytes:256)
      ~decode:(fun text ->
        if String.is_empty text
        then Error (Problem.create Invalid_argument "search text must not be empty")
        else Ok text)
      ~encode:Fn.id
      ~description:"Nonempty UTF-8 lexical search text."
  ;;

  let digest =
    Api_codec.map
      (Api_codec.text ~max_bytes:64)
      ~decode:(fun digest ->
        Result.map (Session_event.Blob_ref.create ~digest ~size_bytes:0) ~f:(fun _ ->
          digest))
      ~encode:Fn.id
      ~description:"Lowercase SHA-256 journal head digest."
  ;;

  let common =
    Api_codec.object_
      (Fields.optional "max_bytes" budget
       ++ Fields.optional "head" (Api_codec.nullable digest))
  ;;

  let wrap codec =
    Api_codec.map
      (Api_codec.merge_objects common codec)
      ~decode:(fun ((max_bytes, head), query) ->
        Ok { query; max_bytes = Option.value max_bytes ~default:65536; head })
      ~encode:(fun { query; max_bytes; head } -> (Some max_bytes, head), query)
      ~description:
        "Immutable capture query; head omission selects current, null selects empty; \
         budgets fit complete records."
  ;;

  let entries =
    List.map
      [ ( "session.get"
        , Api_codec.map
            (Api_codec.object_ (Fields.required "session_id" session_id))
            ~decode:(fun id -> Ok (Session_get id))
            ~encode:(function
              | Session_get id -> id
              | _ -> Json.fail Invalid_argument "wrong history query")
            ~description:"Get captured session metadata." )
      ; ( "session.list"
        , Api_codec.map
            (Api_codec.object_
               (Fields.optional "offset" decimal
                ++ Fields.optional "limit" limit
                ++ Fields.optional "include_archived" Api_codec.boolean))
            ~decode:(fun ((offset, limit), include_archived) ->
              Ok
                (Session_list
                   { offset = Option.value offset ~default:0
                   ; limit = Option.value limit ~default:50
                   ; include_archived = Option.value include_archived ~default:false
                   }))
            ~encode:(function
              | Session_list { offset; limit; include_archived } ->
                (Some offset, Some limit), Some include_archived
              | _ -> Json.fail Invalid_argument "wrong history query")
            ~description:"Page complete captured session records." )
      ; ( "history.get"
        , Api_codec.map
            (Api_codec.object_ (Fields.required "event_ref" History_wire.event_ref))
            ~decode:(fun ref_ -> Ok (Get ref_))
            ~encode:(function
              | Get ref_ -> ref_
              | _ -> Json.fail Invalid_argument "wrong history query")
            ~description:
              "Get committed event metadata; opaque payload is retrieved separately." )
      ; ( "history.read"
        , Api_codec.map
            (Api_codec.object_
               (Fields.required "session_id" session_id
                ++ Fields.optional "anchor" (Api_codec.decimal ~max:1_000_000)
                ++ Fields.required "direction" direction
                ++ Fields.optional "limit" limit))
            ~decode:(fun (((session, anchor), direction), limit) ->
              Ok
                (Read
                   { session
                   ; anchor = Option.value anchor ~default:0
                   ; direction
                   ; limit = Option.value limit ~default:50
                   }))
            ~encode:(function
              | Read { session; anchor; direction; limit } ->
                ((session, Some anchor), direction), Some limit
              | _ -> Json.fail Invalid_argument "wrong history query")
            ~description:
              "Read complete captured event metadata before/after/around sequence anchor."
        )
      ; ( "history.search"
        , Api_codec.map
            (Api_codec.object_
               (Fields.required "text" search_text
                ++ Fields.optional "session_id" session_id
                ++ Fields.optional
                     "kinds"
                     (Api_codec.list (Api_codec.text ~max_bytes:256) ~max_items:100)
                ++ Fields.optional "after_event" History_wire.event_ref
                ++ Fields.optional "limit" limit))
            ~decode:(fun ((((text, session), kinds), after), limit) ->
              Ok
                (Search
                   { text; session; kinds; after; limit = Option.value limit ~default:50 }))
            ~encode:(function
              | Search { text; session; kinds; after; limit } ->
                (((text, session), kinds), after), Some limit
              | _ -> Json.fail Invalid_argument "wrong history query")
            ~description:"Search complete indexed adapter text at an immutable capture." )
      ; ( "history.payload"
        , Api_codec.map
            (Api_codec.object_
               (Fields.required "event_ref" History_wire.event_ref
                ++ Fields.optional "part" Part.codec
                ++ Fields.optional "offset" decimal
                ++ Fields.optional "length" (Api_codec.decimal ~max:262_144)))
            ~decode:(fun (((event, part), offset), length) ->
              Ok
                (Payload
                   { event
                   ; part = Option.value part ~default:Part.Payload
                   ; offset = Option.value offset ~default:0
                   ; length = Option.value length ~default:32768
                   }))
            ~encode:(function
              | Payload { event; part; offset; length } ->
                ((event, Some part), Some offset), Some length
              | _ -> Json.fail Invalid_argument "wrong history query")
            ~description:
              "Read bounded exact blob bytes; continue at next_offset for the complete \
               payload." )
      ]
      ~f:(fun (name, codec) -> name, wrap codec)
  ;;

  let decode ~method_ ~params =
    match List.Assoc.find entries method_ ~equal:String.equal with
    | None -> Error (Problem.create Invalid_argument "unknown history query")
    | Some codec -> Api_codec.decode codec params
  ;;
end

let mutation_methods = List.map Command.entries ~f:fst
let query_methods = List.map Query.entries ~f:fst

let request_codec ~method_ =
  match List.Assoc.find Command.entries method_ ~equal:String.equal with
  | Some codec -> Some (Api_codec.as_json codec)
  | None ->
    Option.map
      (List.Assoc.find Query.entries method_ ~equal:String.equal)
      ~f:Api_codec.as_json
;;

let field name codec =
  Fields.map
    (Fields.required name codec)
    ~decode:(fun value -> [ name, unwrap (Api_codec.encode codec value) ])
    ~encode:(fun fields ->
      unwrap (Api_codec.decode codec (Json.field (`Object fields) name)))
;;

let record fields =
  let fields =
    List.fold
      fields
      ~init:(Fields.map Fields.empty ~decode:(fun () -> []) ~encode:(fun _ -> ()))
      ~f:(fun previous next ->
        Fields.map
          (previous ++ next)
          ~decode:(fun (left, right) -> left @ right)
          ~encode:(fun fields -> fields, fields))
  in
  Api_codec.map
    (Api_codec.object_ fields)
    ~decode:(fun fields -> Ok (`Object fields))
    ~encode:(function
      | `Object fields -> fields
      | _ -> Json.fail Invalid_argument "expected history result object")
    ~description:"Exact public history response data."
;;

let bool = Api_codec.boolean
let events = Api_codec.list History_wire.event ~max_items:100

let coverage =
  record
    [ field "session_id" session_id
    ; field "committed_through" decimal
    ; field "indexed_through" decimal
    ]
;;

let hit =
  record
    [ field "event_ref" History_wire.event_ref
    ; field "kind" (Api_codec.text ~max_bytes:256)
    ; field "role" (Api_codec.text ~max_bytes:256)
    ; field "byte_offset" decimal
    ; field "snippet" (Api_codec.text ~max_bytes:512)
    ]
;;

let payload_result =
  Api_codec.map
    (record
       [ field "blob" History_wire.blob_ref
       ; field "offset" decimal
       ; field "bytes_base64" (Api_codec.text ~max_bytes:349528)
       ; field "next_offset" decimal
       ; field "total_bytes" (Api_codec.decimal ~max:(64 * 1024 * 1024))
       ; field "has_more" bool
       ])
    ~decode:(fun result ->
      match Base64.decode (Json.text (Json.field result "bytes_base64")) with
      | Error (`Msg message) -> Error (Problem.create Invalid_argument message)
      | Ok bytes ->
        let offset = Json.integer (Json.field result "offset") in
        let next = Json.integer (Json.field result "next_offset") in
        let total = Json.integer (Json.field result "total_bytes") in
        let blob =
          unwrap (Api_codec.decode History_wire.blob_ref (Json.field result "blob"))
        in
        let has_more =
          match Json.field result "has_more" with
          | `True -> true
          | _ -> false
        in
        if
          String.length bytes > 262_144
          || offset > total
          || next > total
          || next - offset <> String.length bytes
          || total <> blob.size_bytes
          || not (Bool.equal has_more (next < total))
        then
          Error
            (Problem.create
               Invalid_argument
               "inconsistent history payload cursor or byte length")
        else Ok result)
    ~encode:Fn.id
    ~description:
      "Exact bounded base64 bytes; offsets, EOF and total size agree with the immutable \
       blob."
;;

let responses =
  [ ( "session.create"
    , record [ field "session" History_wire.session; field "through" decimal ] )
  ; "session.archive", record [ field "session" History_wire.session ]
  ; ( "session.append"
    , record
        [ field "session_id" session_id
        ; field "through" decimal
        ; field "events" (Api_codec.list History_wire.event_ref ~max_items:128)
        ] )
  ; ( "session.get"
    , record [ field "session" History_wire.session; field "through" decimal ] )
  ; ( "session.list"
    , record
        [ field "items" (Api_codec.list History_wire.session ~max_items:100)
        ; field "next_offset" decimal
        ; field "has_more" bool
        ] )
  ; "history.get", Api_codec.as_json History_wire.event
  ; ( "history.read"
    , record
        [ field "session_id" session_id
        ; field "through" decimal
        ; field "items" events
        ; field "has_more" bool
        ; field "next_anchor" decimal
        ; field "omitted_for_budget" decimal
        ] )
  ; ( "history.search"
    , record
        [ field "items" (Api_codec.list hit ~max_items:100)
        ; field "next" (Api_codec.nullable History_wire.event_ref)
        ; field "restart_after_indexing" bool
        ; field "has_more" bool
        ; field "coverage" (Api_codec.list coverage ~max_items:1_000_000)
        ; field "complete" bool
        ; field "unindexed_events" decimal
        ; field "unsearchable_events" decimal
        ; field "omitted_for_budget" decimal
        ] )
  ; "history.payload", payload_result
  ]
;;

let response_codec ~method_ = List.Assoc.find responses method_ ~equal:String.equal

let methods =
  List.map (mutation_methods @ query_methods) ~f:(fun name ->
    Api_method.Packed.Pack
      (Api_method.create
         ~name
         ~summary:("Independent captured conversation history: " ^ name)
         ~mode:
           (if List.mem mutation_methods name ~equal:String.equal then Mutation else Read)
         ~request:(Option.value_exn (request_codec ~method_:name))
         ~response:(Option.value_exn (response_codec ~method_:name))))
;;

let validate_result ~method_ result =
  let data = Api_response.project History result |> Api_response.data in
  match
    List.find methods ~f:(fun (Api_method.Packed.Pack descriptor) ->
      String.equal (Api_method.name descriptor) method_)
  with
  | None -> invalid_arg "unknown history response method"
  | Some (Api_method.Packed.Pack descriptor) ->
    (match Api_codec.decode (Api_method.response_codec descriptor) data with
     | Ok _ -> ()
     | Error problem -> raise (Api_method.Invalid_response (method_, problem)))
;;

let mutation_result ~method_ result =
  let result =
    match method_, result with
    | ("session.create" | "session.archive"), `Object fields ->
      let metadata =
        match Session.of_json (Json.field result "session") with
        | Ok metadata -> metadata
        | Error problem -> raise (Api_method.Invalid_response (method_, problem))
      in
      Json.obj
        (List.Assoc.add
           fields
           ~equal:String.equal
           "session"
           (History_wire.session_json metadata))
    | _ -> result
  in
  validate_result ~method_ result;
  result
;;
