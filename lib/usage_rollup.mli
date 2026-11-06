open Core

module Ticket : sig
  (** Captured current membership, never inferred report-time membership. *)
  type t =
    { id : Id.Ticket.t
    ; project : Id.Project.t option
    ; milestone : Id.Milestone.t option
    }
end

(** Pure current-capture rollup over immutable usage IDs. Run-scoped spending is
    never allocated to tickets/projects/milestones; unassigned spending is explicit.
    Caller must not report one provider sample under two distinct usage IDs.
    Default row layout retains separate metric rows. Nested metrics are returned
    as whole groups, never clipped; totals-only groups omit metric detail.
    Continuations bind normalized selectors/layout, current revision and lineage;
    callers may change limit/byte budget without changing the captured query. *)
val read
  :  workspace:Id.Workspace.t
  -> revision:int
  -> activity:Jsonaf.t list
  -> reports:Usage_record.t list
  -> runs:Agent_run.t
  -> tickets:Ticket.t list
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t
