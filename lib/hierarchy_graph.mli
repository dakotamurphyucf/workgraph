open Core

(** Pure hierarchy prerequisite kernel. A source-owner waiver applies only to
    that owner's direct edge. An opted ancestor contributes its own edges to all
    descendants, through independent intermediate parents. Nothing inherits a
    parent's claim, hold, status or unfinished-child gate. *)
module Node : sig
  type t =
    { ticket : Id.Ticket.t
    ; parent : Id.Ticket.t option
    ; prerequisites : Id.Ticket.t list
    ; waived : Id.Ticket.t list
    ; done_ : bool
    ; descendant_prerequisites : Hierarchy_policy.Descendant_prerequisites.t
    }
end

module Blocker : sig
  type t =
    { prerequisite : Id.Ticket.t
    ; ancestor : Id.Ticket.t option
    }
  [@@deriving sexp, equal]
end

type t

(** [find] must read one immutable complete capture. Callback exceptions remain
    exceptions. This kernel grants no ownership and does no I/O. *)
val create : find:(Id.Ticket.t -> Node.t option) -> t

(** Deduplicate unmet conditions by prerequisite ID, sorted by ID. Prefer an own
    unwaived direct edge; otherwise use the nearest unwaived opted ancestor.
    Completed prerequisites satisfy conditions; canceled prerequisites do not. *)
val blockers : t -> ticket:Id.Ticket.t -> (Blocker.t list, Problem.t) Result.t

(** Structural edges include waived and completed prerequisites. Parent and
    effective dependency graphs must both be acyclic. In particular, a parent
    depending on its descendant cannot opt into inheritance: the descendant
    would inherit a self-cycle. Validate after relevant policy/dependency/reparent
    changes and independently during durable replay. [tickets] is the complete
    distinct node inventory; missing references reject. Uses iterative graph
    traversal, O(V + distinct effective edges), plus persistent set/map costs. *)
val validate : t -> tickets:Id.Ticket.t list -> (unit, Problem.t) Result.t
