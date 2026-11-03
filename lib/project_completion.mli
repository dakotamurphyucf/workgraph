open Core

(** Pure project completion capture. Inputs come from one immutable planning
    state; no I/O, implicit child transition or process-liveness inference occurs. *)
module Ticket : sig
  type t =
    { id : Id.Ticket.t
    ; status : Workflow.Category.t
    ; archived : bool
    ; claimed : bool
    ; active_attempts : Attempt.Id.t list
    ; completion_problem : Problem.t option
    }
end

module Milestone : sig
  type t =
    { id : Id.Milestone.t
    ; status : Workflow.Category.t
    ; archived : bool
    }
end

module Counts : sig
  type t =
    { tickets : int
    ; done_tickets : int
    ; canceled_tickets : int
    ; unfinished_tickets : int
    ; archived_tickets : int
    ; claimed_tickets : int
    ; active_attempts : int
    ; gated_tickets : int
    ; milestones : int
    ; unfinished_milestones : int
    ; archived_milestones : int
    ; open_requests : int
    }

  val codec : t Api_codec.t
end

module Blocker : sig
  module Ticket_reason : sig
    type t =
      | Unfinished of Workflow.Category.t
      | Claimed
      | Active_attempt of Attempt.Id.t
      | Completion_gate of Problem.t
  end

  type t =
    | Ticket of
        { ticket_id : Id.Ticket.t
        ; reasons : Ticket_reason.t list
        }
    | Milestone of
        { milestone_id : Id.Milestone.t
        ; status : Workflow.Category.t
        }

  val codec : t Api_codec.t
end

type t

(** Done and Canceled are terminal; cancellations are counted distinctly and do
    not satisfy ticket prerequisites. Archived unfinished members still block.
    Claims, active attempts and failed current Done-ticket completion gates also
    block. Open requests are observational, never resolved or acknowledged here.
    Duplicate ticket/milestone/attempt identities, more than one active attempt
    per ticket and invalid counters reject. *)
val create
  :  project:Id.Project.t
  -> project_revision:int
  -> workspace_revision:int
  -> status:Workflow.Category.t
  -> tickets:Ticket.t list
  -> milestones:Milestone.t list
  -> open_requests:int
  -> (t, Problem.t) Result.t

val project : t -> Id.Project.t
val project_revision : t -> int
val workspace_revision : t -> int
val status : t -> Workflow.Category.t
val counts : t -> Counts.t

(** Ticket blockers in ticket-ID order followed by milestone blockers in
    milestone-ID order. Each ticket has one row with all its exact reasons. *)
val blockers : t -> Blocker.t list

val can_complete : t -> bool
val ensure_can_complete : t -> (unit, Problem.t) Result.t

module Handoff : sig
  (** Structured completion handoff, with the same input fields and omitted-field
      preservation rules as ticket.finish. Attribution is the committing caller;
      coverage is an explicitly observed workspace revision, not save time. *)
  type t

  val create
    :  previous:t option
    -> patch:Ticket_lifecycle.Handoff.t
    -> evidence:string
    -> actor:Id.Actor.t
    -> run:Id.Run.t option
    -> timestamp:string
    -> project_revision:int
    -> workspace_revision:int
    -> (t, Problem.t) Result.t

  val resource_ids : t -> Id.Resource.t list
  val covers_through : t -> int
  val project_revision : t -> int
  val codec : t Api_codec.t
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t
  val sexp_of_t : t -> Sexp.t
  val t_of_sexp : Sexp.t -> t
end

(** Guarded project finish command. Evidence must be nonblank and the structured
    handoff follows ticket-finish patch semantics. *)
module Command : sig
  type t =
    { project : Id.Project.t
    ; expected_revision : int
    ; evidence : string
    ; handoff : Ticket_lifecycle.Handoff.t
    }
  [@@deriving sexp]

  val codec : t Api_codec.t
end
