open Core

(** Canonical public ticket/ownership/handoff records. Durable planning events use
    their independent private codecs. Public descriptions may be fitted with
    disclosed omissions; counters, identities, status, membership, ownership,
    timestamps, lease boundaries and audit reasons remain exact. *)
module Lease : sig
  type t =
    { epoch : int
    ; revision : int
    ; duration_ms : int64 option
    ; last_unix_ms : int64
    ; deadline_unix_ms : int64 option
    }

  val codec : t Api_codec.t
  val of_domain : Allocation_lease.t -> t
end

module Ownership : sig
  type t =
    { actor_id : Id.Actor.t
    ; run_id : Id.Run.t option
    ; token : int
    ; lease : Lease.t
    }

  val codec : t Api_codec.t
end

module Hold : sig
  type t =
    { actor_id : Id.Actor.t
    ; reason : string
    ; timestamp : string
    }

  val codec : t Api_codec.t
end

module Waiver : sig
  type t =
    { prerequisite_ticket_id : Id.Ticket.t
    ; actor_id : Id.Actor.t
    ; reason : string
    ; timestamp : string
    }

  val codec : t Api_codec.t
end

module Reassessment : sig
  type t =
    { prerequisite_ticket_id : Id.Ticket.t
    ; reopened_revision : int
    ; reason : string
    ; actor_id : Id.Actor.t
    ; timestamp : string
    }

  val codec : t Api_codec.t
end

module Ticket : sig
  type t =
    { ticket_id : Id.Ticket.t
    ; display_key : string
    ; title : string
    ; description : string
    ; project_id : Id.Project.t option
    ; membership_revision : int
    ; parent_ticket_id : Id.Ticket.t option
    ; milestone_id : Id.Milestone.t option
    ; archived : bool
    ; status_id : Id.Status.t option
    ; priority : int
    ; assignee_id : Id.Actor.t option
    ; label_ids : Id.Label.t list
    ; acceptance_criteria : string
    ; status : Workflow.Category.t
    ; revision : int
    ; hold : Hold.t option
    ; waivers : Waiver.t list
    ; prerequisite_ticket_ids : Id.Ticket.t list
    ; related_ticket_ids : Id.Ticket.t list
    ; claim : Ownership.t option
    ; created_order : int
    ; reopened_token : int option
    ; reassessments : Reassessment.t list
    ; created_sequence : int
    ; created_at : string
    ; updated_at : string
    ; next_token : int
    }

  val codec : t Api_codec.t
end

module Handoff : sig
  type t =
    { ticket_id : Id.Ticket.t
    ; actor_id : Id.Actor.t
    ; summary : string
    ; next_steps : string
    ; evidence : string
    ; revision : int
    ; objective : string
    ; completed : string
    ; decisions : string
    ; blockers : string
    ; resource_ids : Id.Resource.t list
    ; timestamp : string
    ; covers_through : int
    }

  val codec : t Api_codec.t
end

module Completion : sig
  module Check : sig
    type kind =
      | Hold
      | Prerequisites
      | Children
      | Configured_policy

    type t =
      { kind : kind
      ; passed : bool
      }
  end

  type t =
    { can_complete : bool
    ; checks : Check.t list
    ; policy : Acceptance_policy.Effective.t
    ; blocked_prerequisite_count : int
    ; unfinished_child_count : int
    ; blocked_prerequisite_ids : Id.Ticket.t list
    ; unfinished_child_ids : Id.Ticket.t list
    ; problem : Problem.t option
    }

  val codec : t Api_codec.t
end

module Readiness : sig
  module Reason : sig
    type t =
      | Archived_scope
      | Status of Workflow.Category.t
      | Hold of Hold.t
      | Claimed of
          { details : Ownership.t
          ; revision : int
          }
      | Prerequisite of Id.Ticket.t
      | Coordination of Agent_run.Start_blocker.t
      | Observation_time_required of Path_scope.t

    val codec : t Api_codec.t
  end

  type t =
    { ready : bool
    ; reasons : Reason.t list
    ; reason_count : int
    ; reassessments : Reassessment.t list
    ; completion : Completion.t
    }

  val codec : t Api_codec.t
end

module Summary : sig
  type t =
    { ticket_id : Id.Ticket.t
    ; display_key : string
    ; title : string
    ; revision : int
    ; status : Workflow.Category.t
    ; priority : int
    ; readiness : Readiness.t
    }

  val codec : t Api_codec.t
end

(** Shared existing Problem and readiness coordination case declarations. *)
val problem_codec : Problem.t Api_codec.t

val start_blocker_codec : Agent_run.Start_blocker.t Api_codec.t
