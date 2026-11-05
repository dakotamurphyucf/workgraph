open Core
module W = Coordination_wire
module F = Api_codec.Fields

let ( ++ ) = F.both
let req = F.required
let opt = F.optional
let counter = W.counter
let obj fields = Api_codec.as_json (Api_codec.object_ fields)

let bound low high =
  W.checked (Api_codec.decimal ~max:high) (fun n ->
    if n < low then Json.fail Invalid_argument "query bound too small")
;;

let unique codec ~max_items ~compare =
  W.checked (Api_codec.list codec ~max_items) (fun values ->
    if List.contains_dup values ~compare
    then Json.fail Invalid_argument "duplicate attention selector")
;;

let default json key value decode =
  Option.value_map (Json.optional json key) ~default:value ~f:decode
;;

let optional json key decode = Option.map (Json.optional json key) ~f:decode

let boolean = function
  | `True -> true
  | `False -> false
  | _ -> Json.fail Invalid_argument "expected boolean"
;;

let ticket = W.id Id.Ticket.of_string Id.Ticket.to_string
let project = W.id Id.Project.of_string Id.Project.to_string

let request_id =
  W.id Communication_id.Request.of_string Communication_id.Request.to_string
;;

let thread_id = W.id Communication_id.Thread.of_string Communication_id.Thread.to_string

let message_id =
  W.id Communication_id.Message.of_string Communication_id.Message.to_string
;;

let consumer =
  W.id Communication_id.Consumer.of_string Communication_id.Consumer.to_string
;;

module Kind = struct
  type t =
    | Communication
    | Fact
    | Ticket
    | Readiness
  [@@deriving sexp, compare, equal]

  let codec =
    Api_codec.enum
      [ "communication", Communication
      ; "fact", Fact
      ; "ticket", Ticket
      ; "readiness", Readiness
      ]
      ~equal
  ;;
end

module Filter = struct
  type t =
    { project : Id.Project.t option
    ; recipient : Communication.Recipient.t option
    ; consumer : Communication_id.Consumer.t option
    ; exclude_self : bool
    ; kinds : Kind.t list
    ; fact_scope : Facts.Scope.t option
    ; fact_prefix : string option
    ; tickets : Id.Ticket.t list
    ; run : Id.Run.t option
    }

  let codec =
    Api_codec.object_
      (F.map
         (opt "project_id" project
          ++ opt "recipient" Communication_recipient.codec
          ++ opt "consumer_id" consumer
          ++ opt "exclude_self" Api_codec.boolean
          ++ opt "kinds" (unique Kind.codec ~max_items:4 ~compare:Kind.compare)
          ++ opt "fact_scope" Facts.Scope.codec
          ++ opt "fact_prefix" (Api_codec.text ~max_bytes:128)
          ++ opt "ticket_ids" (unique ticket ~max_items:100 ~compare:Id.Ticket.compare)
          ++ opt "run_id" W.run)
         ~decode:
           (fun
             ( ( ( (((((project, recipient), consumer), exclude_self), kinds), fact_scope)
                 , fact_prefix )
               , tickets )
             , run ) ->
           { project
           ; recipient
           ; consumer
           ; exclude_self = Option.value exclude_self ~default:false
           ; kinds =
               (let values = Option.value kinds ~default:[] in
                (if List.is_empty values
                 then
                   if Option.is_some consumer
                   then [ Kind.Communication; Fact; Ticket; Readiness ]
                   else [ Kind.Fact; Ticket; Readiness ]
                 else values)
                |> List.sort ~compare:Kind.compare)
           ; fact_scope
           ; fact_prefix
           ; tickets =
               List.sort (Option.value tickets ~default:[]) ~compare:Id.Ticket.compare
           ; run
           })
         ~encode:(fun t ->
           ( ( ( ( ( (((t.project, t.recipient), t.consumer), Some t.exclude_self)
                   , Some t.kinds )
                 , t.fact_scope )
               , t.fact_prefix )
             , Some t.tickets )
           , t.run )))
    |> fun codec ->
    W.checked codec (fun t ->
      if Bool.(Option.is_some t.recipient <> Option.is_some t.consumer)
      then
        Json.fail Invalid_argument "recipient and consumer_id must be selected together";
      if List.mem t.kinds Communication ~equal:Kind.equal && Option.is_none t.consumer
      then Json.fail Invalid_argument "communication requires recipient and consumer_id";
      if t.exclude_self && Option.is_none t.recipient
      then Json.fail Invalid_argument "exclude_self requires recipient";
      if
        (Option.is_some t.fact_scope || Option.is_some t.fact_prefix)
        && not (List.mem t.kinds Fact ~equal:Kind.equal)
      then Json.fail Invalid_argument "fact selectors require fact kind")
    |> Api_codec.with_error_context
         ~context:
           "For communication, select filter.recipient and filter.consumer_id together; \
            use kinds:[\"communication\"] to exclude fact, ticket and readiness \
            activity."
  ;;
