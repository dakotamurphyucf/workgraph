open Core
module Recipient = Communication_event.Recipient
module Scope = Communication_event.Scope
module Thread = Communication_event.Thread
module Request = Communication_event.Request
module Subscription = Communication_event.Subscription

(** Domain communication commands. Input codecs preserve distinctions between
    omission, explicit clearing, tagged values and plain lowercase enums.
    [Request_ask] and [Request_resolve] with a body compose discussion and
    communication changes through [State.prepare]. Ask threads list the author
    and resolver as participants; recipients receive accountable request
    deliveries independently of that participant list. [Communication.prepare]
    accepts only commands requiring a communication snapshot. *)
type t =
  | Board_put of
      { id : Communication_id.Board.t
      ; expected_revision : int
      ; scope : Scope.t
      ; title : string
      }
  | Thread_put of
      { id : Communication_id.Thread.t
      ; expected_revision : int
      ; board : Communication_id.Board.t
      ; title : string
      ; participants : Id.Actor.t list
      ; mentions : Id.Actor.t list
      ; links : Entity_ref.t list
      ; state : Thread.State.t
      ; pinned : bool
      }
  | Thread_attach of
      { id : Communication_id.Thread.t
      ; expected_revision : int
      ; message : Id.Comment.t
      }
  | Thread_pin_message of
      { id : Communication_id.Thread.t
      ; expected_revision : int
      ; message : Id.Comment.t
      ; pinned : bool
      }
  | Team_put of
      { id : Communication_id.Team.t
      ; expected_revision : int
      ; title : string
      ; members : Recipient.t list
      }
  | Request_ask of
      { id : Communication_id.Request.t
      ; title : string
      ; body : string
      ; recipients : Recipient.t list
      ; resolver : Id.Actor.t
      ; ticket : Id.Ticket.t option
      ; kind : Request.Kind.t
      }
  | Request_create of
      { id : Communication_id.Request.t
      ; thread : Communication_id.Thread.t
      ; kind : Request.Kind.t
      ; message : Id.Comment.t
      ; recipients : Recipient.t list
      ; teams : Communication_id.Team.t list
      ; resolver : Id.Actor.t
      ; correlation_id : string option
      ; reply_to : Communication_id.Request.t option
      ; deadline_unix_ms : string option
      }
  | Request_acknowledge of
      { id : Communication_id.Request.t
      ; expected_revision : int
      ; recipient : Recipient.t
      }
  | Request_accept of
      { id : Communication_id.Request.t
      ; expected_revision : int
      ; recipient : Recipient.t
      }
  | Request_reassign of
      { id : Communication_id.Request.t
      ; expected_revision : int
      ; recipient : Recipient.t option
      }
  | Request_resolve of
      { id : Communication_id.Request.t
      ; expected_revision : int
      ; body : string option
      }
  | Request_cancel of
      { id : Communication_id.Request.t
      ; expected_revision : int
      }
  | Subscription_put of
      { id : Communication_id.Subscription.t
      ; expected_revision : int
      ; recipient : Recipient.t
      ; filter : Subscription.Filter.t
      ; active : bool
      }
  | Inbox_ack of Communication_inbox.Ack.t
[@@deriving sexp]

module Native_fields = Api_codec.Fields

(* Each command field is declared once. The raw half retains references for
   transaction validation; the value half admits only resolved domain IDs. *)
module Fields = struct
  type 'a t =
    { value : 'a Native_fields.t
    ; raw : (string * Jsonaf.t) list Native_fields.t
    }

  let required ?raw name codec =
    let raw = Option.value raw ~default:(Api_codec.as_json codec) in
    { value = Native_fields.required name codec
    ; raw =
        Native_fields.map
          (Native_fields.required name raw)
          ~decode:(fun value -> [ name, value ])
          ~encode:(fun fields -> List.Assoc.find_exn fields name ~equal:String.equal)
    }
  ;;

  let optional ?raw name codec =
    let raw = Option.value raw ~default:(Api_codec.as_json codec) in
    { value = Native_fields.optional name codec
    ; raw =
        Native_fields.map
          (Native_fields.optional name raw)
          ~decode:(fun value ->
            Option.to_list (Option.map value ~f:(fun value -> name, value)))
          ~encode:(fun fields -> List.Assoc.find fields name ~equal:String.equal)
    }
  ;;

  let both left right =
    { value = Native_fields.both left.value right.value
    ; raw =
        Native_fields.map
          (Native_fields.both left.raw right.raw)
          ~decode:(fun (left, right) -> left @ right)
          ~encode:(fun fields -> fields, fields)
    }
  ;;
