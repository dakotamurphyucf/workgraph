open Core

(** Private pure application of resolved changes. Individual applications may
    yield a staged graph; only replay validates a whole transaction, binds its
    attribution/evidence and creates its audit entry. Invariant failures in
    apply_event raise Json.Decode_error. replay returns expected failures. *)
val apply_event : Planning_state.t -> Planning_state.Event.t -> Planning_state.t

val replay : Planning_state.t -> Jsonaf.t -> (Planning_state.t, Problem.t) Result.t
