open Core

(** Private immutable planning snapshot. Only State exposes committed snapshots to
    callers. Preparation may construct intermediate candidates; final graph and
    attribution invariants are checked before publication and independently on
    replay. This module is private to the library, not a public decoder/constructor.
    Helpers that enforce invariants raise Json.Decode_error; no I/O occurs here. *)
module Revision : sig
  type t = int [@@deriving sexp]

  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t
end

module Workspace_settings : sig
  type t =
    { description : string
    ; instructions : string
    ; summary : string
    ; revision : Revision.t
    ; name : string option
    ; archived : bool
    }
  [@@deriving sexp, jsonaf]

  val empty : t
end

module Project : sig
  type t =
    { id : Id.Project.t
    ; title : string
    ; description : string
    ; revision : Revision.t
    ; status : Domain_command.Status.t
    ; priority : Revision.t
    ; summary : string
    ; acceptance_criteria : string
    ; archived : bool
    }
  [@@deriving sexp, jsonaf]
end

module Milestone : sig
  type t =
    { id : Id.Milestone.t
    ; project : Id.Project.t
    ; title : string
    ; description : string
    ; target_date : string option
    ; status : Domain_command.Status.t
    ; revision : Revision.t
    ; archived : bool
    }
  [@@deriving sexp, jsonaf]
end

module Claim : sig
  type t =
    { actor : Id.Actor.t
    ; run_id : Id.Run.t option
    ; token : Revision.t
    ; lease : Allocation_lease.t
    }
  [@@deriving sexp, jsonaf]
end

module Hold : sig
  type t =
    { actor : Id.Actor.t
    ; reason : string
    ; timestamp : string
    }
  [@@deriving sexp, jsonaf]
end

module Waiver : sig
  type t =
    { prerequisite : Id.Ticket.t
    ; actor : Id.Actor.t
    ; reason : string
    ; timestamp : string
    }
  [@@deriving sexp, jsonaf]
end

module Reassessment : sig
  type t =
    { prerequisite : Id.Ticket.t
    ; reopened_revision : Revision.t
    ; reason : string
    ; actor : Id.Actor.t
    ; timestamp : string
    }
  [@@deriving sexp, jsonaf]
end

module Ticket : sig
  type t =
    { id : Id.Ticket.t
    ; display_key : string
    ; title : string
    ; description : string
    ; project : Id.Project.t option
    ; membership_revision : Revision.t
    ; parent : Id.Ticket.t option
    ; milestone : Id.Milestone.t option
    ; archived : bool
    ; status_id : Id.Status.t option
    ; priority : Revision.t
    ; assignee : Id.Actor.t option
    ; labels : Id.Label.t list
    ; acceptance_criteria : string
    ; status : Domain_command.Status.t
    ; revision : Revision.t
    ; hold : Hold.t option
    ; waivers : Waiver.t list
    ; prerequisites : Id.Ticket.t list
    ; related : Id.Ticket.t list
    ; claim : Claim.t option
    ; created_order : Revision.t
    ; reopened_token : Revision.t option
    ; reassessments : Reassessment.t list
    ; created_sequence : Revision.t
    ; created_at : string
    ; updated_at : string
    ; next_token : Revision.t
    }
  [@@deriving sexp, jsonaf]
end

(** Exact pure recovered control projection, shared by durable replay and captured
    activity reducers. Requires current old-owner/ticket/lease/token guards; clears
    only the claim and increments revision/time, preserving recorded progress.
    Raises Json.Decode_error for invalid guards or exhausted revision. *)
val ticket_after_recovery_exn : Ticket.t -> recovery:Ticket_recovery.t -> Ticket.t

module Handoff : sig
  type t =
    { ticket : Id.Ticket.t
    ; actor : Id.Actor.t
    ; summary : string
    ; next_steps : string
    ; evidence : string
    ; revision : Revision.t
    ; objective : string
    ; completed : string
    ; decisions : string
    ; blockers : string
    ; resources : Id.Resource.t list
    ; timestamp : string
    ; covers_through : Revision.t
    }
  [@@deriving sexp, jsonaf]
