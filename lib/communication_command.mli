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

val decode : method_:string -> params:Jsonaf.t -> (t, Problem.t) Result.t
val encode : t -> (string * Jsonaf.t, Problem.t) Result.t
val methods : string list
val request_codec : method_:string -> Jsonaf.t Api_codec.t option

(** Raw transaction fields preserve declared ID references as literal-or-alias
    strings. Opaque text is not inspected or rewritten. Resolve aliases by
    entity kind before calling [decode]; standalone commands use [request_codec]. *)
val raw_request_codec : method_:string -> Jsonaf.t Api_codec.t option
