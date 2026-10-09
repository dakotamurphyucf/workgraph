open Core

module Query : sig
  (** Read-only enumeration of unread notifications for this exact consumer and
      recipient. [after]/[through] bound observation; neither acknowledges IDs.
      Filters do not affect acknowledgement state. *)
  type t

  val consumer_id : t -> Communication_id.Consumer.t
  val recipient : t -> Communication_event.Recipient.t
  val after : t -> int
  val through : t -> int option
  val kinds : t -> Communication_event.Notification.Kind.t list option
  val ticket_id : t -> Id.Ticket.t option
  val limit : t -> int
  val max_bytes : t -> int
  val read_codec : t Api_codec.t
  val wait_codec : t Api_codec.t
end

module Ack : sig
  (** Selected stable workspace-local notification serial IDs, 1..100 IDs.
      Preparation validates each was actually addressed to this recipient.
      Acknowledgement never accepts responsibility or resolves a request. *)
  type t =
    { consumer_id : Communication_id.Consumer.t
    ; recipient : Communication_event.Recipient.t
    ; notification_ids : int list
    }
  [@@deriving sexp]

  val codec : t Api_codec.t
  val receipt_codec : Jsonaf.t Api_codec.t
end

(** Canonical public notification packets. Message bodies name the pinned
    initial discussion version; request/thread bodies explicitly name the
    current version. Original and current source revisions remain distinct. *)
val item_codec : Jsonaf.t Api_codec.t

val result_codec : Jsonaf.t Api_codec.t
val read_method : (Query.t, Jsonaf.t) Api_method.t
val wait_method : (Query.t, Jsonaf.t) Api_method.t
val ack_method : (Ack.t, Jsonaf.t) Api_method.t
