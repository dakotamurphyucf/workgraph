open Core

module Communication : sig
  (** Complex extension records remain exact JSON values validated by their
      owning Communication_wire codecs, rather than private serializers. *)
  type t =
    { threads : Jsonaf.t Planning_wire.Page.t
    ; requests : Jsonaf.t Planning_wire.Page.t
    }

  val codec : t Api_codec.t
end

module Fact_keys : sig
  type t =
    { items : Jsonaf.t list
    ; total : int
    ; remaining : int
    }

  val codec : t Api_codec.t
end

module Workspace_overview : sig
  type t =
    { name : string
    ; settings : Planning_wire.Workspace_settings.t
    ; projects : int
    ; tickets : int
    ; ready : int
    ; counts_by_status : (Workflow.Category.t * int) list
    ; active_projects : Planning_wire.Project.t Planning_wire.Page.t
    ; held_work : Planning_ticket_wire.Summary.t Planning_wire.Page.t
    ; blocked_work : Planning_ticket_wire.Summary.t Planning_wire.Page.t
    ; recent_changes : Planning_activity_wire.Summary.t Planning_wire.Page.t
    ; resources : Jsonaf.t Planning_wire.Page.t
    }

  val codec : t Api_codec.t
end

module Project_brief : sig
  type t =
    { project : Planning_wire.Project.t
    ; resources : Jsonaf.t Planning_wire.Page.t
    ; communication : Communication.t
    ; progress : Planning_wire.Progress.t
    ; ready_work : Planning_ticket_wire.Summary.t Planning_wire.Page.t
    ; in_progress_work : Planning_ticket_wire.Summary.t Planning_wire.Page.t
    ; blocked_work : Planning_ticket_wire.Summary.t Planning_wire.Page.t
    ; tickets : Planning_ticket_wire.Ticket.t Planning_wire.Page.t
    ; milestones : Planning_wire.Milestone.t Planning_wire.Page.t
    }

  val codec : t Api_codec.t
end

module Ticket_context : sig
  (** Existing extension records reuse actual family codecs: Attempt, Evidence
      context, Ticket_recovery, Ticket_paths and external-condition public views.
      No json/opaque escape hatch is permitted in this context schema. *)
  type t =
    { ticket : Planning_ticket_wire.Ticket.t
    ; fact_keys : Fact_keys.t
    ; related : Planning_ticket_wire.Summary.t Planning_wire.Page.t
    ; resources : Jsonaf.t Planning_wire.Page.t
    ; communication : Communication.t
    ; attempts : Attempt.t Planning_wire.Page.t
    ; evidence : Jsonaf.t
    ; completion_readiness : Planning_ticket_wire.Completion.t
    ; readiness : Planning_ticket_wire.Readiness.t
    ; recoveries : Ticket_recovery.t Planning_wire.Page.t
    ; paths : Ticket_paths.t option
    ; external_conditions : Jsonaf.t list
    ; parent : Planning_ticket_wire.Ticket.t option
    ; children : Planning_ticket_wire.Ticket.t Planning_wire.Page.t
    ; blocker_ticket_ids : Id.Ticket.t list
    ; handoff : Planning_ticket_wire.Handoff.t option
    ; updates : Jsonaf.t Planning_wire.Page.t
    ; activity_since_handoff : Planning_activity_wire.Summary.t Planning_wire.Page.t
    }

  val codec : t Api_codec.t
end

module Resolve : sig
  type t =
    { ticket_id : Id.Ticket.t
    ; display_key : string
    }

  val codec : t Api_codec.t
end

module Search : sig
  module Match : sig
    type t =
      { field : string
      ; match_offset : int
      ; match_bytes : int
      ; snippet_offset : int
      ; snippet : string
      }

    val codec : t Api_codec.t
  end

  module Source : sig
    type t =
      | Workspace of Id.Workspace.t
      | Project of Id.Project.t
      | Milestone of Id.Milestone.t
      | Ticket of Id.Ticket.t
      | Comment of Id.Comment.t
      | Handoff of Id.Ticket.t
      | Resource of Id.Resource.t
      | Resource_text of Id.Resource.t
      | Fact of
          { scope : Facts.Scope.t
          ; key : Facts.Key.t
          }

    val codec : t Api_codec.t
  end

  module Version : sig
    type t =
      { source : Source.t
      ; revision : int
      }

    val codec : t Api_codec.t
  end

  module Item : sig
    type t =
      { source : Version.t
      ; target : Entity_ref.t
      ; matches : Match.t list
      }

    val codec : t Api_codec.t
  end

  module Unindexed_resource : sig
    type reason =
      | Prefix_only
      | Invalid_utf8
      | Not_requested
      | Query_text_budget
      | Unsupported_mime

    type t =
      { source : Version.t
      ; reason : reason
      ; indexed_bytes : int
      ; omitted_bytes : int
      ; size_known : bool
      }

    val codec : t Api_codec.t
  end

  module Coverage : sig
    type t =
      { current_revisions_only : bool
      ; eligible_text_resources : int
      ; indexed_text_resources : int
      ; unindexed_text_resources : int
      ; truncated_text_resources : int
      ; resource_prefix_bytes : int
      ; request_text_bytes : int
      }

    val codec : t Api_codec.t
  end

  (** The typed results page encodes as the current flattened items/offset/
      remaining/next_offset fields, beside the coverage metadata. *)
  type t =
    { results : Item.t Planning_wire.Page.t
    ; unindexed_resources : Unindexed_resource.t Planning_wire.Page.t
    ; index_revision : int
    ; sources_scanned : int
    ; coverage : Coverage.t
    }

  val codec : t Api_codec.t
end

module Response : sig
  type t =
    | Activity of Planning_activity_wire.Activity.t Planning_wire.Page.t
    | Search of Search.t
    | Workspace_overview of Workspace_overview.t
    | Project_brief of Project_brief.t
    | Ticket_context of Ticket_context.t
    | Tickets of Planning_ticket_wire.Ticket.t Planning_wire.Page.t
    | Readiness of Planning_ticket_wire.Readiness.t
    | Blockers of Planning_ticket_wire.Summary.t Planning_wire.Page.t
    | Resolve of Resolve.t
    | Handoff of Planning_ticket_wire.Handoff.t
    | Handoffs of Planning_ticket_wire.Handoff.t Planning_wire.Page.t

  val data : t -> Jsonaf.t

  (** Protect all identity, control, status, reasons, provenance and historical
      rows. Only current Ticket description/acceptance_criteria and page suffixes
      shorten with explicit omissions. Oversized first essential rows fail
      actionably rather than return success with an unchanged cursor. *)
  val fit : t -> workspace_revision:int -> max_bytes:int -> (Jsonaf.t, Problem.t) Result.t
end
