open Core
module Recipient = Communication_event.Recipient
module Scope = Communication_event.Scope
module Board = Communication_event.Board
module Thread = Communication_event.Thread
module Team = Communication_event.Team
module Request = Communication_event.Request
module Message = Communication_event.Message
module Notification = Communication_event.Notification
module Subscription = Communication_event.Subscription
module Change = Communication_event

module Message_send : sig
  (** A stable message operation. Bodies are nonblank UTF-8 up to 64KiB; at least
      one direct recipient or team is required. [prepare_message] validates even
      records constructed directly. Metadata pins the initial authored comment
      revision, so subsequent comment edits never change delivered message bytes. *)
  type t =
    { message_id : Communication_id.Message.t
    ; body : string
    ; ticket_id : Id.Ticket.t option
    ; recipients : Recipient.t list
    ; teams : Communication_id.Team.t list
    ; reply_to_message_id : Communication_id.Message.t option
    ; correlation_id : string option
    }
  [@@deriving sexp]

  val codec : t Api_codec.t
  val receipt_codec : Jsonaf.t Api_codec.t
end

val message_method : (Message_send.t, Jsonaf.t) Api_method.t

module Command = Communication_command

type t
type prepared

val empty : t
val revision : t -> int

(** Single communication publication. Commands composing authored discussion
    ([Request_ask] and resolution with a body) require [State.prepare] and are
    rejected here rather than partially prepared. *)
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

module Message_prepared : sig
  type state = t

  type change =
    | Discussion_change of Discussion.Change.t
    | Communication_change of Change.t

  type t

  val candidate : t -> state
  val discussion : t -> Discussion.t
  val changes : t -> change list
  val result : t -> Jsonaf.t
end

(** Pure atomic composition, ordered authored-comment creation then frozen
    communication publication. One initial comment version is referenced by the
    message; no board/thread is manufactured. Input snapshots remain immutable. *)
val prepare_message
  :  t
  -> Message_send.t
  -> discussion:Discussion.t
  -> actor:Id.Actor.t
  -> run:Id.Run.t option
  -> timestamp:string
  -> sequence:int
  -> (Message_prepared.t, Problem.t) Result.t

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
val get_message : t -> Communication_id.Message.t -> Message.t option
val request_history : t -> Communication_id.Request.t -> Request.t list
val thread_history : t -> Communication_id.Thread.t -> Thread.t list

val inbox
  :  t
  -> consumer_id:Communication_id.Consumer.t
  -> recipient:Recipient.t
  -> after:int
  -> through:int option
  -> Notification.t list

val acknowledged : t -> Communication_id.Consumer.t -> Recipient.t -> Int.Set.t
val latest_serial : t -> int

(** Listing is ID ordered; inbox notifications are activity ordered. JSON queries
    use 50 items by default, at most 100, and a 4KiB..1MiB byte budget. Offsets
    require the observed revision; inbox captures use fixed upper serials.
    [discussion] must be the immutable discussion snapshot paired with [t].
    thread.get/request.get optionally include current message bodies and exact
    source revisions. request.get also exposes the current thread_revision,
    separately from the request record revision and communication revision.
    request.list ticket_id and resolver_id filters apply before pagination.
    Later offset pages guard both communication revision and
    discussion serial; tombstones remain present and budget omissions are explicit. *)
val query
  :  t
  -> discussion:Discussion.t
  -> method_:string
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t

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
