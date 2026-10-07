open Core
module Recipient = Communication_event.Recipient
module Scope = Communication_event.Scope
module Board = Communication_event.Board
module Thread = Communication_event.Thread
module Team = Communication_event.Team
module Request = Communication_event.Request
module Notification = Communication_event.Notification
module Subscription = Communication_event.Subscription
module Change = Communication_event

module Command : sig
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
    | Inbox_mark_read of
        { recipient : Recipient.t
        ; through : int
        }
  [@@deriving sexp]
end

type t
type prepared

val empty : t
val revision : t -> int

val prepare
  :  t
  -> Command.t
  -> actor:Id.Actor.t
  -> run:Id.Run.t option
  -> timestamp:string
  -> sequence:int
  -> (prepared, Problem.t) Result.t

val candidate : prepared -> t
val changes : prepared -> Change.t list
val result : prepared -> Jsonaf.t

(** Replay validates version, consecutive entity/activity counters, immutable
    references, lifecycle transitions and exact frozen notification deliveries.
    Only expected domain failures are returned. Input state remains immutable. *)
val apply : t -> Change.t -> (t, Problem.t) Result.t

(** Validate external entity and discussion references against a final staged
    state. Thread messages must target the board scope. *)
val validate_references
  :  t
  -> entity_exists:(Entity_ref.t -> bool)
  -> discussion:Discussion.t
  -> (unit, Problem.t) Result.t

(** Audit targets captured from old/new metadata and board scopes. The receiver
    is the state preceding this resolved change. *)
val change_targets : t -> Change.t -> Entity_ref.t list

val get_board : t -> Communication_id.Board.t -> Board.t option

(** Resolve the existing discussion target for a thread.reply composition. *)
val thread_target : t -> Communication_id.Thread.t -> (Entity_ref.t, Problem.t) Result.t

val get_thread : t -> Communication_id.Thread.t -> Thread.t option
val get_request : t -> Communication_id.Request.t -> Request.t option
val request_history : t -> Communication_id.Request.t -> Request.t list
val thread_history : t -> Communication_id.Thread.t -> Thread.t list

val inbox
  :  t
  -> recipient:Recipient.t
  -> after:int
  -> through:int option
  -> Notification.t list

val inbox_position : t -> Recipient.t -> int
val latest_serial : t -> int

(** Listing is ID ordered; inbox notifications are activity ordered. JSON queries
    use 50 items by default, at most 100, and a 4KiB..1MiB byte budget. Offsets
    require the observed revision; inbox captures use fixed upper serials. *)
val query : t -> method_:string -> params:Jsonaf.t -> (Jsonaf.t, Problem.t) Result.t

val decode : method_:string -> params:Jsonaf.t -> (Command.t, Problem.t) Result.t
val mutation_methods : string list
val query_methods : string list
val to_json : t -> Jsonaf.t

(** Produce wire parameters then validate them through [decode]. *)
val encode : Command.t -> (string * Jsonaf.t, Problem.t) Result.t

(** Current immutable records in ID order for coordinator views. *)
val boards : t -> Board.t list

val threads : t -> Thread.t list
val requests : t -> Request.t list
