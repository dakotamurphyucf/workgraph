open Core
module Event = Communication_event
module Fields = Api_codec.Fields

let ( ++ ) = Fields.both

let unwrap = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Resolved local identity; aliases are not accepted."
;;

let board_id = id Communication_id.Board.of_string Communication_id.Board.to_string
let thread_id = id Communication_id.Thread.of_string Communication_id.Thread.to_string
let team_id = id Communication_id.Team.of_string Communication_id.Team.to_string
let request_id = id Communication_id.Request.of_string Communication_id.Request.to_string

let subscription_id =
  id Communication_id.Subscription.of_string Communication_id.Subscription.to_string
;;

let actor_id = id Id.Actor.of_string Id.Actor.to_string
let run_id = id Id.Run.of_string Id.Run.to_string
let comment_id = id Id.Comment.of_string Id.Comment.to_string
let project_id = id Id.Project.of_string Id.Project.to_string
let decimal = Api_codec.decimal ~max:Int.max_value

let positive =
  Api_codec.map
    decimal
    ~decode:(fun value ->
      if value > 0
      then Ok value
      else
        Error (Problem.create Invalid_argument "communication revision must be positive"))
    ~encode:Fn.id
    ~description:"Positive entity revision or activity serial."
;;

let timestamp =
  Api_codec.map
    (Api_codec.text ~max_bytes:128)
    ~decode:(fun value ->
      if String.is_empty value
      then Error (Problem.create Invalid_argument "timestamp is empty")
      else Ok value)
    ~encode:Fn.id
    ~description:"Nonempty attribution timestamp, at most 128 UTF-8 bytes."
;;