end

module Policy_change : sig
  type t = Agent_run_policy.Change.t [@@deriving sexp]

  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t
end

module Event : sig
  type t =
    | Facts_changed of Facts.Change.t
    | Communication_changed of Communication.Change.t
    | Agent_run_changed of Agent_run.Change.t
    | Evidence_changed of Evidence.Change.t
    | Policy_changed of Policy_change.t
    | Policy_unchanged of Policy_change.t
    | Allocation_empty of
        { run : Id.Run.t
        ; attempt : Attempt.Id.t
        }
    | Settings_changed of Workflow.Change.t
    | Workspace_updated of Workspace_settings.t
    | Project_put of Project.t
    | Milestone_put of Milestone.t
    | Ticket_put of Ticket.t
    | Ticket_recovered of Ticket_recovery.t
    | Signal_receipt of External_condition.Repeat.t
    | Comment_changed of Discussion.Change.t
    | Handoff_put of Handoff.t
    | Resource_changed of Resource.Change.t
  [@@deriving sexp, jsonaf]
end

type t =
  { workspace : Id.Workspace.t
  ; name : string
  ; revision : int
  ; settings : Workspace_settings.t
  ; workflow : Workflow.t
  ; projects : Project.t Id.Project.Map.t
  ; milestones : Milestone.t Id.Milestone.Map.t
  ; tickets : Ticket.t Id.Ticket.Map.t
  ; ticket_keys : Id.Ticket.t String.Map.t
  ; ticket_recoveries : Ticket_recovery.t Coordination_id.Recovery.Map.t
  ; discussion : Discussion.t
  ; facts : Facts.t
  ; communication : Communication.t
  ; agent_runs : Agent_run.t
  ; evidence : Evidence.t
  ; policies : Agent_run_policy.t
  ; handoffs : Handoff.t Id.Ticket.Map.t
  ; resources : Resource.t Id.Resource.Map.t
  ; activity : Jsonaf.t list
  ; activity_by_target :
      (Entity_ref.t, Jsonaf.t list, Entity_ref.comparator_witness) Map.t
  ; retained_bytes : int
  }

val revision : t -> int

(** Effective acceptance context from this immutable planning capture. Current
    token survives claim release/completion; latest attempt is selected by its
    creation order within that token, never by a caller-controlled identifier. *)
val evidence_ticket_context : t -> Id.Ticket.t -> Evidence.Ticket_context.t option

val workspace : t -> Id.Workspace.t
val name : t -> string
val archived : t -> bool
val empty : workspace:Id.Workspace.t -> name:string -> (t, Problem.t) Result.t
val require : bool -> Problem.kind -> string -> unit
val find_ticket : t -> Id.Ticket.t -> Ticket.t
val find_project : t -> Id.Project.t -> Project.t
val find_milestone : t -> Id.Milestone.t -> Milestone.t
val validate_target : t -> Entity_ref.t -> unit
val active_scope : t -> Ticket.t -> bool
val expected : int -> int -> unit
val reachable : t -> from:Id.Ticket.t -> target:Id.Ticket.t -> parents:bool -> bool
val waived : Ticket.t -> Id.Ticket.t -> bool
val blockers : t -> Ticket.t -> Id.Ticket.t list

module Eligibility_reason : sig
  type t =
    | Archived_scope
    | Status of Domain_command.Status.t
    | Held of Hold.t
    | Claimed of Claim.t
    | Prerequisite of Id.Ticket.t
    | Coordination of Agent_run.Start_blocker.t
    | Coordination_clock_required of Path_scope.t
  [@@deriving sexp]

  val to_json : t -> revision:int -> Jsonaf.t
end

