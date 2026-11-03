open Core

(** Private pure resolved-event projection. Never replays prior workspace states.
    Current eligible-work is composed through Coordinator using this capture's
    authoritative readiness and separately paginated current semantics. Durable
    relevance uses only a frozen through routing index of membership/dependency
    IDs, pool names and required path declarations; later graph/policy changes
    cannot insert/remove old rows or shift a continuation's position. *)
val read
  :  Planning_state.t
  -> now_unix_ms:int64
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t

val has_attention : Jsonaf.t -> bool
