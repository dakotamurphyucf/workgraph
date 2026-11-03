open Core

(** Bounded resulting run state captured by one durable mutation. The revision
    belongs to this run, independently of workspace and coordination captures.
    This value is the original committed result, never refreshed from current
    state during retry, replay or restore. It does not include objective/evidence
    text or infer process liveness from a reported lifecycle state. *)
type t

(** Validate the source record before taking its bounded state projection. *)
val of_record : Agent_run_event.Record.t -> (t, Problem.t) Result.t

val run : t -> Id.Run.t
val revision : t -> int
val status : t -> Agent_run_event.Status.t
val actor : t -> Id.Actor.t
val last_observed_unix_ms : t -> int64 option
val sessions : t -> Session_id.t list

(** Positive run revision, nonnegative optional UTC milliseconds, unique exact
    session IDs (<=100), actual public run status and owner actor ID. Public
    decoding enforces the same projection invariants as [of_record]. *)
val codec : t Api_codec.t

val to_json : t -> Jsonaf.t
