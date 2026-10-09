open! Core

(** Read-only current metadata for deterministic local coordination views.
    Readiness and blockers come from State's authoritative graph rules. *)
module Claim : sig
  type t =
    { actor : Id.Actor.t
    ; run : Id.Run.t option
    ; token : int
    ; lease : Allocation_lease.t
    }
end

module Ticket : sig
  type t =
    { id : Id.Ticket.t
    ; project : Id.Project.t option
    ; title : string
    ; status : Domain_command.Status.t
    ; prerequisites : Id.Ticket.t list
    ; ready : bool
    ; blockers : Planning_ticket_wire.Readiness.t
    ; claim : Claim.t option
    }
end

(** Current immutable capture. Cursor pages bind workspace/revision, selected
    filters and the first page's clock. Changed revisions require an explicit
    rescan; time cannot reorder a captured page. Limits default to 50 items and
    64KiB, maximum 100 items and 1MiB. Whole items are retained with stable source
    references. Without a run filter [ready_work] means graph-ready and unclaimed.
    With a run filter it means allocatable by that registered run using the same
    capability, pool, lifecycle and attempt-budget rules as claim-next;
    [allocation_blocked] explains graph-ready unclaimed tickets rejected by those
    rules. Unknown run filters return [Not_found]. These views do not claim work
    or predict claim-next ordering. An item which cannot fit returns the same cursor position and
    [needs_larger_budget], never skips it. No process or duration is inferred. *)
val read
  :  workspace:Id.Workspace.t
  -> revision:int
  -> head:string option
  -> tickets:Ticket.t list
  -> runs:Agent_run.t
  -> evidence:Evidence.t
  -> communication:Communication.t
  -> policies:Agent_run_policy.t
  -> heartbeats:(Id.Run.t * int64) list
  -> now_unix_ms:int64
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t
