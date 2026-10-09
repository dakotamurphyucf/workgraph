open Core
module Fields = Api_codec.Fields
module Recipient = Communication_event.Recipient
module Notification = Communication_event.Notification

let identifier decode encode =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode
    ~encode
    ~description:"Opaque validated identity."
;;

let consumer_codec =
  identifier Communication_id.Consumer.of_string Communication_id.Consumer.to_string
;;

let actor_codec = identifier Id.Actor.of_string Id.Actor.to_string
let run_codec = identifier Id.Run.of_string Id.Run.to_string
let ticket_codec = identifier Id.Ticket.of_string Id.Ticket.to_string
let comment_codec = identifier Id.Comment.of_string Id.Comment.to_string
let decimal = Api_codec.decimal ~max:Int.max_value

let positive max description =
  Api_codec.map
    (Api_codec.decimal ~max)
    ~decode:(fun value ->
      if value > 0 then Ok value else Error (Problem.create Invalid_argument description))
    ~encode:Fn.id
    ~description
;;

let serial_codec =
  positive Int.max_value "Positive workspace-local notification/discussion serial."
;;

let kind_codec =
  Api_codec.enum
    [ "thread_changed", Notification.Kind.Thread_changed
    ; "message_received", Message_received
    ; "request_created", Request_created
    ; "request_acknowledged", Request_acknowledged
    ; "request_accepted", Request_accepted
    ; "request_reassigned", Request_reassigned
    ; "request_resolved", Request_resolved
    ; "request_cancelled", Request_cancelled
    ]
    ~equal:Notification.Kind.equal
;;

let budget_codec =
  Api_codec.map
    (Api_codec.decimal ~max:1_048_576)
    ~decode:(fun value ->
      if value >= 4096
      then Ok value
      else Error (Problem.create Invalid_argument "max_bytes must be 4096..1048576"))
    ~encode:Fn.id
    ~description:"Public result byte budget, 4KiB..1MiB."
;;

module Query = struct
  type t =
    { consumer_id : Communication_id.Consumer.t
    ; recipient : Recipient.t
    ; after : int
    ; through : int option
    ; kinds : Notification.Kind.t list option
    ; ticket_id : Id.Ticket.t option
    ; exclude_self : bool
    ; limit : int
    ; max_bytes : int
    ; timeout_ms : int option
    }

  let consumer_id t = t.consumer_id
  let recipient t = t.recipient
  let after t = t.after
  let through t = t.through
  let kinds t = t.kinds
  let ticket_id t = t.ticket_id
  let exclude_self t = t.exclude_self
  let limit t = t.limit
  let max_bytes t = t.max_bytes

  let fields =
    let identity =
      Fields.both
        (Fields.required "consumer_id" consumer_codec)
        (Fields.required "recipient" Communication_recipient.codec)
    in
    let enumeration =
      Fields.both (Fields.optional "after" decimal) (Fields.optional "through" decimal)
    in
    let filters =
      Fields.both
        (Fields.both
           (Fields.optional "kinds" (Api_codec.list kind_codec ~max_items:8))
           (Fields.optional "ticket_id" ticket_codec))
        (Fields.optional "exclude_self" Api_codec.boolean)
    in
    let limits =
      Fields.both
        (Fields.optional "limit" (positive 100 "limit must be 1..100"))
        (Fields.optional "max_bytes" budget_codec)
    in
    Fields.both (Fields.both identity enumeration) (Fields.both filters limits)
  ;;

  let mapped fields decode encode =
    Api_codec.map
      (Api_codec.object_ fields)
      ~decode
      ~encode
      ~description:
        "Unread notifications for the exact consumer and recipient; observation cursors \
         never acknowledge or accept responsibility."
  ;;

  let of_fields
        ( ((consumer_id, recipient), (after, through))
        , (((kinds, ticket_id), exclude_self), (limit, max_bytes)) )
        ~timeout_ms
    =
    let after = Option.value after ~default:0 in
    if Option.value_map through ~default:false ~f:(fun through -> after > through)
    then Error (Problem.create Invalid_argument "after exceeds through")
    else
      Ok
        { consumer_id
        ; recipient
        ; after
        ; through
        ; kinds
        ; ticket_id
        ; exclude_self = Option.value exclude_self ~default:false
        ; limit = Option.value limit ~default:50
        ; max_bytes = Option.value max_bytes ~default:65_536
        ; timeout_ms
        }
  ;;

  let to_fields t =
    ( ((t.consumer_id, t.recipient), (Some t.after, t.through))
    , (((t.kinds, t.ticket_id), Some t.exclude_self), (Some t.limit, Some t.max_bytes)) )
  ;;

  let read_codec =
    mapped fields (fun fields -> of_fields fields ~timeout_ms:None) to_fields
  ;;

  let wait_codec =
    mapped
      (Fields.both
         fields
         (Fields.optional
            "timeout_ms"
            (Api_codec.with_error_context
               (positive 25_000 "timeout_ms must be 1..25000")
               ~context:
                 "inbox.wait timeout_ms: 25-second server cap (1..25000 milliseconds)")))
      (fun (fields, timeout_ms) ->
         of_fields fields ~timeout_ms:(Some (Option.value timeout_ms ~default:20_000)))
      (fun t -> to_fields t, t.timeout_ms)
  ;;