end

module Request = struct
  type t = Jsonaf.t

  let filter t =
    match Json.optional t "filter" with
    | None -> W.decode_exn Filter.codec (Json.obj [])
    | Some json -> W.decode_exn Filter.codec json
  ;;

  let after t = optional t "after" Json.integer
  let cursor t = optional t "cursor" Json.text
  let limit t = default t "limit" 50 Json.integer
  let max_bytes t = default t "max_bytes" 65536 Json.integer
  let timeout_ms t = default t "timeout_ms" 20000 Json.integer
  let initial_readiness t = default t "initial_readiness" false boolean
  let readiness_cursor t = optional t "readiness_cursor" Json.text

  let base =
    opt "filter" Filter.codec
    ++ opt "after" counter
    ++ opt "cursor" (W.nonblank ~max_bytes:4096)
    ++ opt "limit" (bound 1 100)
    ++ opt "max_bytes" (bound 4096 1048576)
    ++ opt "initial_readiness" Api_codec.boolean
    ++ opt "readiness_cursor" (W.nonblank ~max_bytes:4096)
  ;;

  let check t =
    if Option.is_some (after t) && Option.is_some (cursor t)
    then Json.fail Invalid_argument "provide cursor or after, not both";
    ignore (filter t : Filter.t)
  ;;

  let read = W.checked (obj base) check
  let wait = W.checked (obj (base ++ opt "timeout_ms" (bound 1 25000))) check

  let codec ~method_ =
    match method_ with
    | "attention.read" -> Some read
    | "attention.wait" -> Some wait
    | _ -> None
  ;;

  let read_params = function
    | `Object fields ->
      Json.obj
        (List.filter fields ~f:(fun (key, _) -> not (String.equal key "timeout_ms")))
    | _ -> assert false
  ;;

  let with_cursor t cursor =
    match read_params t with
    | `Object fields ->
      Json.obj
        (("cursor", Json.string cursor)
         :: List.filter fields ~f:(fun (key, _) ->
           not
             (List.mem
                [ "cursor"; "after"; "initial_readiness"; "readiness_cursor" ]
                key
                ~equal:String.equal)))
    | _ -> assert false
  ;;
end

let source_ref = obj (req "workspace_revision" counter ++ req "change_index" counter)

let source_codec =
  let branch kind field codec =
    obj (req "kind" (Api_codec.literal kind) ++ req field codec)
  in
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:
      [ "request", branch "request" "request_id" request_id
      ; "thread", branch "thread" "thread_id" thread_id
      ; "message", branch "message" "message_id" message_id
      ]
    ~select:(fun json -> Json.field json "kind" |> Json.text)
;;

let notification =
  obj
    (req "notification_id" counter
     ++ req "source" source_codec
     ++ req "source_revision" counter
     ++ req
          "kind"
          (Api_codec.enum
             (List.map
                [ "message_received"
                ; "thread_changed"
                ; "request_created"
                ; "request_acknowledged"
                ; "request_accepted"
                ; "request_reassigned"
                ; "request_resolved"
                ; "request_cancelled"
                ; "request_updated"
                ]
                ~f:(fun s -> s, s))
             ~equal:String.equal)
     ++ req "causal_body" (Api_codec.nullable Communication_wire.comment_ref))
;;