let field name codec =
  Fields.map
    (Fields.required name codec)
    ~decode:(fun value -> [ name, unwrap (Api_codec.encode codec value) ])
    ~encode:(fun fields ->
      unwrap (Api_codec.decode codec (Json.field (`Object fields) name)))
;;

let optional name codec =
  Fields.map
    (Fields.optional name codec)
    ~decode:(fun value ->
      Option.to_list
        (Option.map value ~f:(fun value -> name, unwrap (Api_codec.encode codec value))))
    ~encode:(fun fields ->
      Option.map
        (Json.optional (`Object fields) name)
        ~f:(fun value -> unwrap (Api_codec.decode codec value)))
;;

let record fields =
  List.fold
    fields
    ~init:(Fields.map Fields.empty ~decode:(fun () -> []) ~encode:(fun _ -> ()))
    ~f:(fun acc field ->
      Fields.map
        (acc ++ field)
        ~decode:(fun (a, b) -> a @ b)
        ~encode:(fun fields -> fields, fields))
  |> Api_codec.object_
  |> Api_codec.map
       ~decode:(fun fields -> Ok (`Object fields))
       ~encode:(function
         | `Object fields -> fields
         | _ -> Json.fail Invalid_argument "expected communication record")
       ~description:
         "Exact public communication record; bounded views disclose omissions separately."
;;

let tagged cases =
  Api_codec.tagged ~discriminator:"kind" ~cases ~select:(fun value ->
    Json.text (Json.field value "kind"))
;;

let target =
  Api_codec.map
    Planning_target.codec
    ~decode:Planning_target.to_ref
    ~encode:Planning_target.of_ref
    ~description:"Resolved tagged entity link."
;;

let scope =
  let workspace =
    Api_codec.map
      (Api_codec.object_ (Fields.required "kind" (Api_codec.literal "workspace")))
      ~decode:(fun () -> Ok Event.Scope.Workspace)
      ~encode:(function
        | Event.Scope.Workspace -> ()
        | Project _ -> Json.fail Invalid_argument "wrong scope")
      ~description:"Workspace scope."
  in
  let project =
    Api_codec.map
      (Api_codec.object_
         (Fields.required "kind" (Api_codec.literal "project")
          ++ Fields.required "id" project_id))
      ~decode:(fun ((), id) -> Ok (Event.Scope.Project id))
      ~encode:(function
        | Event.Scope.Project id -> (), id
        | Workspace -> Json.fail Invalid_argument "wrong scope")
      ~description:"Project scope."
  in
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:[ "workspace", workspace; "project", project ]
    ~select:(function
      | Event.Scope.Workspace -> "workspace"
      | Project _ -> "project")
;;

let kind =
  Api_codec.enum
    [ "thread_changed", Event.Notification.Kind.Thread_changed
    ; "message_received", Message_received
    ; "request_created", Request_created
    ; "request_acknowledged", Request_acknowledged
    ; "request_accepted", Request_accepted
    ; "request_reassigned", Request_reassigned
    ; "request_resolved", Request_resolved
    ; "request_cancelled", Request_cancelled
    ]
    ~equal:Event.Notification.Kind.equal
;;

let thread_state =
  Api_codec.enum
    [ "open", Event.Thread.State.Open
    ; "awaiting_response", Awaiting_response
    ; "resolved", Resolved
    ]
    ~equal:Event.Thread.State.equal
;;

let request_kind =
  Api_codec.enum
    [ "clarification", Event.Request.Kind.Clarification
    ; "review", Review
    ; "help", Help
    ; "blocker_resolution", Blocker_resolution
    ; "handoff", Handoff
    ]
    ~equal:Event.Request.Kind.equal
;;

let attribution =
  Api_codec.map
    (Api_codec.object_
       (Fields.required "actor_id" actor_id
        ++ Fields.required "run_id" (Api_codec.nullable run_id)
        ++ Fields.required "timestamp" timestamp))
    ~decode:(fun ((actor, run), timestamp) ->
      Ok { Event.Attribution.actor; run; timestamp })
    ~encode:(fun ({ actor; run; timestamp } : Event.Attribution.t) ->
      (actor, run), timestamp)
    ~description:"Preserved actor/run attribution and declared timestamp."
;;

let correlation =
  Api_codec.map
    (Api_codec.text ~max_bytes:128)
    ~decode:(fun value ->
      if String.is_empty value
      then Error (Problem.create Invalid_argument "empty correlation ID")
      else Ok value)
    ~encode:Fn.id
    ~description:"Nonempty correlation string, at most 128 UTF-8 bytes."
;;

let unix_ms =
  Api_codec.map
    (Api_codec.decimal64 ~max:Int64.max_value)
    ~decode:(fun value -> Ok (Int64.to_string value))
    ~encode:(fun value -> Json.integer64 (Json.string value))
    ~description:"Canonical nonnegative Unix milliseconds within signed int64."
;;

let filter_input =
  Api_codec.map
    (Api_codec.object_
       (Fields.optional "scope" scope
        ++ Fields.optional "thread_id" thread_id
        ++ Fields.optional "kinds" (Api_codec.list kind ~max_items:8)))
    ~decode:(fun ((scope, thread), kinds) ->
      Ok
        { Event.Subscription.Filter.scope
        ; thread
        ; kinds = Option.value kinds ~default:[]
        })
    ~encode:(fun ({ scope; thread; kinds } : Event.Subscription.Filter.t) ->
      (scope, thread), Some kinds)
    ~description:
      "Optional scope/thread filters; omission is absence, kind strings are lowercase."
;;

let filter =
  record
    [ field "scope" (Api_codec.nullable scope)
    ; field "thread_id" (Api_codec.nullable thread_id)
    ; field "kinds" (Api_codec.list kind ~max_items:8)
    ]
;;

let filter_json (filter : Event.Subscription.Filter.t) =
  Json.obj
    [ ( "scope"
      , Option.value_map filter.scope ~default:`Null ~f:(fun value ->
          unwrap (Api_codec.encode scope value)) )
    ; ( "thread_id"
      , Option.value_map
          filter.thread
          ~default:`Null
          ~f:Communication_id.Thread.jsonaf_of_t )
    ; ( "kinds"
      , `Array
          (List.map filter.kinds ~f:(fun value -> unwrap (Api_codec.encode kind value))) )
    ]
;;

let attribution_json value = unwrap (Api_codec.encode attribution value)

let board =
  record
    [ field "board_id" board_id
    ; field "revision" positive
    ; field "scope" scope
    ; field "title" (Api_codec.text ~max_bytes:512)
    ]
;;

let team =
  record
    [ field "team_id" team_id
    ; field "revision" positive
    ; field "title" (Api_codec.text ~max_bytes:512)
    ; field "members" (Api_codec.list Communication_recipient.codec ~max_items:1000)
    ]
;;

let subscription =
  record
    [ field "subscription_id" subscription_id
    ; field "revision" positive
    ; field "recipient" Communication_recipient.codec
    ; field "filter" filter
    ; field "active" Api_codec.boolean
    ]
;;

let page codec =
  record
    [ field "items" (Api_codec.list codec ~max_items:100)
    ; field "offset" decimal
    ; field "remaining" decimal
    ; field "next_offset" (Api_codec.nullable decimal)
    ]
  |> Api_codec.map
       ~decode:(fun value ->
         let offset = Json.integer (Json.field value "offset") in
         let count = List.length (Json.list (Json.field value "items")) in
         let remaining = Json.integer (Json.field value "remaining") in
         let next = Json.field value "next_offset" in
         if
           (remaining > 0
            && not
                 (String.equal
                    (Json.canonical next)
                    (Json.canonical (Json.int (offset + count)))))
           || (remaining = 0
               && not
                    (match next with
                     | `Null -> true
                     | _ -> false))
         then
           Error
             (Problem.create Invalid_argument "inconsistent communication page cursor")
         else Ok value)
       ~encode:Fn.id
       ~description:"Resumable page after budget fitting, with explicit remaining count."
;;

let related_thread =
  record
    [ field "thread_id" thread_id
    ; field "thread_revision" positive
    ; field "discussion_serial" decimal
    ; field "messages" (page Discussion_wire.comment)
    ]
;;

let source_reference =
  let current =
    Api_codec.map
      (Api_codec.nullable positive)
      ~decode:(function
        | None -> Ok ()
        | Some _ ->
          Error
            (Problem.create
               Invalid_argument
               "current source reference has no pinned revision"))
      ~encode:(fun () -> None)
      ~description:
        "Null denotes current source version; initial message bodies have a positive \
         pinned revision."
  in
  record [ field "comment_id" comment_id; field "revision" current ]
;;

let related_request =
  record
    [ field "thread_id" thread_id
    ; field "thread_revision" positive
    ; field "discussion_serial" decimal
    ; field "messages" (page Discussion_wire.comment)
    ; field "request_revision" positive
    ; field "source_message" Discussion_wire.comment
    ; field "source_message_version" (Api_codec.literal "current")
    ; field "source_message_reference" source_reference
    ]
;;

let thread_fields =
  [ field "thread_id" thread_id
  ; field "revision" positive
  ; field "board_id" board_id
  ; field "title" (Api_codec.text ~max_bytes:512)
  ; field "participants" (Api_codec.list actor_id ~max_items:1000)
  ; field "mentions" (Api_codec.list actor_id ~max_items:1000)
  ; field "links" (Api_codec.list target ~max_items:100)
  ; field "state" thread_state
  ; field "pinned" Api_codec.boolean
  ; field "comment_ids" (Api_codec.list comment_id ~max_items:100000)
  ; field "pinned_comment_ids" (Api_codec.list comment_id ~max_items:100000)
  ]
;;

let thread = record (thread_fields @ [ optional "related" related_thread ])

let request_responsibility =
  let open Event.Request.Responsibility in
  let unaccepted =
    Api_codec.object_
      (Fields.map
         (Fields.required "kind" (Api_codec.literal "unaccepted"))
         ~decode:(fun () -> Unaccepted)
         ~encode:(function
           | Unaccepted -> ()
           | Accepted _ -> Json.fail Invalid_argument "expected unaccepted responsibility"))
  in
  let accepted =
    Api_codec.object_
      (Fields.map
         (Fields.required "kind" (Api_codec.literal "accepted")
          ++ Fields.required "recipient" Communication_recipient.codec
          ++ Fields.required "attribution" attribution)
         ~decode:(fun (((), recipient), attribution) ->
           Accepted { recipient; attribution })
         ~encode:(function
           | Accepted { recipient; attribution } -> ((), recipient), attribution
           | Unaccepted -> Json.fail Invalid_argument "expected accepted responsibility"))
  in
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:[ "unaccepted", unaccepted; "accepted", accepted ]
    ~select:(function
      | Unaccepted -> "unaccepted"
      | Accepted _ -> "accepted")
;;

let responsibility = Api_codec.as_json request_responsibility

let status =
  tagged
    [ "open", record [ field "kind" (Api_codec.literal "open") ]
    ; ( "resolved"
      , record
          [ field "kind" (Api_codec.literal "resolved"); field "attribution" attribution ]
      )
    ; ( "cancelled"
      , record
          [ field "kind" (Api_codec.literal "cancelled")
          ; field "attribution" attribution
          ] )
    ]
;;

let delivery =
  record
    [ field "recipient" Communication_recipient.codec
    ; field "acknowledged" (Api_codec.nullable attribution)
    ]
;;

let request_fields =
  [ field "request_id" request_id
  ; field "revision" positive
  ; field "thread_id" thread_id
  ; field "kind" request_kind
  ; field "comment_id" comment_id
  ; field "correlation_id" (Api_codec.nullable correlation)
  ; field "reply_to_request_id" (Api_codec.nullable request_id)
  ; field "deadline_unix_ms" (Api_codec.nullable unix_ms)
  ; field "resolver_id" actor_id
  ; field "created" attribution
  ; field "deliveries" (Api_codec.list delivery ~max_items:1000)
  ; field "responsibility" responsibility
  ; field "status" status
  ]
;;

let request = record (request_fields @ [ optional "related" related_request ])

let board_json (value : Event.Board.t) =
  Json.obj
    [ "board_id", Communication_id.Board.jsonaf_of_t value.id
    ; "revision", Json.int value.revision
    ; "scope", unwrap (Api_codec.encode scope value.scope)
    ; "title", Json.string value.title
    ]
;;

let team_json (value : Event.Team.t) =
  Json.obj
    [ "team_id", Communication_id.Team.jsonaf_of_t value.id
    ; "revision", Json.int value.revision
    ; "title", Json.string value.title
    ; ( "members"
      , `Array
          (List.map value.members ~f:(fun value ->
             unwrap (Api_codec.encode Communication_recipient.codec value))) )
    ]
;;

let subscription_json (value : Event.Subscription.t) =
  Json.obj
    [ "subscription_id", Communication_id.Subscription.jsonaf_of_t value.id
    ; "revision", Json.int value.revision
    ; "recipient", unwrap (Api_codec.encode Communication_recipient.codec value.recipient)
    ; "filter", filter_json value.filter
    ; ("active", if value.active then `True else `False)
    ]
;;

let thread_json (value : Event.Thread.t) =
  Json.obj
    [ "thread_id", Communication_id.Thread.jsonaf_of_t value.id
    ; "revision", Json.int value.revision
    ; "board_id", Communication_id.Board.jsonaf_of_t value.board
    ; "title", Json.string value.title
    ; "participants", `Array (List.map value.participants ~f:Id.Actor.jsonaf_of_t)
    ; "mentions", `Array (List.map value.mentions ~f:Id.Actor.jsonaf_of_t)
    ; ( "links"
      , `Array
          (List.map value.links ~f:(fun value -> unwrap (Api_codec.encode target value)))
      )
    ; "state", unwrap (Api_codec.encode thread_state value.state)
    ; ("pinned", if value.pinned then `True else `False)
    ; "comment_ids", `Array (List.map value.messages ~f:Id.Comment.jsonaf_of_t)
    ; ( "pinned_comment_ids"
      , `Array (List.map value.pinned_messages ~f:Id.Comment.jsonaf_of_t) )
    ]
