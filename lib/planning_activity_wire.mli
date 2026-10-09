open Core

(** Public audit records retain complete historical event payloads and original
    event ordering. Decoders validate named discriminated objects using executable
    family codecs; storage Event arrays and journal lineage remain independent. *)
module Change : sig
  type t =
    | Facts_changed of Facts.Change.t
    | Communication_changed of Communication.Change.t
    | Agent_run_changed of Agent_run_event.t
    | Evidence_changed of Evidence.Change.t
    | Policy_changed of Agent_run_policy.Change.t
    | Policy_unchanged of Agent_run_policy.Change.t
    | Allocation_empty of
        { run_id : Id.Run.t
        ; attempt_id : Attempt.Id.t
        }
    | Ticket_recovered of Ticket_recovery.t
    | Signal_receipt of External_condition.Repeat.t
    | Settings_changed of Workflow.Change.t
    | Workspace_updated of Planning_wire.Workspace_settings.t
    | Project_put of Planning_wire.Project.t
    | Milestone_put of Planning_wire.Milestone.t
    | Ticket_put of Planning_ticket_wire.Ticket.t
    | Comment_changed of Discussion.Change.t
    | Handoff_put of Planning_ticket_wire.Handoff.t
    | Resource_changed of Resource.Change.t

  val codec : t Api_codec.t
end

module Activity : sig
  type t =
    { revision : int
    ; actor_id : Id.Actor.t
    ; run_id : Id.Run.t option
    ; timestamp : string
    ; targets : Entity_ref.t list
    ; changes : Change.t list
    }

  val codec : t Api_codec.t
end

module Summary : sig
  type t =
    { revision : int
    ; actor_id : Id.Actor.t
    ; run_id : Id.Run.t option
    ; timestamp : string
    ; targets : Entity_ref.t list
    ; changes : int
    }

  val codec : t Api_codec.t
end