end

module Ack = struct
  type t =
    { consumer_id : Communication_id.Consumer.t
    ; recipient : Recipient.t
    ; notification_ids : int list
    }
  [@@deriving sexp]

  let ids =
    Api_codec.map
      (Api_codec.list serial_codec ~max_items:100)
      ~decode:(fun ids ->
        if List.is_empty ids
        then
          Error
            (Problem.create Invalid_argument "notification_ids must contain 1..100 IDs")
        else Ok ids)
      ~encode:Fn.id
      ~description:"Selected stable workspace-local notification IDs, 1..100."
  ;;

  let fields =
    Fields.both
      (Fields.both
         (Fields.required "consumer_id" consumer_codec)
         (Fields.required "recipient" Communication_recipient.codec))
      (Fields.required "notification_ids" ids)
  ;;

  let codec =
    Api_codec.object_
      (Fields.map
         fields
         ~decode:(fun ((consumer_id, recipient), notification_ids) ->
           { consumer_id; recipient; notification_ids })
         ~encode:(fun t -> (t.consumer_id, t.recipient), t.notification_ids))
  ;;

  let receipt_codec = Api_codec.as_json (Api_codec.object_ fields)
end

let tagged_reference name id_codec =
  Api_codec.as_json
    (Api_codec.object_
       (Fields.both
          (Fields.required "kind" (Api_codec.enum [ name, () ] ~equal:Unit.equal))
          (Fields.required "id" id_codec)))
;;

let source_codec =
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:
      [ ( "message"
        , tagged_reference
            "message"
            (identifier
               Communication_id.Message.of_string
               Communication_id.Message.to_string) )
      ; ( "thread"
        , tagged_reference
            "thread"
            (identifier
               Communication_id.Thread.of_string
               Communication_id.Thread.to_string) )
      ; ( "request"
        , tagged_reference
            "request"
            (identifier
               Communication_id.Request.of_string
               Communication_id.Request.to_string) )
      ]
    ~select:(fun value -> Json.field value "kind" |> Json.text)
;;

let scope_codec =
  Api_codec.tagged
    ~discriminator:"kind"
    ~cases:
      [ ( "workspace"
        , Api_codec.as_json
            (Api_codec.object_
               (Fields.required
                  "kind"
                  (Api_codec.enum [ "workspace", () ] ~equal:Unit.equal))) )
      ; ( "project"
        , tagged_reference
            "project"
            (identifier Id.Project.of_string Id.Project.to_string) )
      ]
    ~select:(fun value -> Json.field value "kind" |> Json.text)
;;

let attribution_codec =
  Api_codec.as_json
    (Api_codec.object_
       (Fields.both
          (Fields.required "actor_id" actor_codec)
          (Fields.both
             (Fields.required "run_id" (Api_codec.nullable run_codec))
             (Fields.required "timestamp" (Api_codec.text ~max_bytes:512)))))
;;

