open Core

(** Private pure resolved-event projection. Never replays prior workspace states.
    Current eligible-work is composed through Coordinator using this capture's
    authoritative readiness and separately paginated current semantics. *)
val read
  :  Planning_state.t
  -> now_unix_ms:int64
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t

val has_attention : Jsonaf.t -> bool
