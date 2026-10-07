open Core

module Control : sig
  type t

  val create : unit -> t

  (** True only when cancellation won before publication. Repeat requests before
      publication are idempotent. A publishing job can no longer be canceled. *)
  val cancel : t -> bool

  val canceled : t -> bool
end

(** Own export domain only. Immutable snapshots and one atomic control cross the
    domain boundary; no mutable Store or registry state does. Single and complete/
    explicitly partial all-workspace exports publish one fresh destination. *)
val run
  :  Export_job.t
  -> fs:_ Eio.Path.t
  -> snapshots:Snapshot.t list
  -> control:Control.t
  -> (unit, Problem.t) Result.t

(** Startup reconciliation. A valid published destination matching the entire
    capture vector becomes Completed after parent sync. Otherwise Interrupted;
    private staging directories are never considered complete. *)
val recover : Export_job.t -> fs:_ Eio.Path.t -> Export_job.t
