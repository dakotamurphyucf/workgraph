open Core

(** Pure exact traversal of retained audit changes in ascending workspace revision
    and original change ordinal. Captures remain pinned across new commits;
    unavailable/changed lineage and altered selectors reject Conflict. A chunk
    repeats the original source identity and consumes only its returned UTF8 byte
    range. The caller may retain and retry any cursor without mutable server state.
    Work is linear in retained prefix plus selected canonical payload sizes. *)
val read
  :  Planning_state.t
  -> Activity_read_api.Request.t
  -> (Jsonaf.t, Problem.t) Result.t