end

module Request_codec = struct
  type 'a t =
    { value : 'a Api_codec.t
    ; raw : Jsonaf.t Api_codec.t
    }

  let of_codec value = { value; raw = Api_codec.as_json value }

  let object_ (fields : 'a Fields.t) =
    { value = Api_codec.object_ fields.value
    ; raw =
        Api_codec.map
          (Api_codec.object_ fields.raw)
          ~decode:(fun fields -> Ok (Json.obj fields))
          ~encode:(function
            | `Object fields -> fields
            | _ -> Json.fail Invalid_argument "expected request object")
          ~description:"Raw command object preserving explicit references."
    }
  ;;

  let map ?(validate_raw = fun _ -> Ok ()) codec ~decode ~encode ~description =
    { value = Api_codec.map codec.value ~decode ~encode ~description
    ; raw =
        Api_codec.map
          codec.raw
          ~decode:(fun json -> Result.map (validate_raw json) ~f:(fun () -> json))
          ~encode:Fn.id
          ~description
    }
  ;;
end

let ( ++ ) = Fields.both

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Resolved local identity; aliases are not accepted."
;;

let board_id = id Communication_id.Board.of_string Communication_id.Board.to_string
let thread_id = id Communication_id.Thread.of_string Communication_id.Thread.to_string
let request_id = id Communication_id.Request.of_string Communication_id.Request.to_string
let team_id = id Communication_id.Team.of_string Communication_id.Team.to_string

let subscription_id =
  id Communication_id.Subscription.of_string Communication_id.Subscription.to_string
;;

let actor_id = id Id.Actor.of_string Id.Actor.to_string
let ticket_id = id Id.Ticket.of_string Id.Ticket.to_string
let body = Coordination_wire.nonblank ~max_bytes:65536
let comment_id = id Id.Comment.of_string Id.Comment.to_string
let decimal = Api_codec.decimal ~max:Int.max_value

let title =
  Api_codec.map
    (Api_codec.text ~max_bytes:512)
    ~decode:(fun value ->
      if String.is_empty (String.strip value)
      then Error (Problem.create Invalid_argument "title must be nonblank")
      else Ok value)
    ~encode:Fn.id
    ~description:"Nonblank UTF-8 title, at most 512 bytes."
;;

let correlation =
  Api_codec.map
    (Api_codec.text ~max_bytes:128)
    ~decode:(fun value ->
      if String.is_empty value
      then Error (Problem.create Invalid_argument "correlation ID must be nonempty")
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

let target =
  Api_codec.map
    Planning_target.codec
    ~decode:Planning_target.to_ref
    ~encode:Planning_target.of_ref
    ~description:"Resolved tagged entity link."
;;

let reference codec = Api_codec.as_json (Api_codec.reference codec)
let raw_record fields = (Request_codec.object_ fields).raw
let raw_required name codec = Fields.required name codec

let raw_tagged cases =
  Api_codec.tagged ~discriminator:"kind" ~cases ~select:(fun json ->
    Json.text (Json.field json "kind"))
;;

let raw_scope =
  raw_tagged
    [ "workspace", raw_record (raw_required "kind" (Api_codec.literal "workspace"))
    ; ( "project"
      , raw_record
          (raw_required "kind" (Api_codec.literal "project")
           ++ Fields.required ~raw:(reference actor_id) "id" actor_id) )
    ]
;;

let raw_recipient =
  raw_tagged
    (List.map [ "actor"; "run" ] ~f:(fun kind ->
       ( kind
       , raw_record
           (raw_required "kind" (Api_codec.literal kind)
            ++ Fields.required ~raw:(reference actor_id) "id" actor_id) )))
;;

let raw_target =
  raw_tagged
    (("workspace", raw_record (raw_required "kind" (Api_codec.literal "workspace")))
     :: List.map [ "project"; "milestone"; "ticket"; "resource" ] ~f:(fun kind ->
       ( kind
       , raw_record
           (raw_required "kind" (Api_codec.literal kind)
            ++ Fields.required ~raw:(reference actor_id) "id" actor_id) )))
;;

let raw_filter =
  raw_record
    (Fields.optional "scope" raw_scope
     ++ Fields.optional ~raw:(reference thread_id) "thread_id" thread_id
     ++ Fields.optional "kinds" (Api_codec.list Communication_wire.kind ~max_items:8))
;;

let validate_request_recipients params =
  let present name =
    Option.value_map (Json.optional params name) ~default:false ~f:(fun json ->
      not (List.is_empty (Json.list json)))
  in
  if present "recipients" || present "teams"
  then Ok ()
  else Error (Problem.create Invalid_argument "request requires recipients or teams")
;;

let entries =
  [ ( "board.put"
    , Request_codec.map
        (Request_codec.object_
           (Fields.required ~raw:(reference board_id) "board_id" board_id
            ++ Fields.required "expected_revision" decimal
            ++ Fields.required ~raw:raw_scope "scope" Communication_wire.scope
            ++ Fields.required "title" title))
        ~decode:(fun (((id, expected_revision), scope), title) ->
          Ok (Board_put { id; expected_revision; scope; title }))
        ~encode:(function
          | Board_put { id; expected_revision; scope; title } ->
            ((id, expected_revision), scope), title
          | Thread_put _
          | Thread_attach _
          | Thread_pin_message _
          | Team_put _
          | Request_ask _
          | Request_create _
          | Request_acknowledge _
          | Request_accept _
          | Request_reassign _
          | Request_resolve _
          | Request_cancel _
          | Subscription_put _
          | Inbox_ack _ -> Json.fail Invalid_argument "wrong communication command")
        ~description:
          "Validated board.put arguments; domain preparation validates live references \
           and transitions." )
  ; ( "thread.put"
    , Request_codec.map
        (Request_codec.object_
           (Fields.required ~raw:(reference thread_id) "thread_id" thread_id
            ++ Fields.required "expected_revision" decimal
            ++ Fields.required ~raw:(reference board_id) "board_id" board_id
            ++ Fields.required "title" title
            ++ Fields.optional "participants" (Api_codec.list actor_id ~max_items:1000)
            ++ Fields.optional "mentions" (Api_codec.list actor_id ~max_items:1000)
            ++ Fields.optional
                 ~raw:(Api_codec.as_json (Api_codec.list raw_target ~max_items:100))
                 "links"
                 (Api_codec.list target ~max_items:100)
            ++ Fields.required "state" Communication_wire.thread_state
            ++ Fields.optional "pinned" Api_codec.boolean))
        ~decode:
          (fun
            ( ( ( (((((id, expected_revision), board), title), participants), mentions)
                , links )
              , state )
            , pinned ) ->
          let participants = Option.value participants ~default:[] in
          let mentions = Option.value mentions ~default:[] in
          let links = Option.value links ~default:[] in
          let pinned = Option.value pinned ~default:false in
          Ok
            (Thread_put
               { id
               ; expected_revision
               ; board
               ; title
               ; participants
               ; mentions
               ; links
               ; state
               ; pinned
               }))
        ~encode:(function
          | Thread_put
              { id
              ; expected_revision
              ; board
              ; title
              ; participants
              ; mentions
              ; links
              ; state
              ; pinned
              } ->
            ( ( ( ( ((((id, expected_revision), board), title), Some participants)
                  , Some mentions )
                , Some links )
              , state )
            , Some pinned )
          | Board_put _
          | Thread_attach _
          | Thread_pin_message _
          | Team_put _
          | Request_ask _
          | Request_create _
          | Request_acknowledge _
          | Request_accept _
          | Request_reassign _
          | Request_resolve _
          | Request_cancel _
          | Subscription_put _
          | Inbox_ack _ -> Json.fail Invalid_argument "wrong communication command")
        ~description:
          "Validated thread.put arguments; domain preparation validates live references \
           and transitions." )
  ; ( "thread.attach"
    , Request_codec.map
        (Request_codec.object_
           (Fields.required ~raw:(reference thread_id) "thread_id" thread_id
            ++ Fields.required "expected_revision" decimal
            ++ Fields.required ~raw:(reference comment_id) "comment_id" comment_id))
        ~decode:(fun ((id, expected_revision), message) ->
          Ok (Thread_attach { id; expected_revision; message }))
        ~encode:(function
          | Thread_attach { id; expected_revision; message } ->
            (id, expected_revision), message
          | Board_put _
          | Thread_put _
          | Thread_pin_message _
          | Team_put _
          | Request_ask _
          | Request_create _
          | Request_acknowledge _
          | Request_accept _
          | Request_reassign _
          | Request_resolve _
          | Request_cancel _
          | Subscription_put _
          | Inbox_ack _ -> Json.fail Invalid_argument "wrong communication command")
        ~description:
          "Validated thread.attach arguments; domain preparation validates live \
           references and transitions." )
  ; ( "thread.pin_message"
    , Request_codec.map
        (Request_codec.object_
           (Fields.required ~raw:(reference thread_id) "thread_id" thread_id
            ++ Fields.required "expected_revision" decimal
            ++ Fields.required ~raw:(reference comment_id) "comment_id" comment_id
            ++ Fields.required "pinned" Api_codec.boolean))
        ~decode:(fun (((id, expected_revision), message), pinned) ->
          Ok (Thread_pin_message { id; expected_revision; message; pinned }))
        ~encode:(function
          | Thread_pin_message { id; expected_revision; message; pinned } ->
            ((id, expected_revision), message), pinned
          | Board_put _
          | Thread_put _
          | Thread_attach _
          | Team_put _
          | Request_ask _
          | Request_create _
          | Request_acknowledge _
          | Request_accept _
          | Request_reassign _
          | Request_resolve _
          | Request_cancel _
          | Subscription_put _
          | Inbox_ack _ -> Json.fail Invalid_argument "wrong communication command")
        ~description:
          "Validated thread.pin_message arguments; domain preparation validates live \
           references and transitions." )
  ; ( "team.put"
    , Request_codec.map
        (Request_codec.object_
           (Fields.required ~raw:(reference team_id) "team_id" team_id
            ++ Fields.required "expected_revision" decimal
            ++ Fields.required "title" title
            ++ Fields.optional
                 ~raw:(Api_codec.as_json (Api_codec.list raw_recipient ~max_items:1000))
                 "members"
                 (Api_codec.list Communication_recipient.codec ~max_items:1000)))
        ~decode:(fun (((id, expected_revision), title), members) ->
          let members = Option.value members ~default:[] in
          Ok (Team_put { id; expected_revision; title; members }))
        ~encode:(function
          | Team_put { id; expected_revision; title; members } ->
            ((id, expected_revision), title), Some members
          | Board_put _
          | Thread_put _
          | Thread_attach _
          | Thread_pin_message _
          | Request_ask _
          | Request_create _
          | Request_acknowledge _
          | Request_accept _
          | Request_reassign _
          | Request_resolve _
          | Request_cancel _
          | Subscription_put _
          | Inbox_ack _ -> Json.fail Invalid_argument "wrong communication command")
        ~description:
          "Validated team.put arguments; domain preparation validates live references \
           and transitions." )
  ; ( "request.ask"
    , Request_codec.map
        ~validate_raw:validate_request_recipients
        (Request_codec.object_
           (Fields.required "request_id" request_id
            ++ Fields.required "title" title
            ++ Fields.required "body" body
            ++ Fields.required
                 ~raw:(Api_codec.as_json (Api_codec.list raw_recipient ~max_items:1000))
                 "recipients"
                 (Api_codec.list Communication_recipient.codec ~max_items:1000)
            ++ Fields.required "resolver_id" actor_id
            ++ Fields.optional ~raw:(reference ticket_id) "ticket_id" ticket_id
            ++ Fields.optional "kind" Communication_wire.request_kind))
        ~decode:(fun ((((((id, title), body), recipients), resolver), ticket), kind) ->
          if List.is_empty recipients
          then Error (Problem.create Invalid_argument "request requires recipients")
          else
            Ok
              (Request_ask
                 { id
                 ; title
                 ; body
                 ; recipients
                 ; resolver
                 ; ticket
                 ; kind = Option.value kind ~default:Clarification
                 }))
        ~encode:(function
          | Request_ask { id; title; body; recipients; resolver; ticket; kind } ->
            (((((id, title), body), recipients), resolver), ticket), Some kind
          | Board_put _
          | Thread_put _
          | Thread_attach _
          | Thread_pin_message _
          | Team_put _
          | Request_create _
          | Request_acknowledge _
          | Request_accept _
          | Request_reassign _
          | Request_resolve _
          | Request_cancel _
          | Subscription_put _
          | Inbox_ack _ -> Json.fail Invalid_argument "wrong communication command")
        ~description:
          "Atomically create a scoped thread, authored question and accountable request."
    )
  ; ( "request.create"
    , Request_codec.map
        ~validate_raw:validate_request_recipients
        (Request_codec.object_
           (Fields.required "request_id" request_id
            ++ Fields.required ~raw:(reference thread_id) "thread_id" thread_id
            ++ Fields.required "kind" Communication_wire.request_kind
            ++ Fields.required ~raw:(reference comment_id) "comment_id" comment_id
            ++ Fields.optional
                 ~raw:(Api_codec.as_json (Api_codec.list raw_recipient ~max_items:1000))
                 "recipients"
                 (Api_codec.list Communication_recipient.codec ~max_items:1000)
            ++ Fields.optional
                 ~raw:
                   (Api_codec.as_json
                      (Api_codec.list (Api_codec.reference team_id) ~max_items:1000))
                 "teams"
                 (Api_codec.list team_id ~max_items:1000)
            ++ Fields.required "resolver_id" actor_id
            ++ Fields.optional "correlation_id" correlation
            ++ Fields.optional
                 ~raw:(reference request_id)
                 "reply_to_request_id"
                 request_id
            ++ Fields.optional "deadline_unix_ms" unix_ms))
        ~decode:
          (fun
            ( ( ( ((((((id, thread), kind), message), recipients), teams), resolver)
                , correlation_id )
              , reply_to )
            , deadline_unix_ms ) ->
          let recipients = Option.value recipients ~default:[] in
          let teams = Option.value teams ~default:[] in
          if List.is_empty recipients && List.is_empty teams
          then
            Error (Problem.create Invalid_argument "request requires recipients or teams")
          else
            Ok
              (Request_create
                 { id
                 ; thread
                 ; kind
                 ; message
                 ; recipients
                 ; teams
                 ; resolver
                 ; correlation_id
                 ; reply_to
                 ; deadline_unix_ms
                 }))
        ~encode:(function
          | Request_create
              { id
              ; thread
              ; kind
              ; message
              ; recipients
              ; teams
              ; resolver
              ; correlation_id
              ; reply_to
              ; deadline_unix_ms
              } ->
            ( ( ( ( (((((id, thread), kind), message), Some recipients), Some teams)
                  , resolver )
                , correlation_id )
              , reply_to )
            , deadline_unix_ms )
          | Board_put _
          | Thread_put _
          | Thread_attach _
          | Thread_pin_message _
          | Team_put _
          | Request_ask _
          | Request_acknowledge _
          | Request_accept _
          | Request_reassign _
          | Request_resolve _
          | Request_cancel _
          | Subscription_put _
          | Inbox_ack _ -> Json.fail Invalid_argument "wrong communication command")
        ~description:
          "Validated request.create arguments; domain preparation validates live \
           references and transitions." )
  ; ( "request.acknowledge"
    , Request_codec.map
        (Request_codec.object_
           (Fields.required ~raw:(reference request_id) "request_id" request_id
            ++ Fields.required "expected_revision" decimal
            ++ Fields.required
                 ~raw:raw_recipient
                 "recipient"
                 Communication_recipient.codec))
        ~decode:(fun ((id, expected_revision), recipient) ->
          Ok (Request_acknowledge { id; expected_revision; recipient }))
        ~encode:(function
          | Request_acknowledge { id; expected_revision; recipient } ->
            (id, expected_revision), recipient
          | Board_put _
          | Thread_put _
          | Thread_attach _
          | Thread_pin_message _
          | Team_put _
          | Request_ask _
          | Request_create _
          | Request_accept _
          | Request_reassign _
          | Request_resolve _
          | Request_cancel _
          | Subscription_put _
          | Inbox_ack _ -> Json.fail Invalid_argument "wrong communication command")
        ~description:
          "Validated request.acknowledge arguments; domain preparation validates live \
           references and transitions." )
  ; ( "request.accept"
    , Request_codec.map
        (Request_codec.object_
           (Fields.required ~raw:(reference request_id) "request_id" request_id
            ++ Fields.required "expected_revision" decimal
            ++ Fields.required
                 ~raw:raw_recipient
                 "recipient"
                 Communication_recipient.codec))
        ~decode:(fun ((id, expected_revision), recipient) ->
          Ok (Request_accept { id; expected_revision; recipient }))
        ~encode:(function
          | Request_accept { id; expected_revision; recipient } ->
            (id, expected_revision), recipient
          | Board_put _
          | Thread_put _
          | Thread_attach _
          | Thread_pin_message _
          | Team_put _
          | Request_ask _
          | Request_create _
          | Request_acknowledge _
          | Request_reassign _
          | Request_resolve _
          | Request_cancel _
          | Subscription_put _
          | Inbox_ack _ -> Json.fail Invalid_argument "wrong communication command")
        ~description:
          "Validated request.accept arguments; domain preparation validates live \
           references and transitions." )
  ; ( "request.reassign"
    , Request_codec.map
        (Request_codec.object_
           (Fields.required ~raw:(reference request_id) "request_id" request_id
            ++ Fields.required "expected_revision" decimal
            ++ Fields.optional
                 ~raw:(Api_codec.as_json (Api_codec.nullable raw_recipient))
                 "recipient"
                 (Api_codec.nullable Communication_recipient.codec)))
        ~decode:(fun ((id, expected_revision), recipient) ->
          let recipient = Option.join recipient in
          Ok (Request_reassign { id; expected_revision; recipient }))
        ~encode:(function
          | Request_reassign { id; expected_revision; recipient } ->
            (id, expected_revision), Some recipient
          | Board_put _
          | Thread_put _
          | Thread_attach _
          | Thread_pin_message _
          | Team_put _
          | Request_ask _
          | Request_create _
          | Request_acknowledge _
          | Request_accept _
          | Request_resolve _
          | Request_cancel _
          | Subscription_put _
          | Inbox_ack _ -> Json.fail Invalid_argument "wrong communication command")
        ~description:
          "Validated request.reassign arguments; domain preparation validates live \
           references and transitions." )
  ; ( "request.resolve"
    , Request_codec.map
        (Request_codec.object_
           (Fields.required ~raw:(reference request_id) "request_id" request_id
            ++ Fields.required "expected_revision" decimal
            ++ Fields.optional "body" body))
        ~decode:(fun ((id, expected_revision), body) ->
          Ok (Request_resolve { id; expected_revision; body }))
        ~encode:(function
          | Request_resolve { id; expected_revision; body } ->
            (id, expected_revision), body
          | Board_put _
          | Thread_put _
          | Thread_attach _
          | Thread_pin_message _
          | Team_put _
          | Request_ask _
          | Request_create _
          | Request_acknowledge _
          | Request_accept _
          | Request_reassign _
          | Request_cancel _
          | Subscription_put _
          | Inbox_ack _ -> Json.fail Invalid_argument "wrong communication command")
        ~description:
          "Validated request.resolve arguments; domain preparation validates live \
           references and transitions." )
  ; ( "request.cancel"
    , Request_codec.map
        (Request_codec.object_
           (Fields.required ~raw:(reference request_id) "request_id" request_id
            ++ Fields.required "expected_revision" decimal))
        ~decode:(fun (id, expected_revision) ->
          Ok (Request_cancel { id; expected_revision }))
        ~encode:(function
          | Request_cancel { id; expected_revision } -> id, expected_revision
          | Board_put _
          | Thread_put _
          | Thread_attach _
          | Thread_pin_message _
          | Team_put _
          | Request_ask _
          | Request_create _
          | Request_acknowledge _
          | Request_accept _
          | Request_reassign _
          | Request_resolve _
          | Subscription_put _
          | Inbox_ack _ -> Json.fail Invalid_argument "wrong communication command")
        ~description:
          "Validated request.cancel arguments; domain preparation validates live \
           references and transitions." )
  ; ( "subscription.put"
    , Request_codec.map
        (Request_codec.object_
           (Fields.required
              ~raw:(reference subscription_id)
              "subscription_id"
              subscription_id
            ++ Fields.required "expected_revision" decimal
            ++ Fields.required
                 ~raw:raw_recipient
                 "recipient"
                 Communication_recipient.codec
            ++ Fields.required ~raw:raw_filter "filter" Communication_wire.filter_input
            ++ Fields.required "active" Api_codec.boolean))
        ~decode:(fun ((((id, expected_revision), recipient), filter), active) ->
          Ok (Subscription_put { id; expected_revision; recipient; filter; active }))
        ~encode:(function
          | Subscription_put { id; expected_revision; recipient; filter; active } ->
            (((id, expected_revision), recipient), filter), active
          | Board_put _
          | Thread_put _
          | Thread_attach _
          | Thread_pin_message _
          | Team_put _
          | Request_ask _
          | Request_create _
          | Request_acknowledge _
          | Request_accept _
          | Request_reassign _
          | Request_resolve _
          | Request_cancel _
          | Inbox_ack _ -> Json.fail Invalid_argument "wrong communication command")
        ~description:
          "Validated subscription.put arguments; domain preparation validates live \
           references and transitions." )
  ; ( "inbox.ack"
    , Request_codec.map
        (Request_codec.of_codec Communication_inbox.Ack.codec)
        ~decode:(fun ack -> Ok (Inbox_ack ack))
        ~encode:(function
          | Inbox_ack ack -> ack
          | Board_put _
          | Thread_put _
          | Thread_attach _
          | Thread_pin_message _
          | Team_put _
          | Request_ask _
          | Request_create _
          | Request_acknowledge _
          | Request_accept _
          | Request_reassign _
          | Request_resolve _
          | Request_cancel _
          | Subscription_put _ -> Json.fail Invalid_argument "wrong communication command")
        ~description:"Explicit selected consumer acknowledgements." )
  ]
;;

let methods = List.map entries ~f:fst

let request_codec ~method_ =
  Option.map (List.Assoc.find entries method_ ~equal:String.equal) ~f:(fun codec ->
    Api_codec.as_json codec.Request_codec.value)
;;

let decode ~method_ ~params =
  match List.Assoc.find entries method_ ~equal:String.equal with
  | None -> Error (Problem.create Invalid_argument "unknown communication mutation")
  | Some codec -> Api_codec.decode codec.Request_codec.value params
;;

let encode command =
  let method_ =
    match command with
    | Board_put _ -> "board.put"
    | Thread_put _ -> "thread.put"
    | Thread_attach _ -> "thread.attach"
    | Thread_pin_message _ -> "thread.pin_message"
    | Team_put _ -> "team.put"
    | Request_ask _ -> "request.ask"
    | Request_create _ -> "request.create"
    | Request_acknowledge _ -> "request.acknowledge"
    | Request_accept _ -> "request.accept"
    | Request_reassign _ -> "request.reassign"
    | Request_resolve _ -> "request.resolve"
    | Request_cancel _ -> "request.cancel"
    | Subscription_put _ -> "subscription.put"
    | Inbox_ack _ -> "inbox.ack"
  in
  let codec = List.Assoc.find_exn entries method_ ~equal:String.equal in
  Result.map (Api_codec.encode codec.Request_codec.value command) ~f:(fun params ->
    method_, params)
;;

let raw_request_codec ~method_ =
  Option.map (List.Assoc.find entries method_ ~equal:String.equal) ~f:(fun codec ->
    Api_codec.as_json codec.Request_codec.raw)
;;
