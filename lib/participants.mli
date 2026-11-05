open Core

(** Pure projection of the immutable catalog and retained attributed audit.
    No durable schema/index is introduced. Same-revision paging survives replay;
    stale revisions fail Conflict. Observations record past writes, not liveness.
    Byte budgets measure the complete public Planning_read envelope. *)
val read : Planning_state.t -> Participant_api.Request.t -> (Jsonaf.t, Problem.t) Result.t
