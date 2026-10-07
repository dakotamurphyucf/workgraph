open Core

(** A durable workspace feed over retained committed audit records. Cursors bind
    workspace identity, filters and the canonical audit lineage through their
    upper workspace revision. Replaced history returns [Conflict], even if its
    current revision has reached or exceeded the cursor's previous bound.
    Paging retains that upper bound despite new commits. Once consumed, reusing
    the cursor captures the next available range. Actor IDs are attribution.

    [activity] contains immutable audit entries, newest first, each with a
    revision and captured targets. Entries must retain the complete resolved
    changes (planning) or verified batch digest (history), so changed committed
    content changes lineage. Prefix validation is linear in retained entries;
    this function is pure and never waits. *)
val read
  :  workspace:Id.Workspace.t
  -> revision:int
  -> activity:Jsonaf.t list
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t

(** Inspect a successful feed response without interpreting the cursor. *)
val has_items : Jsonaf.t -> bool