;;

let responsibility_json = function
  | Event.Request.Responsibility.Unaccepted ->
    Json.obj [ "kind", Json.string "unaccepted" ]
  | Accepted { recipient; attribution } ->
    Json.obj
      [ "kind", Json.string "accepted"
      ; "recipient", unwrap (Api_codec.encode Communication_recipient.codec recipient)
      ; "attribution", attribution_json attribution
      ]
;;

let status_json = function
  | Event.Request.Status.Open -> Json.obj [ "kind", Json.string "open" ]
  | Resolved attribution ->
    Json.obj
      [ "kind", Json.string "resolved"; "attribution", attribution_json attribution ]
  | Cancelled attribution ->
    Json.obj
      [ "kind", Json.string "cancelled"; "attribution", attribution_json attribution ]
;;

let request_json (value : Event.Request.t) =
  Json.obj
    [ "request_id", Communication_id.Request.jsonaf_of_t value.id
    ; "revision", Json.int value.revision
    ; "thread_id", Communication_id.Thread.jsonaf_of_t value.thread
    ; "kind", unwrap (Api_codec.encode request_kind value.kind)
    ; "comment_id", Id.Comment.jsonaf_of_t value.message
    ; ( "correlation_id"
      , Option.value_map value.correlation_id ~default:`Null ~f:Json.string )
    ; ( "reply_to_request_id"
      , Option.value_map
          value.reply_to
          ~default:`Null
          ~f:Communication_id.Request.jsonaf_of_t )
    ; ( "deadline_unix_ms"
      , Option.value_map value.deadline_unix_ms ~default:`Null ~f:Json.string )
    ; "resolver_id", Id.Actor.jsonaf_of_t value.resolver
    ; "created", attribution_json value.created
    ; ( "deliveries"
      , `Array
          (List.map value.deliveries ~f:(fun delivery ->
             Json.obj
               [ ( "recipient"
                 , unwrap
                     (Api_codec.encode
                        Communication_recipient.codec
                        delivery.Event.Request.Delivery.recipient) )
               ; ( "acknowledged"
                 , Option.value_map
                     delivery.acknowledged
                     ~default:`Null
                     ~f:attribution_json )
               ])) )
    ; "responsibility", responsibility_json value.responsibility
    ; "status", status_json value.status
    ]
;;

let snapshot codec ~decode ~encode =
  Api_codec.map
    codec
    ~decode:(fun json -> Json.decode (fun () -> decode json))
    ~encode
    ~description:"Complete retained snapshot; no related current discussion is attached."
;;

let read codec json name = unwrap (Api_codec.decode codec (Json.field json name))

let board_snapshot =
  snapshot board ~encode:board_json ~decode:(fun json ->
    { Event.Board.id = read board_id json "board_id"
    ; revision = read positive json "revision"
    ; scope = read scope json "scope"
    ; title = read (Coordination_wire.nonblank ~max_bytes:512) json "title"
    })
;;

let team_snapshot =
  snapshot team ~encode:team_json ~decode:(fun json ->
    { Event.Team.id = read team_id json "team_id"
    ; revision = read positive json "revision"
    ; title = read (Coordination_wire.nonblank ~max_bytes:512) json "title"
    ; members =
        read (Api_codec.list Communication_recipient.codec ~max_items:1000) json "members"
    })
;;

let subscription_snapshot =
  snapshot subscription ~encode:subscription_json ~decode:(fun json ->
    let filter_json = Json.field json "filter" in
    { Event.Subscription.id = read subscription_id json "subscription_id"
    ; revision = read positive json "revision"
    ; recipient = read Communication_recipient.codec json "recipient"
    ; filter =
        { scope = read (Api_codec.nullable scope) filter_json "scope"
        ; thread = read (Api_codec.nullable thread_id) filter_json "thread_id"
        ; kinds = read (Api_codec.list kind ~max_items:8) filter_json "kinds"
        }
    ; active = read Api_codec.boolean json "active"
    })
;;

let thread_snapshot =
  snapshot (record thread_fields) ~encode:thread_json ~decode:(fun json ->
    { Event.Thread.id = read thread_id json "thread_id"
    ; revision = read positive json "revision"
    ; board = read board_id json "board_id"
    ; title = read (Coordination_wire.nonblank ~max_bytes:512) json "title"
    ; participants = read (Api_codec.list actor_id ~max_items:1000) json "participants"
    ; mentions = read (Api_codec.list actor_id ~max_items:1000) json "mentions"
    ; links = read (Api_codec.list target ~max_items:100) json "links"
    ; state = read thread_state json "state"
    ; pinned = read Api_codec.boolean json "pinned"
    ; messages = read (Api_codec.list comment_id ~max_items:100000) json "comment_ids"
    ; pinned_messages =
        read (Api_codec.list comment_id ~max_items:100000) json "pinned_comment_ids"
    })
;;

let request_snapshot =
  snapshot (record request_fields) ~encode:request_json ~decode:(fun json ->
    let state_json = Json.field json "status" in
    let status =
      match Json.text (Json.field state_json "kind") with
      | "open" -> Event.Request.Status.Open
      | "resolved" -> Resolved (read attribution state_json "attribution")
      | "cancelled" -> Cancelled (read attribution state_json "attribution")
      | _ -> Json.fail Invalid_argument "invalid request status"
    in
    { Event.Request.id = read request_id json "request_id"
    ; revision = read positive json "revision"
    ; thread = read thread_id json "thread_id"
    ; kind = read request_kind json "kind"
    ; message = read comment_id json "comment_id"
    ; correlation_id = read (Api_codec.nullable correlation) json "correlation_id"
    ; reply_to = read (Api_codec.nullable request_id) json "reply_to_request_id"
    ; deadline_unix_ms = read (Api_codec.nullable unix_ms) json "deadline_unix_ms"
    ; resolver = read actor_id json "resolver_id"
    ; created = read attribution json "created"
    ; deliveries =
        read (Api_codec.list delivery ~max_items:1000) json "deliveries"
        |> List.map ~f:(fun value ->
          { Event.Request.Delivery.recipient =
              read Communication_recipient.codec value "recipient"
          ; acknowledged = read (Api_codec.nullable attribution) value "acknowledged"
          })
    ; responsibility = read request_responsibility json "responsibility"
    ; status
    })
;;

let validate_result ~method_ result =
  let codec =
    match method_ with
    | "board.put" -> board
    | "team.put" -> team
    | "subscription.put" -> subscription
    | "thread.put" | "thread.attach" | "thread.pin_message" -> thread
    | "request.create"
    | "request.acknowledge"
    | "request.accept"
    | "request.reassign"
    | "request.resolve"
    | "request.cancel" -> request
    | _ -> invalid_arg "unknown communication publication"
  in
  match Api_codec.decode codec result with
  | Ok _ -> ()
  | Error problem -> raise (Api_method.Invalid_response (method_, problem))
;;
