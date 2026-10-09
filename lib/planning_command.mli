open Core
module Status = Workflow.Category

type t =
  | Batch of t list
  | Lifecycle of Ticket_lifecycle.Command.t
  | Communication of Communication.Command.t
  | Message_send of Communication.Message_send.t
  | Agent_run of Agent_run.Command.t
  | Facts of Facts.Command.t
  | Evidence of Evidence.Command.t
  | Policy of Agent_run_policy.Command.t
  | Template_instantiate of
      { template : Id.Resource.t
      ; template_revision : int
      ; id : Workflow_template.Instance_id.t
      ; parameters : (string * string) list
      }
  | Claim_next of
      { attempt : Attempt.Id.t
      ; run : Id.Run.t
      ; project : Id.Project.t option
      ; lease_duration_ms : int64 option
      ; leaf_only : bool
      }
  | Thread_reply of
      { id : Communication_id.Thread.t
      ; expected_revision : int
      ; comment_id : Id.Comment.t option
      ; reply_to : Id.Comment.t option
      ; kind : Discussion.Kind.t
      ; body : string
      }
  | Settings_put of Workflow.Change.t
  | Workspace_update of
      { expected_revision : int
      ; name : string option
      ; description : string option
      ; instructions : string option
      ; summary : string option
      ; archived : bool option
      }
  | Ticket_metadata of
      { id : Id.Ticket.t
      ; expected_revision : int
      ; priority : int option
      ; assignee : Id.Actor.t option option
      ; labels : Id.Label.t list option
      ; acceptance_criteria : string option
      ; status_id : Id.Status.t option option
      }
  | Project_create of
      { id : Id.Project.t
      ; title : string
      ; description : string
      }
  | Project_update of
      { id : Id.Project.t
      ; expected_revision : int
      ; title : string option
      ; description : string option
      ; status : Status.t option
      ; priority : int option
      ; summary : string option
      ; acceptance_criteria : string option
      ; archived : bool option
      }
  | Milestone_create of
      { id : Id.Milestone.t
      ; project : Id.Project.t
      ; title : string
      ; description : string
      ; target_date : string option
      }
  | Milestone_update of
      { id : Id.Milestone.t
      ; expected_revision : int
      ; title : string option
      ; description : string option
      ; status : Status.t option
      ; archived : bool option
      }
  | Milestone_schedule of
      { id : Id.Milestone.t
      ; expected_revision : int
      ; target_date : string option
      }
  | Ticket_move of
      { id : Id.Ticket.t
      ; expected_revision : int
      ; project : Id.Project.t option
      ; milestone : Id.Milestone.t option
      ; parent : Id.Ticket.t option
      }
  | Ticket_archive of
      { id : Id.Ticket.t
      ; expected_revision : int
      ; archived : bool
      }
  | Ticket_create of
      { id : Id.Ticket.t
      ; title : string
      ; description : string
      ; project : Id.Project.t option
      ; parent : Id.Ticket.t option
      ; milestone : Id.Milestone.t option
      }
  | Ticket_update of
      { id : Id.Ticket.t
      ; expected_revision : int
      ; title : string option
      ; description : string option
      ; status : Status.t option
      }
  | Ticket_hold of
      { id : Id.Ticket.t
      ; expected_revision : int
      ; reason : string option
      }
  | Dependency_waive of
      { ticket : Id.Ticket.t
      ; prerequisite : Id.Ticket.t
      ; expected_revision : int
      ; reason : string option
      }
  | Ticket_reassign of
      { id : Id.Ticket.t
      ; expected_revision : int
      ; claimant : Id.Actor.t option
      ; claimant_run : Id.Run.t option
      ; reason : string
      }
  | Dependency_add of
      { ticket : Id.Ticket.t
      ; prerequisite : Id.Ticket.t
      }
  | Dependency_remove of
      { ticket : Id.Ticket.t
      ; prerequisite : Id.Ticket.t
      }
  | Related_link of
      { ticket : Id.Ticket.t
      ; related : Id.Ticket.t
      ; expected_revision : int
      ; related_expected_revision : int
      ; linked : bool
      }
  | Ticket_claim of
      { id : Id.Ticket.t
      ; expected_revision : int
      }
  | Ticket_claim_with_lease of
      { id : Id.Ticket.t
      ; expected_revision : int
      ; lease_duration_ms : int64
      }
  | Ticket_renew_lease of
      { id : Id.Ticket.t
      ; token : int
      ; expected_lease_revision : int
      }
  | Ticket_release of
      { id : Id.Ticket.t
      ; token : int
      }
  | Ticket_complete of
      { id : Id.Ticket.t
      ; token : int
      ; evidence : string
      }
  | Comment_add of
      { id : Id.Comment.t option
      ; target : Entity_ref.t
      ; reply_to : Id.Comment.t option
      ; kind : Discussion.Kind.t
      ; body : string
      }
  | Comment_edit of
      { id : Id.Comment.t
      ; expected_revision : int
      ; body : string
      ; tombstone : bool
      }
  | Ticket_progress of
      { ticket : Id.Ticket.t
      ; token : int
      ; kind : Discussion.Kind.t
      ; body : string
      }
  | Handoff_set of
      { ticket : Id.Ticket.t
      ; expected_revision : int
      ; token : int option
      ; summary : string
      ; next_steps : string
      ; evidence : string
      ; objective : string
      ; completed : string
      ; decisions : string
      ; blockers : string
      ; resources : Id.Resource.t list
      ; covers_through : int option
      }
  | Resource_put of
      { id : Id.Resource.t
      ; expected_revision : int
      ; title : string
      ; text : string
      ; filename : string option
      ; mime_type : string option
      }
  | Resource_publish of
      { id : Id.Resource.t
      ; expected_revision : int
      ; title : string
      ; filename : string
      ; mime_type : string
      ; digest : string
      ; size_bytes : int
      }
  | Resource_metadata of
      { id : Id.Resource.t
      ; expected_revision : int
      ; title : string option
      ; filename : string option
      ; mime_type : string option
      ; description : string option
      ; archived : bool option
      }
  | Resource_link of
      { id : Id.Resource.t
      ; expected_revision : int
      ; target : Entity_ref.t
      ; remove : bool
      }
[@@deriving sexp]
