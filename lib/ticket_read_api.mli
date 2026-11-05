open Core

(** Focused complete ticket metadata. Unlike [ticket.brief], prose is not clipped;
    unlike [ticket.context], related histories and coordination records are not
    materialized. The context expansion carries the exact current-workspace guard,
    not a promise of time travel. *)
module Request : sig
  type t

  val ticket : t -> Id.Ticket.t
  val at_revision : t -> int option
  val max_bytes : t -> int
  val codec : t Api_codec.t
end

val method_ : (Request.t, Jsonaf.t) Api_method.t

(** Produce a complete Planning_read result and exact byte metadata. A result
    exceeding [max_bytes] rejects with a structured field diagnostic rather than
    omitting instructions or ownership. Bounds are 4096..1048576 bytes. *)
val response
  :  Planning_ticket_wire.Ticket.t
  -> workspace:Id.Workspace.t
  -> workspace_revision:int
  -> max_bytes:int
  -> (Jsonaf.t, Problem.t) Result.t