let unchecked_row_codec =
  let branch kind fields =
    obj (req "kind" (Api_codec.literal kind) ++ req "source" source_ref ++ fields)
  in
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:
      [ ( "communication_group"
        , branch
            "communication_group"
            (req "group_id" (W.nonblank ~max_bytes:256)
             ++ req "fragment_index" counter
             ++ req "fragment_count" counter
             ++ req "notification_ids" (unique counter ~max_items:32 ~compare:Int.compare)
             ++ req "notifications" (Api_codec.list notification ~max_items:32)) )
      ; "fact_changed", branch "fact_changed" (req "fact" Facts.Change.codec)
      ; ( "ticket_changed"
        , branch
            "ticket_changed"
            (req "ticket_id" ticket
             ++ req "ticket_revision" counter
             ++ req
                  "status"
                  (Api_codec.enum
                     [ "backlog", Workflow.Category.Backlog
                     ; "todo", Todo
                     ; "in_progress", In_progress
                     ; "done", Done
                     ; "canceled", Canceled
                     ]
                     ~equal:Workflow.Category.equal)) )
      ; ( "hierarchy_policy_changed"
        , branch
            "hierarchy_policy_changed"
            (req "ticket_id" ticket ++ req "policy_revision" W.positive) )
      ; ( "readiness_invalidated"
        , branch "readiness_invalidated" (req "reason" (Api_codec.text ~max_bytes:128)) )
      ]
    ~select:(fun json -> Json.field json "kind" |> Json.text)
;;

let row_codec =
  W.checked unchecked_row_codec (fun row ->
    let source = Json.field row "source" in
    if Json.field source "workspace_revision" |> Json.integer = 0
    then Json.fail Invalid_argument "attention source revision must be positive";
    if String.equal (Json.field row "kind" |> Json.text) "communication_group"
    then (
      let ids =
        Json.field row "notification_ids" |> Json.list |> List.map ~f:Json.integer
      in
      let notifications = Json.field row "notifications" |> Json.list in
      let actual =
        List.map notifications ~f:(fun n ->
          Json.field n "notification_id" |> Json.integer)
      in
      if
        List.is_empty ids
        || (not (List.equal Int.equal ids actual))
        || List.exists ids ~f:(fun id -> id = 0)
        || not (List.is_sorted_strictly ids ~compare:Int.compare)
      then
        Json.fail
          Invalid_argument
          "communication fragment IDs must exactly match ordered notifications";
      if
        Json.field row "fragment_index"
        |> Json.integer
        >= (Json.field row "fragment_count" |> Json.integer)
      then Json.fail Invalid_argument "communication fragment position exceeds group"))
;;

let readiness_codec =
  obj
    (req "workspace_revision" counter
     ++ req "observed_unix_ms" (Api_codec.decimal64 ~max:Int64.max_value)
     ++ req "items" (Api_codec.list Coordinator_wire.Item.codec ~max_items:100)
     ++ req "cursor" (Api_codec.nullable (W.nonblank ~max_bytes:4096))
     ++ req "has_more" Api_codec.boolean
     ++ req "needs_larger_budget" Api_codec.boolean
     ++ req "required_bytes" (Api_codec.nullable counter))
;;

let response_codec =
  obj
    (req "through" counter
     ++ req "items" (Api_codec.list row_codec ~max_items:100)
     ++ req "cursor" (W.nonblank ~max_bytes:4096)
     ++ req "has_more" Api_codec.boolean
     ++ req "needs_larger_budget" Api_codec.boolean
     ++ req "required_bytes" (Api_codec.nullable counter)
     ++ req "readiness" (Api_codec.nullable readiness_codec))
;;

let methods =
  List.map [ "attention.read"; "attention.wait" ] ~f:(fun name ->
    Api_method.Packed.Pack
      (Api_method.create
         ~name
         ~summary:
           "Read or wait for filtered exact-source attention; acknowledgement is \
            explicit."
         ~mode:Read
         ~request:(Option.value_exn (Request.codec ~method_:name))
         ~response:response_codec))
;;

let overview_kinds =
  [ "claim"
  ; "attempt"
  ; "named_reservation"
  ; "path_reservation"
  ; "request"
  ; "notification"
  ]
;;

