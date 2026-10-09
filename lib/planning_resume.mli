open Core

(** PRIVATE builder over one immutable planning snapshot. It selects canonical
    typed domain records/actual public codecs; no filesystem, model, prompt,
    query event or mutable rendered cache. Prefix excerpts retain source refs and
    byte counts; whole facts/pins/leases preserve identity and semantics. *)
type t

val build
  :  ?now_unix_ms:int64
  -> Planning_state.t
  -> Resume_api.Resume_request.t
  -> (t, Problem.t) Result.t

val to_json : t -> Jsonaf.t
val markdown : t -> string

(** Same fitted structured data and Markdown, measured against final
    Planning_read envelope; no generic clipping of arbitrary domain objects.
    Task description and current handoff prose expand into remaining budget after
    section/change selection. Markdown renders a retained current handoff once;
    structured history, coverage, cursors and omission counts are unchanged. *)
val result : t -> Jsonaf.t
