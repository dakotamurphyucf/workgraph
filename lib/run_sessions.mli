open Core

(** Metadata-only reverse index over one immutable history capture. Archived
    sessions remain associated. Does not mutate runs, history or receipts. *)
type t

val create : Session_store.Capture.t -> t
val history_head : t -> string option

(** Sorted set union of explicit run links and sessions whose immutable metadata
    names this run. The read preview contains at most 100 IDs. Its additional
    association metadata records the exact history capture, original explicit
    IDs, total/omitted counts and a continuation into the full union.
    The run's revision, stored links and mutation receipts are unchanged. *)
val project : t -> Agent_run_event.Record.t -> (Jsonaf.t, Problem.t) Result.t

(** Bounded whole-ID page over the full union, sorted by session ID. Continuation
    requires an exact history head and run revision; the service resolves that
    head before constructing [t]. The root must remain pinned while resolving
    and reading captures. Rejects unavailable IDs and changed run/capture scope.
    Returns an internal Planning_read result at [workspace_revision]. *)
val read
  :  t
  -> run:Agent_run_event.Record.t
  -> workspace_revision:int
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t

(** Run get/list bridge for the service's pinned history scheduler. Uses the
    existing coordination revision guard for run-list membership and an exact
    history head for derived associations. Returns the existing Domain_record
    Runs / Domain_query Runs internal layouts, with an additional [capture]. *)
val query
  :  t
  -> runs:Agent_run.t
  -> method_:string
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t