let overview_request =
  obj
    (req "actor_id" W.actor
     ++ opt "project_id" project
     ++ opt "run_id" W.run
     ++ opt "consumer_id" consumer
     ++ opt
          "kinds"
          (unique
             (Api_codec.enum
                (List.map overview_kinds ~f:(fun s -> s, s))
                ~equal:String.equal)
             ~max_items:6
             ~compare:String.compare)
     ++ opt "cursor" (W.nonblank ~max_bytes:4096)
     ++ opt "limit" (bound 1 100)
     ++ opt "max_bytes" (bound 4096 1048576))
;;

let overview_row =
  let branch kind fields = obj (req "kind" (Api_codec.literal kind) ++ fields) in
  let holder =
    req "run_id" W.run
    ++ req "token" counter
    ++ req
         "mode"
         (Api_codec.enum
            [ "exclusive", Reservation.Mode.Exclusive; "shared", Shared ]
            ~equal:Reservation.Mode.equal)
    ++ req "lease" Planning_ticket_wire.Lease.codec
  in
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:
      [ ( "claim"
        , branch
            "claim"
            (req "ticket_id" ticket
             ++ req "ticket_revision" counter
             ++ req "ownership" Planning_ticket_wire.Ownership.codec) )
      ; ( "attempt"
        , branch
            "attempt"
            (req "attempt_id" (W.id Attempt.Id.of_string Attempt.Id.to_string)
             ++ req "ticket_id" ticket
             ++ req "run_id" W.run
             ++ req "revision" counter
             ++ req "token" counter
             ++ req
                  "state"
                  (Api_codec.enum
                     [ "running", "running"; "waiting", "waiting" ]
                     ~equal:String.equal)) )
      ; ( "named_reservation"
        , branch
            "named_reservation"
            (req "name" (W.id Reservation.Name.of_string Reservation.Name.to_string)
             ++ holder) )
      ; ( "path_reservation"
        , branch "path_reservation" (req "target" Path_scope.codec ++ holder) )
      ; ( "request"
        , branch
            "request"
            (req "record" Communication_wire.request
             ++ req
                  "roles"
                  (unique
                     (Api_codec.enum
                        (List.map
                           [ "incoming_resolver"
                           ; "incoming_delivery"
                           ; "incoming_responsible"
                           ; "outgoing"
                           ]
                           ~f:(fun s -> s, s))
                        ~equal:String.equal)
                     ~max_items:4
                     ~compare:String.compare)) )
      ; ( "notification"
        , branch
            "notification"
            (req "consumer_id" consumer
             ++ req "recipient" Communication_recipient.codec
             ++ req "record" notification) )
      ]
    ~select:(fun json -> Json.field json "kind" |> Json.text)
;;

let overview_response =
  obj
    (req "workspace_revision" counter
     ++ req "observed_unix_ms" (Api_codec.decimal64 ~max:Int64.max_value)
     ++ req "items" (Api_codec.list overview_row ~max_items:100)
     ++ req "cursor" (Api_codec.nullable (W.nonblank ~max_bytes:4096))
     ++ req "has_more" Api_codec.boolean
     ++ req "needs_larger_budget" Api_codec.boolean
     ++ req "required_bytes" (Api_codec.nullable counter))
;;

let overview_method =
  Api_method.Packed.Pack
    (Api_method.create
       ~name:"actor.overview"
       ~summary:
         "Read held ownership, requests and explicitly selected unread state in one \
          capture."
       ~mode:Read
       ~request:overview_request
       ~response:overview_response)
;;

let notification_json (n : Communication.Notification.t) =
  let source =
    match n.source with
    | Request id ->
      Json.obj
        [ "kind", Json.string "request"
        ; "request_id", Communication_id.Request.jsonaf_of_t id
        ]
    | Thread id ->
      Json.obj
        [ "kind", Json.string "thread"
        ; "thread_id", Communication_id.Thread.jsonaf_of_t id
        ]
    | Message id ->
      Json.obj
        [ "kind", Json.string "message"
        ; "message_id", Communication_id.Message.jsonaf_of_t id
        ]
  in
  let json =
    Json.obj
      [ "notification_id", Json.int n.serial
      ; "source", source
      ; "source_revision", Json.int n.source_revision
      ; "kind", W.encode_exn Communication_wire.kind n.kind
      ; ( "causal_body"
        , Option.value_map
            n.causal_body
            ~default:`Null
            ~f:(W.encode_exn Communication_wire.comment_ref) )
      ]
  in
  W.decode_exn notification json
;;
