open Core

(** Public scalar and record codecs. Persisted derived representations remain
    independent. Record decoders run the domain's snapshot validation too. *)
val status : Agent_run_event.Status.t Api_codec.t

val parent_stop_policy : Agent_run_event.Parent_stop_policy.t Api_codec.t
val attempt_state : Attempt.State.t Api_codec.t
val reservation_mode : Reservation.Mode.t Api_codec.t
val checkpoint : Attempt.Checkpoint.t Api_codec.t
val run : Agent_run_event.Record.t Api_codec.t
val attempt : Attempt.t Api_codec.t
val reservation : Reservation.t Api_codec.t
val action : Agent_run_event.Runner_action.t Api_codec.t
val pool : Allocation.Definition.t Api_codec.t
val ticket_policy : Allocation.Ticket_policy.t Api_codec.t

(** Shared exact public holder codec for named and path reservations. *)
val holder : Reservation.Holder.t Api_codec.t

(** Shared existing exact fenced lease declaration. *)
val lease : Allocation_lease.t Api_codec.t