let body_codec =
  let identity =
    Fields.both
      (Fields.required "comment_id" comment_codec)
      (Fields.required "revision" serial_codec)
  in
  let position =
    Fields.both
      (Fields.required "serial" serial_codec)
      (Fields.required "actor_id" actor_codec)
  in
  let prose =
    Fields.both
      (Fields.required "timestamp" (Api_codec.text ~max_bytes:512))
      (Fields.required "body" (Api_codec.text ~max_bytes:65_536))
  in
  let metadata =
    Fields.both
      (Fields.required "tombstone" Api_codec.boolean)
      (Fields.required
         "version_kind"
         (Api_codec.enum [ "initial", true; "current", false ] ~equal:Bool.equal))
  in
  Api_codec.as_json
    (Api_codec.object_
       (Fields.both (Fields.both identity position) (Fields.both prose metadata)))
;;

let item_codec =
  let identity =
    Fields.both
      (Fields.required "notification_id" serial_codec)
      (Fields.required "sequence" serial_codec)
  in
  let classification =
    Fields.both (Fields.required "kind" kind_codec) (Fields.required "scope" scope_codec)
  in
  let source =
    Fields.both
      (Fields.required "source" source_codec)
      (Fields.both
         (Fields.required "source_revision" serial_codec)
         (Fields.required "source_current_revision" serial_codec))
  in
  let routing =
    Fields.both
      (Fields.required "ticket_ids" (Api_codec.list ticket_codec ~max_items:1024))
      (Fields.required "attribution" attribution_codec)
  in
  let fields =
    Fields.both
      (Fields.both identity classification)
      (Fields.both
         source
         (Fields.both
            routing
            (Fields.required "body_source" (Api_codec.nullable body_codec))))
  in
  Api_codec.map
    (Api_codec.as_json (Api_codec.object_ fields))
    ~decode:(fun value ->
      if
        Json.integer (Json.field value "source_current_revision")
        < Json.integer (Json.field value "source_revision")
      then
        Error
          (Problem.create
             Invalid_argument
             "current notification source revision precedes event revision")
      else Ok value)
    ~encode:Fn.id
    ~description:
      "Canonical stable notification with useful pinned/current body and explicit source \
       versions."
;;

let result_codec =
  let identity =
    Fields.both
      (Fields.required "consumer_id" consumer_codec)
      (Fields.required "recipient" Communication_recipient.codec)
  in
  let range =
    Fields.both (Fields.required "after" decimal) (Fields.required "through" decimal)
  in
  let page =
    Fields.both
      (Fields.required "next_after" decimal)
      (Fields.required "remaining" decimal)
  in
  let fields =
    Fields.both
      (Fields.both identity range)
      (Fields.both
         page
         (Fields.both
            (Fields.required "exclude_self" Api_codec.boolean)
            (Fields.required "items" (Api_codec.list item_codec ~max_items:100))))
  in
  Api_codec.map
    (Api_codec.as_json (Api_codec.object_ fields))
    ~decode:(fun value ->
      Json.decode (fun () ->
        let after = Json.field value "after" |> Json.integer
        and through = Json.field value "through" |> Json.integer in
        let next = Json.field value "next_after" |> Json.integer in
        if after > next || next > through
        then Json.fail Invalid_argument "notification page cursor outside capture";
        let items = Json.field value "items" |> Json.list in
        let last =
          List.fold items ~init:after ~f:(fun previous item ->
            let id = Json.field item "notification_id" |> Json.integer in
            if id <= previous || id > through
            then
              Json.fail
                Invalid_argument
                "notification IDs must strictly increase within capture";
            id)
        in
        if not (Int.equal last next)
        then Json.fail Invalid_argument "notification page advanced past unreturned items";
        value))
    ~encode:Fn.id
    ~description:
      "Read-only unread enumeration. next_after is exactly the last returned ID or \
       supplied after, never a consumption cursor."
;;

let read_method =
  Api_method.create
    ~name:"inbox.read"
    ~summary:
      "Read bounded unread notifications for an explicit consumer and recipient without \
       consuming them."
    ~mode:Read
    ~request:Query.read_codec
    ~response:result_codec
;;

let wait_method =
  Api_method.create
    ~name:"inbox.wait"
    ~summary:
      "Wait boundedly for unread notifications; responses do not consume or acknowledge."
    ~mode:Read
    ~request:Query.wait_codec
    ~response:result_codec
;;

let ack_method =
  Api_method.create
    ~name:"inbox.ack"
    ~summary:
      "Durably acknowledge selected notification IDs for one consumer and recipient."
    ~mode:Mutation
    ~request:Ack.codec
    ~response:Ack.receipt_codec
;;