val eligibility_reasons
  :  ?run:Id.Run.t
  -> ?now_unix_ms:int64
  -> t
  -> Ticket.t
  -> Eligibility_reason.t list

val ready : ?run:Id.Run.t -> ?now_unix_ms:int64 -> t -> Ticket.t -> bool
val readiness : ?run:Id.Run.t -> ?now_unix_ms:int64 -> t -> Ticket.t -> Jsonaf.t
val sort_ready : Ticket.t list -> Ticket.t list
val unfinished_children : t -> Ticket.t -> Ticket.t list
val completion_readiness : t -> Ticket.t -> Jsonaf.t
val check_complete : t -> Ticket.t -> unit
val check_claim : Ticket.t -> actor:Id.Actor.t -> run:Id.Run.t option -> token:int -> unit
val bounded : string -> int -> unit
val validate_targets : t -> Entity_ref.t list -> (unit, Problem.t) Result.t

val validate_history
  :  t
  -> session_exists:(Session_id.t -> bool)
  -> event_exists:(Session.Event_ref.t -> bool)
  -> (unit, Problem.t) Result.t

val validate : t -> unit
val validate_new_claim_run : t -> Claim.t -> unit

val validate_terminal_reconciliation_owner
  :  t
  -> Attempt.t
  -> actor:Id.Actor.t
  -> run:Id.Run.t option
  -> unit

val unwrap_domain : ('a, Problem.t) Result.t -> 'a
val to_json : t -> Jsonaf.t
val blob_digests : t -> string list
val blob_references : t -> (string * int option) list

val resource_version
  :  t
  -> Id.Resource.t
  -> revision:int option
  -> (Resource.Version.t, Problem.t) Result.t

val validate_run_actor
  :  t
  -> run:Id.Run.t
  -> actor:Id.Actor.t
  -> (unit, Problem.t) Result.t

val agent_runs : t -> Agent_run.t
val evidence : t -> Evidence.t
val communication : t -> Communication.t
val policies : t -> Agent_run_policy.t

(** Exact retained planning/entity/fact admission accounting. Referenced resource
    bytes use the same per-digest accounting and unknown-size fallback as validation. *)
val admission : t -> Admission.t list

(** Coordinator graph candidates and exact typed readiness. [run] supplies the
    same selector used for allocation diagnostics; omitting it retains actionable
    run-required reasons. Supply current [now_unix_ms] for timed ownership; absent
    time remains explicitly unavailable rather than inferred from a stored lease. *)
val coordination_tickets
  :  ?run:Id.Run.t
  -> ?now_unix_ms:int64
  -> t
  -> Coordinator.Ticket.t list

(** Typed public views from actual immutable model fields; no internal JSON
    roundtrip or reference fabrication. Durable serializers remain independent. *)
val project_view : Project.t -> Planning_wire.Project.t

val milestone_view : Milestone.t -> Planning_wire.Milestone.t
val workspace_settings_view : Workspace_settings.t -> Planning_wire.Workspace_settings.t
val project_view_json : Project.t -> Jsonaf.t
val milestone_view_json : Milestone.t -> Jsonaf.t

(** Actual-model public projections; full historical payloads retain original
    identity, counters and provenance. JSON helpers validate programmer output. *)
val ownership_view : Claim.t -> Planning_ticket_wire.Ownership.t

val ownership_view_json : Claim.t -> Jsonaf.t
val ticket_view : Ticket.t -> Planning_ticket_wire.Ticket.t
val ticket_view_json : Ticket.t -> Jsonaf.t
val handoff_view : Handoff.t -> Planning_ticket_wire.Handoff.t
val handoff_view_json : Handoff.t -> Jsonaf.t
val completion_view : t -> Ticket.t -> Planning_ticket_wire.Completion.t

val readiness_view
  :  ?run:Id.Run.t
  -> ?now_unix_ms:int64
  -> t
  -> Ticket.t
  -> Planning_ticket_wire.Readiness.t
