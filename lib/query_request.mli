open Core

(** Typed query selectors. Extra filters/page budgets are validated by the server
    against the authoritative workspace revision; duplicate reserved parameters
    are rejected locally. Response data remains versioned JSON so bounded context
    can disclose omissions without pretending to be a complete domain entity. *)
type t =
  | Workspace_get
  | Workspace_overview
  | Actor_list
  | Label_list
  | Status_list
  | Project_list
  | Project_get of Id.Project.t
  | Project_brief of Id.Project.t
  | Milestone_list
  | Milestone_get of Id.Milestone.t
  | Ticket_list
  | Ticket_ready
  | Ticket_resolve of string
  | Ticket_context of Id.Ticket.t
  | Ticket_blockers of Id.Ticket.t
  | Ticket_readiness of Id.Ticket.t
  | Comment_list
  | Comment_get of Id.Comment.t
  | Comment_history of Id.Comment.t
  | Handoff_get of Id.Ticket.t
  | Handoff_history of Id.Ticket.t
  | Activity_since of int
  | Search of string
  | Resource_list
  | Resource_get of Id.Resource.t
  | Resource_history of Id.Resource.t

val encode
  :  t
  -> workspace:Id.Workspace.t
  -> parameters:(string * Jsonaf.t) list
  -> (Protocol.Request.t, Problem.t) Result.t
