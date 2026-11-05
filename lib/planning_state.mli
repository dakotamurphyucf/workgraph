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
    ; handoff : Project_completion.Handoff.t option
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
    the claim and increments revision/time. Preserve_status retains status;
    Requeue atomically sets Todo and clears custom status identity. Both retain
    holds, recorded progress, evidence and historical attempts.
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
    | Hierarchy_policy_put of Hierarchy_policy.Definition.t
    | Amendment_changed of Ticket_amendment.Change.t
    | Amendment_unchanged of Ticket_amendment.Acknowledgement.t
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
  ; hierarchy_policies : Hierarchy_policy.Definition.t Id.Ticket.Map.t
  ; amendments : Ticket_amendment.t
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
val amendment_ownership : t -> Id.Ticket.t -> Ticket_amendment.Ownership.t option

val check_amendments_complete : t -> Ticket.t -> unit
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

(** Local policy defaults to Independent/All_done. The immutable graph adds only
    opted ancestors' direct prerequisite edges, preserving source-owned waivers
    and deterministic provenance. Parent ownership/status/child gates stay local. *)
val hierarchy_policy : t -> Id.Ticket.t -> Hierarchy_policy.t

val hierarchy_graph : t -> Hierarchy_graph.t
val prerequisite_blockers : t -> Ticket.t -> Hierarchy_graph.Blocker.t list

(** Raise [Json.Decode_error] with current direct/inherited prerequisite blockers.
    Used independently at preparation and resolved acquisition replay boundaries. *)
val check_prerequisites : t -> Ticket.t -> unit

val blockers : t -> Ticket.t -> Id.Ticket.t list

module Acquisition : sig
  module Intent : sig
    type t =
      | Claim
      | Attempt
      | Reassign
    [@@deriving sexp, equal]
  end

  val allocated_tickets : t -> Id.Ticket.Set.t

  (** Pure assessment from this staged snapshot. Constrained claims require a
      registered compatible invocation; unconstrained opaque claims remain legal.
      Retained occupancy (own attempt/reassignment) consumes no additional pool
      slot even after capacity shrinks, but every eligibility check still applies.
      Attempt budgets apply only to a new attempt. Readiness and exact claim
      fences are checked separately by the acquisition operation. *)
  val assess
    :  t
    -> ticket:Ticket.t
    -> actor:Id.Actor.t
    -> run:Id.Run.t option
    -> intent:Intent.t
    -> Allocation_admission_reason.t list

  (** Candidate policies/capabilities/pools only; run lifecycle, budget and path
      ownership are deliberately absent rather than inferred from a fake run. *)
  val assess_candidate
    :  t
    -> ticket:Ticket.t
    -> candidate:Readiness_selector.Candidate.t
    -> Planning_ticket_wire.Readiness.Reason.t list

  val ensure
    :  t
    -> ticket:Ticket.t
    -> actor:Id.Actor.t
    -> run:Id.Run.t option
    -> intent:Intent.t
    -> (unit, Problem.t) Result.t
end

module Eligibility_reason : sig
  type t =
    | Archived_scope
    | Status of Domain_command.Status.t
    | Held of Hold.t
    | Claimed of Claim.t
    | Inherited_prerequisite of
        { ancestor : Id.Ticket.t
        ; prerequisite : Id.Ticket.t
        }
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

module Allocation_capture : sig
  type state = t

  module Entry : sig
    type t =
      { ticket : Ticket.t
      ; graph_reasons : Eligibility_reason.t list
      ; allocation_reasons : Allocation_admission_reason.t list
      ; parent_filtered : bool
      }

    val eligible : t -> bool
  end

  type t

  (** Registered run actor and immutable graph/coordination ownership are captured
      together. Both claim and new-attempt admission must pass. Terminal runs
      produce typed exclusion reasons; unknown runs/scopes return [Not_found]. *)
  val create
    :  state
    -> run:Id.Run.t
    -> project:Id.Project.t option
    -> leaf_only:bool
    -> now_unix_ms:int64 option
    -> (t, Problem.t) Result.t

  val assess_ticket
    :  state
    -> run:Id.Run.t
    -> now_unix_ms:int64 option
    -> Ticket.t
    -> (Entry.t, Problem.t) Result.t

  val entries : t -> Entry.t list
  val eligible_tickets : t -> Ticket.t list
  val selected : t -> Ticket.t option

  (** Only valid for an empty capture; counts and examples are exact/bounded. *)
  val explanation : t -> (Allocation.Explanation.t, Problem.t) Result.t
end

val completion_readiness : t -> Ticket.t -> Jsonaf.t

(** Check completion conditions against this immutable state. A [Blocked] failure
    includes bounded typed readiness details naming the ticket and its blockers;
    other domain failures retain their original kind and details. *)
val check_complete : t -> Ticket.t -> unit

(** Inspect all current members, including archived unfinished work, and current
    ownership from one immutable capture. Open requests are observational. *)
val project_completion : t -> Project.t -> Project_completion.t

(** Raise the captured completion problem if a project cannot finish. *)
val check_project_complete : t -> Project.t -> unit

val check_claim : Ticket.t -> actor:Id.Actor.t -> run:Id.Run.t option -> token:int -> unit

(** Exact active-attempt actor/run and current ticket-claim guards shared by
    preparation and resolved replay. Lease observation is checked separately
    by preparation, which has the server clock. *)
val validate_active_attempt_owner
  :  t
  -> Attempt.t
  -> actor:Id.Actor.t
  -> run:Id.Run.t option
  -> unit

val bounded : string -> int -> unit
val validate_targets : t -> Entity_ref.t list -> (unit, Problem.t) Result.t

val validate_history
  :  t
  -> session_exists:(Session_id.t -> bool)
  -> event_exists:(Session.Event_ref.t -> bool)
  -> (unit, Problem.t) Result.t

(** [previous] supplies the pre-write accounting for capacity diagnostics. Without
    it, usage describes the projection being validated. All guards are unchanged. *)
val validate : ?previous:t -> t -> unit

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

(** Verify a newly registered instance against the complete staged graph and local
    allocation/review policies. Called before registration and for new instances
    at transaction final validation/replay. Later ordinary ticket edits are allowed.
    Raises Json.Decode_error on inconsistent placement or gates. *)
val validate_initial_instance : t -> Workflow_template.Instance.t -> unit

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
val amendments : t -> Ticket_amendment.t
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

(** Known candidate checks only, without computing unrelated completion policy.
    Run-dependent checks remain unknown; a positive result grants no ownership. *)
val candidate_ready
  :  t
  -> candidate:Readiness_selector.Candidate.t
  -> ?now_unix_ms:int64
  -> Ticket.t
  -> bool

val readiness_view
  :  ?run:Id.Run.t
  -> ?candidate:Readiness_selector.Candidate.t
  -> ?now_unix_ms:int64
  -> t
  -> Ticket.t
  -> Planning_ticket_wire.Readiness.t

(** Page-level known-check scope with candidate unknowns aggregated over matching
    tickets, before pagination. This neither creates runs nor reserves work. *)
val readiness_assessment
  :  t
  -> selector:Readiness_selector.t
  -> tickets:Ticket.t list
  -> Readiness_selector.Assessment.t
