open Core

(** Private unpublished transaction candidate, resolved events and referenced
    blobs. prepare stages all commands, validates final references and independently
    replays the resolved events. It performs no I/O or publication. *)
type t

module Observation : sig
  type t

  val workspace_revision : t -> int
  val result : t -> Jsonaf.t
end

module Submission : sig
  type prepared = t

  type t =
    | Prepared of prepared
    | Observed of Observation.t
end

val prepare
  :  Planning_state.t
  -> ?run:Id.Run.t
  -> ?now_unix_ms:int64
  -> Domain_command.t
  -> actor:Id.Actor.t
  -> timestamp:string
  -> (t, Problem.t) Result.t

(** Stage once at an immutable capture. Only a standalone empty allocation is
    [Observed], before constructing/admitting a durable candidate. Explicit
    batches, including empty allocations, retain [prepare]'s durable semantics. *)
val prepare_submission
  :  Planning_state.t
  -> ?run:Id.Run.t
  -> ?now_unix_ms:int64
  -> Domain_command.t
  -> actor:Id.Actor.t
  -> timestamp:string
  -> (Submission.t, Problem.t) Result.t

val candidate : t -> Planning_state.t
val events : t -> Jsonaf.t
val result : t -> Jsonaf.t
val blobs : t -> (string * string) list
val required_blobs : t -> (string * int option) list
