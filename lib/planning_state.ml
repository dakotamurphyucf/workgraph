open Core
open Ppx_jsonaf_conv_lib.Jsonaf_conv.Primitives

module Revision = struct
  type t = int [@@deriving sexp]

  let jsonaf_of_t = Json.int
  let t_of_jsonaf = Json.integer
end

module Workspace_settings = struct
  type t =
    { description : string
    ; instructions : string
    ; summary : string
    ; revision : Revision.t
    ; name : string option
    ; archived : bool
    }
  [@@deriving sexp, jsonaf]

  let empty =
    { description = ""
    ; instructions = ""
    ; summary = ""
    ; revision = 0
    ; name = None
    ; archived = false
    }
  ;;
end

module Project = struct
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

module Milestone = struct
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

module Claim = struct
  type t =
    { actor : Id.Actor.t
    ; run_id : Id.Run.t option
    ; token : Revision.t
    ; lease : Allocation_lease.t
    }
  [@@deriving sexp, jsonaf]
end

module Hold = struct
  type t =
    { actor : Id.Actor.t
    ; reason : string
    ; timestamp : string
    }
  [@@deriving sexp, jsonaf]
end

module Waiver = struct
  type t =
    { prerequisite : Id.Ticket.t
    ; actor : Id.Actor.t
    ; reason : string
    ; timestamp : string
    }
  [@@deriving sexp, jsonaf]
end

module Reassessment = struct
  type t =
    { prerequisite : Id.Ticket.t
    ; reopened_revision : Revision.t
    ; reason : string
    ; actor : Id.Actor.t
    ; timestamp : string
    }
  [@@deriving sexp, jsonaf]
end

module Ticket = struct
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

  let decoded_t_of_jsonaf = t_of_jsonaf

  let t_of_jsonaf json =
    let ticket = decoded_t_of_jsonaf json in
    if ticket.membership_revision <= 0
    then Json.fail Invalid_argument "Ticket membership revision must be positive";
    ticket
  ;;

  let decoded_t_of_sexp = t_of_sexp

  let t_of_sexp sexp =
    let ticket = decoded_t_of_sexp sexp in
    if ticket.membership_revision <= 0
    then Sexplib.Conv.of_sexp_error "Ticket membership revision must be positive" sexp;
    ticket
  ;;
end

let ticket_after_recovery_exn (ticket : Ticket.t) ~recovery =
  let request = recovery.Ticket_recovery.request in
  if not (Id.Ticket.equal request.ticket_id ticket.id)
  then Json.fail Conflict "Recovery ticket differs from projected ticket";
  let claim =
    match ticket.claim with
    | Some claim -> claim
    | None -> Json.fail Stale_claim "Recovery ticket has no owner"
  in
  (match
     Ticket_lifecycle.Recovery.validate_owner
       request
       ~revision:ticket.revision
       ~actor:claim.actor
       ~run:claim.run_id
       ~token:claim.token
       ~lease_revision:(Allocation_lease.revision claim.lease)
   with
   | Ok () -> ()
   | Error problem -> raise (Json.Decode_error problem));
  if ticket.revision = Int.max_value then Json.fail Conflict "Ticket revision exhausted";
  { ticket with
    claim = None
  ; revision = ticket.revision + 1
  ; updated_at = recovery.timestamp
  }
;;

module Handoff = struct
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

module Policy_change = struct
  type t = Agent_run_policy.Change.t [@@deriving sexp]

  let jsonaf_of_t = Agent_run_policy.Change.to_json

  let t_of_jsonaf json =
    match Agent_run_policy.Change.of_json json with
    | Ok change -> change
    | Error error -> raise (Json.Decode_error error)
  ;;
end

module Event = struct
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

let revision t = t.revision

let evidence_ticket_context t id =
  Option.map (Map.find t.tickets id) ~f:(fun ticket ->
    let current_token =
      if ticket.Ticket.next_token > 1 then Some (ticket.next_token - 1) else None
    in
    let ownership =
      Option.map ticket.claim ~f:(fun claim ->
        { Evidence.Ticket_context.Ownership.token = claim.Claim.token
        ; actor = claim.actor
        ; run = claim.run_id
        })
    in
    let attempt =
      Option.bind current_token ~f:(fun token ->
        Agent_run.latest_attempt_for_ticket t.agent_runs ~ticket:id ~token
        |> Option.map ~f:(fun attempt -> attempt.Attempt.id))
    in
    { Evidence.Ticket_context.project = ticket.project
    ; membership_revision = ticket.membership_revision
    ; minimum_reopening_token = ticket.reopened_token
    ; current_token
    ; ownership
    ; attempt
    })
;;

let workspace t = t.workspace
let name t = Option.value t.settings.name ~default:t.name
let archived t = t.settings.archived

let empty ~workspace ~name =
  if String.is_empty (String.strip name) || String.length name > 512
  then Error (Problem.create Invalid_argument "workspace name requires 1..512 bytes")
  else
    Ok
      { workspace
      ; name
      ; revision = 0
      ; settings = Workspace_settings.empty
      ; workflow = Workflow.empty
      ; projects = Id.Project.Map.empty
      ; milestones = Id.Milestone.Map.empty
      ; tickets = Id.Ticket.Map.empty
      ; ticket_keys = String.Map.empty
      ; ticket_recoveries = Coordination_id.Recovery.Map.empty
      ; discussion = Discussion.empty
      ; facts = Facts.empty
      ; communication = Communication.empty
      ; agent_runs = Agent_run.empty
      ; evidence = Evidence.empty
      ; policies = Agent_run_policy.empty
      ; handoffs = Id.Ticket.Map.empty
      ; resources = Id.Resource.Map.empty
      ; activity = []
      ; activity_by_target = Map.empty (module Entity_ref)
      ; retained_bytes = 0
      }
;;

let require condition kind message = if not condition then Json.fail kind message

let find_ticket t id =
  match Map.find t.tickets id with
  | Some ticket -> ticket
  | None -> Json.fail Not_found ("ticket not found: " ^ Id.Ticket.to_string id)
;;

let find_project t id =
  match Map.find t.projects id with
  | Some project -> project
  | None -> Json.fail Not_found ("project not found: " ^ Id.Project.to_string id)
;;

let find_milestone t id =
  match Map.find t.milestones id with
  | Some milestone -> milestone
  | None -> Json.fail Not_found ("milestone not found: " ^ Id.Milestone.to_string id)
;;

let validate_target t = function
  | Entity_ref.Workspace -> ()
  | Project id -> ignore (find_project t id : Project.t)
  | Milestone id -> ignore (find_milestone t id : Milestone.t)
  | Ticket id -> ignore (find_ticket t id : Ticket.t)
  | Resource id -> require (Map.mem t.resources id) Not_found "resource not found"
;;

let active_scope t (ticket : Ticket.t) =
  (not t.settings.archived)
  && (not ticket.archived)
  && Option.for_all ticket.project ~f:(fun id -> not (find_project t id).archived)
  && Option.for_all ticket.milestone ~f:(fun id -> not (find_milestone t id).archived)
;;

let expected actual expected =
  require
    (Int.equal actual expected)
    Conflict
    (sprintf "revision conflict: expected %d, current %d" expected actual)
;;

let path t ~from ~target ~parents =
  let rec loop visited = function
    | [] -> None
    | (id, prefix) :: rest ->
      if Id.Ticket.equal id target
      then Some (List.rev (id :: prefix))
      else if Set.mem visited id
      then loop visited rest
      else (
        let ticket = find_ticket t id in
        let next =
          if parents then Option.to_list ticket.parent else ticket.prerequisites
        in
        let rest =
          List.fold next ~init:rest ~f:(fun rest next -> (next, id :: prefix) :: rest)
        in
        loop (Set.add visited id) rest)
  in
  loop Id.Ticket.Set.empty [ from, [] ]
;;

let reachable t ~from ~target ~parents = Option.is_some (path t ~from ~target ~parents)

let check_acyclic t ~from ~target ~parents =
  match path t ~from ~target ~parents with
  | None -> ()
  | Some path ->
    Json.fail
      Dependency_cycle
      ((if parents then "parent cycle: " else "dependency cycle: ")
       ^ String.concat ~sep:" -> " (List.map (target :: path) ~f:Id.Ticket.to_string))
;;

let waived (ticket : Ticket.t) id =
  List.exists ticket.waivers ~f:(fun waiver ->
    Id.Ticket.equal waiver.Waiver.prerequisite id)
;;

let blockers t (ticket : Ticket.t) =
  List.filter ticket.prerequisites ~f:(fun id ->
    (not (waived ticket id))
    && not (Domain_command.Status.equal (find_ticket t id).status Done))
;;

let ownership_view (value : Claim.t) : Planning_ticket_wire.Ownership.t =
  { actor_id = value.actor
  ; run_id = value.run_id
  ; token = value.token
  ; lease = Planning_ticket_wire.Lease.of_domain value.lease
  }
;;

let hold_view (value : Hold.t) : Planning_ticket_wire.Hold.t =
  { actor_id = value.actor; reason = value.reason; timestamp = value.timestamp }
;;

let waiver_view (value : Waiver.t) : Planning_ticket_wire.Waiver.t =
  { prerequisite_ticket_id = value.prerequisite
  ; actor_id = value.actor
  ; reason = value.reason
  ; timestamp = value.timestamp
  }
;;

let reassessment_view (value : Reassessment.t) : Planning_ticket_wire.Reassessment.t =
  { prerequisite_ticket_id = value.prerequisite
  ; reopened_revision = value.reopened_revision
  ; reason = value.reason
  ; actor_id = value.actor
  ; timestamp = value.timestamp
  }
;;

let ticket_view (value : Ticket.t) : Planning_ticket_wire.Ticket.t =
  { ticket_id = value.id
  ; display_key = value.display_key
  ; title = value.title
  ; description = value.description
  ; project_id = value.project
  ; membership_revision = value.membership_revision
  ; parent_ticket_id = value.parent
  ; milestone_id = value.milestone
  ; archived = value.archived
  ; status_id = value.status_id
  ; priority = value.priority
  ; assignee_id = value.assignee
  ; label_ids = value.labels
  ; acceptance_criteria = value.acceptance_criteria
  ; status = value.status
  ; revision = value.revision
  ; hold = Option.map value.hold ~f:hold_view
  ; waivers = List.map value.waivers ~f:waiver_view
  ; prerequisite_ticket_ids = value.prerequisites
  ; related_ticket_ids = value.related
  ; claim = Option.map value.claim ~f:ownership_view
  ; created_order = value.created_order
  ; reopened_token = value.reopened_token
  ; reassessments = List.map value.reassessments ~f:reassessment_view
  ; created_sequence = value.created_sequence
  ; created_at = value.created_at
  ; updated_at = value.updated_at
  ; next_token = value.next_token
  }
;;

let handoff_view (value : Handoff.t) : Planning_ticket_wire.Handoff.t =
  { ticket_id = value.ticket
  ; actor_id = value.actor
  ; summary = value.summary
  ; next_steps = value.next_steps
  ; evidence = value.evidence
  ; revision = value.revision
  ; objective = value.objective
  ; completed = value.completed
  ; decisions = value.decisions
  ; blockers = value.blockers
  ; resource_ids = value.resources
  ; timestamp = value.timestamp
  ; covers_through = value.covers_through
  }
;;

let public_view_json name codec value =
  match Api_codec.encode codec value with
  | Ok value -> value
  | Error problem -> raise (Api_method.Invalid_response (name, problem))
;;

let ownership_view_json value =
  public_view_json
    "planning ownership"
    Planning_ticket_wire.Ownership.codec
    (ownership_view value)
;;

let ticket_view_json value =
  public_view_json "planning ticket" Planning_ticket_wire.Ticket.codec (ticket_view value)
;;

let handoff_view_json value =
  public_view_json
    "planning handoff"
    Planning_ticket_wire.Handoff.codec
    (handoff_view value)
;;

module Eligibility_reason = struct
  type t =
    | Archived_scope
    | Status of Domain_command.Status.t
    | Held of Hold.t
    | Claimed of Claim.t
    | Prerequisite of Id.Ticket.t
    | Coordination of Agent_run.Start_blocker.t
    | Coordination_clock_required of Path_scope.t
  [@@deriving sexp]

  let to_json t ~revision =
    let reason kind fields = Json.obj (("kind", Json.string kind) :: fields) in
    match t with
    | Archived_scope -> reason "archived_scope" []
    | Status status ->
      reason "status" [ "category", Domain_command.Status.jsonaf_of_t status ]
    | Held hold -> reason "hold" [ "details", Hold.jsonaf_of_t hold ]
    | Claimed claim ->
      reason
        "claimed"
        [ "details", Claim.jsonaf_of_t claim; "revision", Json.int revision ]
    | Prerequisite id -> reason "prerequisite" [ "ticket_id", Id.Ticket.jsonaf_of_t id ]
    | Coordination blocker -> Agent_run.Start_blocker.to_json blocker
    | Coordination_clock_required target ->
      reason "observation_time_required" [ "target", Path_scope.jsonaf_of_t target ]
  ;;
end

let eligibility_reasons ?run ?now_unix_ms t (ticket : Ticket.t) =
  (if active_scope t ticket then [] else [ Eligibility_reason.Archived_scope ])
  @ (if Domain_command.Status.equal ticket.status Todo
     then []
     else [ Eligibility_reason.Status ticket.status ])
  @ (Option.to_list ticket.hold |> List.map ~f:(fun hold -> Eligibility_reason.Held hold))
  @ (Option.to_list ticket.claim
     |> List.map ~f:(fun claim -> Eligibility_reason.Claimed claim))
  @ List.map (blockers t ticket) ~f:(fun id -> Eligibility_reason.Prerequisite id)
  @
  let run =
    match run with
    | Some _ -> run
    | None -> Option.bind ticket.claim ~f:(fun c -> c.Claim.run_id)
  in
  let clock_needed =
    if Option.is_some now_unix_ms
    then []
    else Agent_run.start_clock_required t.agent_runs ~ticket:ticket.id ~run
  in
  let blockers =
    Agent_run.start_blockers
      t.agent_runs
      ~ticket:ticket.id
      ~run
      ~now_unix_ms:(Option.value now_unix_ms ~default:0L)
  in
  let blockers =
    if Option.is_some now_unix_ms
    then blockers
    else
      List.filter blockers ~f:(function
        | Agent_run.Start_blocker.Expired_required_ownership _ -> false
        | Run_required _ | Path_conflict _ | Ownership_mode _ | External_condition _ ->
          true)
  in
  List.map blockers ~f:(fun b -> Eligibility_reason.Coordination b)
  @ List.map clock_needed ~f:(fun t -> Eligibility_reason.Coordination_clock_required t)
;;

let ready ?run ?now_unix_ms t ticket =
  List.is_empty (eligibility_reasons ?run ?now_unix_ms t ticket)
;;

let sort_ready tickets =
  List.sort tickets ~compare:(fun a b ->
    let rank priority = if priority = 0 then 5 else priority in
    match Int.compare (rank a.Ticket.priority) (rank b.Ticket.priority) with
    | 0 ->
      (match Int.compare a.created_order b.created_order with
       | 0 -> Id.Ticket.compare a.id b.id
       | order -> order)
    | order -> order)
;;

let unfinished_children t (ticket : Ticket.t) =
  Map.data t.tickets
  |> List.filter ~f:(fun child ->
    Option.value_map child.Ticket.parent ~default:false ~f:(Id.Ticket.equal ticket.id)
    && not (Domain_command.Status.equal child.status Done))
;;

let completion_problem t (ticket : Ticket.t) =
  Json.decode (fun () ->
    (match
       Evidence.ensure_can_complete
         t.evidence
         ~ticket_context:(evidence_ticket_context t)
         ~ticket:ticket.id
     with
     | Ok () -> ()
     | Error error -> raise (Json.Decode_error error));
    require (Option.is_none ticket.hold) Blocked "explicit hold";
    require (List.is_empty (blockers t ticket)) Blocked "unfinished prerequisites";
    require
      (List.is_empty (unfinished_children t ticket))
      Blocked
      "unfinished child tickets")
;;

let completion_view t (ticket : Ticket.t) : Planning_ticket_wire.Completion.t =
  let problem = completion_problem t ticket in
  let policy =
    match
      Evidence.effective_policy
        t.evidence
        ~ticket_context:(evidence_ticket_context t)
        ~ticket:ticket.id
    with
    | Ok policy -> policy
    | Error problem -> raise (Json.Decode_error problem)
  in
  let policy_result =
    Evidence.ensure_can_complete
      t.evidence
      ~ticket_context:(evidence_ticket_context t)
      ~ticket:ticket.id
  in
  let blocked_prerequisite_ids = blockers t ticket in
  let unfinished_child_ids =
    List.map (unfinished_children t ticket) ~f:(fun child -> child.Ticket.id)
  in
  let check kind passed : Planning_ticket_wire.Completion.Check.t = { kind; passed } in
  { can_complete = Result.is_ok problem
  ; checks =
      [ check Hold (Option.is_none ticket.hold)
      ; check Prerequisites (List.is_empty blocked_prerequisite_ids)
      ; check Children (List.is_empty unfinished_child_ids)
      ; check Configured_policy (Result.is_ok policy_result)
      ]
  ; policy
  ; blocked_prerequisite_count = List.length blocked_prerequisite_ids
  ; unfinished_child_count = List.length unfinished_child_ids
  ; blocked_prerequisite_ids
  ; unfinished_child_ids
  ; problem =
      (match problem with
       | Ok () -> None
       | Error problem -> Some problem)
  }
;;

let completion_readiness t ticket =
  public_view_json
    "planning completion readiness"
    Planning_ticket_wire.Completion.codec
    (completion_view t ticket)
;;

let check_complete t ticket =
  match completion_problem t ticket with
  | Ok () -> ()
  | Error p -> raise (Json.Decode_error p)
;;

let readiness_view ?run ?now_unix_ms t (ticket : Ticket.t)
  : Planning_ticket_wire.Readiness.t
  =
  let reason : Eligibility_reason.t -> Planning_ticket_wire.Readiness.Reason.t = function
    | Archived_scope -> Archived_scope
    | Status value -> Status value
    | Held value -> Hold (hold_view value)
    | Claimed value ->
      Claimed { details = ownership_view value; revision = ticket.revision }
    | Prerequisite value -> Prerequisite value
    | Coordination value -> Coordination value
    | Coordination_clock_required value -> Observation_time_required value
  in
  let reasons = List.map (eligibility_reasons ?run ?now_unix_ms t ticket) ~f:reason in
  { ready = List.is_empty reasons
  ; reasons
  ; reason_count = List.length reasons
  ; reassessments = List.map ticket.reassessments ~f:reassessment_view
  ; completion = completion_view t ticket
  }
;;

let readiness ?run ?now_unix_ms t (ticket : Ticket.t) =
  let reasons = eligibility_reasons ?run ?now_unix_ms t ticket in
  Json.obj
    [ ("ready", if List.is_empty reasons then `True else `False)
    ; ( "reasons"
      , `Array
          (List.map reasons ~f:(fun reason ->
             Eligibility_reason.to_json reason ~revision:ticket.revision)) )
    ; "reason_count", Json.int (List.length reasons)
    ; "reassessments", `Array (List.map ticket.reassessments ~f:Reassessment.jsonaf_of_t)
    ; "completion", completion_readiness t ticket
    ]
;;

let check_claim (ticket : Ticket.t) ~actor ~run ~token =
  match ticket.claim with
  | Some claim
    when Id.Actor.equal claim.actor actor
         && Option.equal Id.Run.equal claim.run_id run
         && Int.equal claim.token token -> ()
  | Some _ | None -> Json.fail Stale_claim "claim actor, run or token is stale"
;;

let bounded value max_bytes =
  require (String.length value <= max_bytes) Invalid_argument "text exceeds byte limit"
;;

let valid_title value =
  bounded value 512;
  require (not (String.is_empty (String.strip value))) Invalid_argument "empty title"
;;

let validate_targets t targets =
  Json.decode (fun () -> List.iter targets ~f:(validate_target t))
;;

let validate_history t ~session_exists ~event_exists =
  Json.decode (fun () ->
    List.iter (Agent_run.session_references t.agent_runs) ~f:(fun id ->
      require (session_exists id) Not_found "run/attempt session reference not found");
    List.iter
      (Evidence.event_references t.evidence
       @ Agent_run.event_references t.agent_runs
       @ Ticket_recovery.event_references (Map.data t.ticket_recoveries))
      ~f:(fun ref_ ->
        require (event_exists ref_) Not_found "pinned session event reference not found"))
;;

let resource_version_exists t id ~revision =
  Result.is_ok
    (Json.decode (fun () ->
       ignore
         (Resource.get_version
            (match Map.find t.resources id with
             | Some r -> r
             | None -> Json.fail Not_found "resource not found")
            ~revision:(Some revision)
          : Resource.Version.t)))
;;

let validation_bool result ~default =
  match result with
  | Ok value -> value
  | Error _ -> default
;;

let evidence_pin_exists t pin =
  Evidence.pin_internal_exists t.evidence pin
  && (function
       | Evidence.Pin.Resource p ->
         validation_bool
           (Json.decode (fun () ->
              let r =
                match Map.find t.resources p.id with
                | Some r -> r
                | None -> Json.fail Not_found "resource not found"
              in
              let version = Resource.get_version r ~revision:(Some p.revision) in
              String.equal version.digest p.digest))
           ~default:false
       | Comment { id; revision } ->
         validation_bool
           (Json.decode (fun () ->
              List.exists (Discussion.history t.discussion id) ~f:(fun json ->
                Int.equal (Json.integer (Json.field json "revision")) revision)))
           ~default:false
       | Event _ | Commit _ | Checksum _ | Contract _ | Decision _ -> true)
       pin
;;

let resource_admission_bytes resources =
  let sizes =
    Map.fold resources ~init:String.Map.empty ~f:(fun ~key:_ ~data:resource sizes ->
      List.fold resource.Resource.versions ~init:sizes ~f:(fun sizes version ->
        let size = Option.value version.Resource.Version.size_bytes ~default:65_536 in
        Map.update sizes version.digest ~f:(function
          | None -> size
          | Some old -> Int.max old size)))
  in
  Map.fold sizes ~init:0 ~f:(fun ~key:_ ~data:size total -> total + size)
;;

let validate t =
  Map.iter t.ticket_recoveries ~f:(fun recovery ->
    require
      (Map.mem t.tickets recovery.Ticket_recovery.request.ticket_id)
      Not_found
      "Recovery ticket missing";
    List.iter recovery.request.evidence ~f:(fun pin ->
      require (evidence_pin_exists t pin) Not_found "Recovery evidence missing"));
  (match
     Agent_run_policy.validate_references
       t.policies
       ~resource_version:(fun id ~revision ->
         Result.ok
           (Json.decode (fun () ->
              let r =
                match Map.find t.resources id with
                | Some r -> r
                | None -> Json.fail Not_found "resource not found"
              in
              (Resource.get_version r ~revision:(Some revision)).digest)))
       ~run_exists:(fun id -> Option.is_some (Agent_run.get_run t.agent_runs id))
       ~attempt_exists:(fun id -> Option.is_some (Agent_run.get_attempt t.agent_runs id))
       ~ticket_exists:(Map.mem t.tickets)
   with
   | Ok () -> ()
   | Error error -> raise (Json.Decode_error error));
  (match
     Agent_run.validate_references
       t.agent_runs
       ~ticket_exists:(Map.mem t.tickets)
       ~session_exists:(fun _ -> true)
       ~resource_version_exists:(resource_version_exists t)
       ~handoff_exists:(fun id ~revision ->
         revision > 0
         && Option.value_map (Map.find t.handoffs id) ~default:false ~f:(fun h ->
           h.Handoff.revision >= revision))
   with
   | Ok () -> ()
   | Error error -> raise (Json.Decode_error error));
  (match
     Agent_run.validate_coordination_references
       t.agent_runs
       ~ticket_exists:(Map.mem t.tickets)
       ~pin_exists:(evidence_pin_exists t)
   with
   | Ok () -> ()
   | Error error -> raise (Json.Decode_error error));
  (match
     Evidence.validate_references
       t.evidence
       ~attempt:(Agent_run.get_attempt t.agent_runs)
       ~entity_exists:(fun target ->
         Result.is_ok (Json.decode (fun () -> validate_target t target)))
       ~review_request_exists:(fun id ->
         Option.is_some (Communication.get_request t.communication id))
       ~pin_exists:(evidence_pin_exists t)
   with
   | Ok () -> ()
   | Error error -> raise (Json.Decode_error error));
  (match
     Facts.validate_targets t.facts ~exists:(fun target ->
       Result.is_ok (Json.decode (fun () -> validate_target t target)))
   with
   | Ok () -> ()
   | Error error -> raise (Json.Decode_error error));
  (match
     Communication.validate_references
       t.communication
       ~entity_exists:(fun target ->
         Result.is_ok (Json.decode (fun () -> validate_target t target)))
       ~discussion:t.discussion
   with
   | Ok () -> ()
   | Error error -> raise (Json.Decode_error error));
  Map.iter t.tickets ~f:(fun ticket ->
    List.iter (Agent_run.attempts_for_ticket t.agent_runs ticket.Ticket.id) ~f:(fun a ->
      if not (Attempt.State.terminal a.state)
      then (
        let owner =
          match Agent_run.get_run t.agent_runs a.run with
          | Some r -> r
          | None -> Json.fail Not_found "attempt run not found"
        in
        require
          (not (Agent_run.Status.terminal owner.status))
          Conflict
          "terminal run retains an active attempt";
        check_claim ticket ~actor:owner.actor ~run:(Some a.run) ~token:a.token)));
  valid_title t.name;
  Option.iter t.settings.name ~f:valid_title;
  List.iter (Discussion.targets t.discussion) ~f:(validate_target t);
  bounded t.settings.description 65_536;
  bounded t.settings.instructions 65_536;
  bounded t.settings.summary 65_536;
  require
    (Map.length t.tickets <= Admission.Limit.maximum Tickets
     && Map.length t.projects <= Admission.Limit.maximum Projects
     && Map.length t.milestones <= Admission.Limit.maximum Milestones)
    Invalid_argument
    "workspace entity limit exceeded";
  Map.iter t.projects ~f:(fun p ->
    valid_title p.Project.title;
    bounded p.description 65_536;
    require
      (p.priority >= 0 && p.priority <= 4)
      Invalid_argument
      "invalid project priority";
    bounded p.summary 65_536;
    bounded p.acceptance_criteria 65_536;
    require (p.revision > 0) Corrupt_store "invalid project revision");
  Map.iter t.milestones ~f:(fun milestone ->
    valid_title milestone.Milestone.title;
    bounded milestone.description 65_536;
    require (milestone.revision > 0) Corrupt_store "invalid milestone revision";
    ignore (find_project t milestone.project : Project.t);
    Option.iter milestone.target_date ~f:(fun date ->
      require
        (Result.is_ok
           (Or_error.try_with (fun () ->
              let parsed = Date.of_string date in
              if not (String.equal (Date.to_string parsed) date)
              then failwith "noncanonical date")))
        Invalid_argument
        "invalid milestone date"));
  let valid_reason reason =
    bounded reason 65_536;
    require
      (not (String.is_empty (String.strip reason)))
      Invalid_argument
      "reason cannot be empty"
  in
  Map.iter t.tickets ~f:(fun ticket ->
    Option.iter ticket.Ticket.hold ~f:(fun hold ->
      valid_reason hold.Hold.reason;
      bounded hold.timestamp 128);
    require
      (List.length ticket.waivers
       = Set.length
           (Id.Ticket.Set.of_list
              (List.map ticket.waivers ~f:(fun waiver -> waiver.Waiver.prerequisite))))
      Corrupt_store
      "duplicate waiver";
    List.iter ticket.waivers ~f:(fun waiver ->
      valid_reason waiver.Waiver.reason;
      bounded waiver.timestamp 128;
      require
        (List.mem ticket.prerequisites waiver.prerequisite ~equal:Id.Ticket.equal)
        Corrupt_store
        "waiver without dependency");
    require
      (List.length ticket.related <= 100
       && List.length ticket.related = Set.length (Id.Ticket.Set.of_list ticket.related))
      Invalid_argument
      "related links require distinct IDs and at most100 endpoints";
    List.iter ticket.related ~f:(fun id ->
      require
        (not (Id.Ticket.equal id ticket.id))
        Conflict
        "ticket cannot relate to itself";
      let other = find_ticket t id in
      require
        (List.mem other.related ticket.id ~equal:Id.Ticket.equal)
        Corrupt_store
        "related link is not symmetric");
    require
      (Option.exists
         (Map.find t.ticket_keys ticket.display_key)
         ~f:(Id.Ticket.equal ticket.id))
      Corrupt_store
      "ticket display index differs";
    valid_title ticket.Ticket.title;
    bounded ticket.description 65_536;
    bounded ticket.created_at 128;
    require
      (ticket.next_token > 0
       && ticket.next_token <= ticket.revision + 1
       && ticket.membership_revision > 0
       && ticket.membership_revision <= ticket.revision)
      Corrupt_store
      "claim token counter exceeds committed ticket history";
    require
      (ticket.created_sequence > 0 && ticket.created_sequence <= t.revision + 1)
      Corrupt_store
      "invalid ticket creation sequence";
    bounded ticket.updated_at 128;
    bounded ticket.acceptance_criteria 65_536;
    require
      (ticket.priority >= 0 && ticket.priority <= 4)
      Invalid_argument
      "priority must be 0 (none) through 4 (low)";
    require
      (List.length ticket.labels <= 100
       && List.length ticket.labels = Set.length (Id.Label.Set.of_list ticket.labels))
      Invalid_argument
      "duplicate labels or more than 100 labels";
    List.iter ticket.labels ~f:(fun id ->
      ignore (Workflow.label t.workflow id : Workflow.Label.t));
    Option.iter ticket.assignee ~f:(fun id ->
      ignore (Workflow.actor t.workflow id : Workflow.Actor.t));
    Option.iter ticket.status_id ~f:(fun id ->
      require
        (Domain_command.Status.equal
           (Workflow.status t.workflow id).category
           ticket.status)
        Conflict
        "status category differs from catalog");
    require
      (ticket.created_order > 0 && ticket.created_order <= Map.length t.tickets)
      Corrupt_store
      "invalid ticket creation order";
    Option.iter ticket.reopened_token ~f:(fun token ->
      require
        (token > 0 && token <= ticket.next_token)
        Corrupt_store
        "invalid reopening token");
    List.iter ticket.reassessments ~f:(fun r ->
      bounded r.Reassessment.reason 65536;
      bounded r.timestamp 128;
      require
        (r.reopened_revision > 0
         && r.reopened_revision <= t.revision + 1
         && not (String.is_empty (String.strip r.reason)))
        Corrupt_store
        "invalid reassessment";
      ignore (find_ticket t r.prerequisite : Ticket.t));
    require
      (ticket.revision > 0 && ticket.next_token > 0)
      Corrupt_store
      "invalid ticket counters";
    Option.iter ticket.project ~f:(fun id ->
      require (Map.mem t.projects id) Not_found "project not found");
    Option.iter ticket.milestone ~f:(fun id ->
      let milestone = find_milestone t id in
      require
        (Option.value_map
           ticket.project
           ~default:false
           ~f:(Id.Project.equal milestone.project))
        Conflict
        "milestone belongs to another project");
    require
      (Option.is_none ticket.claim || active_scope t ticket)
      Conflict
      "cannot archive claimed work";
    if active_scope t ticket
    then
      List.iter ticket.prerequisites ~f:(fun id ->
        let prerequisite = find_ticket t id in
        require
          (waived ticket id
           || active_scope t prerequisite
           || Domain_command.Status.equal prerequisite.status Done)
          Conflict
          "archive would hide an unfinished prerequisite");
    Option.iter ticket.parent ~f:(fun id ->
      let parent = find_ticket t id in
      require
        (Option.equal Id.Project.equal parent.project ticket.project)
        Conflict
        "parent project differs";
      check_acyclic t ~from:id ~target:ticket.id ~parents:true);
    require
      (List.length ticket.prerequisites
       = Set.length (Id.Ticket.Set.of_list ticket.prerequisites))
      Corrupt_store
      "duplicate prerequisite";
    List.iter ticket.prerequisites ~f:(fun id ->
      ignore (find_ticket t id : Ticket.t);
      check_acyclic t ~from:id ~target:ticket.id ~parents:false);
    Option.iter ticket.claim ~f:(fun claim ->
      require
        (Domain_command.Status.equal ticket.status In_progress)
        Corrupt_store
        "claimed ticket is not in progress";
      require
        (claim.Claim.token < ticket.next_token && claim.token > 0)
        Corrupt_store
        "invalid claim token";
      require
        (Int.equal claim.token (Allocation_lease.epoch claim.lease))
        Corrupt_store
        "claim lease epoch differs from fencing token"));
  Map.iter t.handoffs ~f:(fun handoff ->
    require
      (List.length handoff.Handoff.resources <= 100)
      Invalid_argument
      "too many handoff resources";
    List.iter handoff.resources ~f:(fun id -> validate_target t (Resource id)));
  require
    (Map.length t.resources <= Admission.Limit.maximum Resources)
    Invalid_argument
    "resource count exceeds 10000";
  Map.iter t.resources ~f:(fun resource ->
    Resource.validate resource;
    List.iter resource.metadata.targets ~f:(validate_target t));
  require
    (resource_admission_bytes t.resources
     <= Admission.Limit.maximum Referenced_resource_bytes)
    Invalid_argument
    "referenced blob storage exceeds 512MiB"
;;

let validate_new_claim_run t (claim : Claim.t) =
  Option.iter claim.run_id ~f:(fun id ->
    Option.iter (Agent_run.get_run t.agent_runs id) ~f:(fun registered ->
      require
        (Id.Actor.equal registered.actor claim.actor)
        Conflict
        "registered claimant run belongs to another actor";
      require
        (not (Agent_run.Status.terminal registered.status))
        Conflict
        "cannot grant a claim to a terminal run"))
;;

let validate_terminal_reconciliation_owner t (attempt : Attempt.t) ~actor ~run =
  let registered =
    match Agent_run.get_run t.agent_runs attempt.run with
    | Some registered -> registered
    | None -> Json.fail Not_found "reconciliation consumer run not found"
  in
  require
    (Id.Actor.equal registered.actor actor
     && Option.exists run ~f:(Id.Run.equal attempt.run))
    Stale_claim
    "terminal reconciliation actor or run differs from its recorded consumer"
;;

let unwrap_domain = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

let to_json t =
  Json.obj
    [ "workspace_id", Id.Workspace.jsonaf_of_t t.workspace
    ; "name", Json.string (name t)
    ; "revision", Json.int t.revision
    ; "settings", Workspace_settings.jsonaf_of_t t.settings
    ; "workflow", Workflow.to_json t.workflow
    ; "projects", `Array (List.map (Map.data t.projects) ~f:Project.jsonaf_of_t)
    ; "milestones", `Array (List.map (Map.data t.milestones) ~f:Milestone.jsonaf_of_t)
    ; "tickets", `Array (List.map (Map.data t.tickets) ~f:Ticket.jsonaf_of_t)
    ; ( "ticket_recoveries"
      , `Array (List.map (Map.data t.ticket_recoveries) ~f:Ticket_recovery.jsonaf_of_t) )
    ; "facts", Facts.to_json t.facts
    ; "communication", Communication.to_json t.communication
    ; "agent_runs", Agent_run.to_json t.agent_runs
    ; "evidence", Evidence.to_json t.evidence
    ; "policies", Agent_run_policy.to_json t.policies
    ; "comments", Discussion.to_json t.discussion
    ; "handoffs", `Array (List.map (Map.data t.handoffs) ~f:Handoff.jsonaf_of_t)
    ; "resources", `Array (List.map (Map.data t.resources) ~f:Resource.jsonaf_of_t)
    ; "activity", `Array (List.rev t.activity)
    ]
;;

let blob_digests t =
  Map.data t.resources
  |> List.concat_map ~f:(fun r ->
    List.map r.Resource.versions ~f:(fun v -> v.Resource.Version.digest))
  |> List.dedup_and_sort ~compare:String.compare
;;

let blob_references t =
  Map.data t.resources
  |> List.concat_map ~f:(fun r ->
    List.map r.Resource.versions ~f:(fun v -> v.Resource.Version.digest, v.size_bytes))
;;

let resource_version t id ~revision =
  Json.decode (fun () ->
    let resource =
      match Map.find t.resources id with
      | Some r -> r
      | None -> Json.fail Not_found "resource not found"
    in
    Resource.get_version resource ~revision)
;;

let validate_run_actor t ~run ~actor =
  Json.decode (fun () ->
    let registered =
      match Agent_run.get_run t.agent_runs run with
      | Some r -> r
      | None -> Json.fail Not_found "run not registered"
    in
    require
      (Id.Actor.equal registered.actor actor)
      Conflict
      "run actor attribution differs")
;;

let agent_runs t = t.agent_runs
let evidence t = t.evidence
let communication t = t.communication
let policies t = t.policies

let coordination_tickets ?run ?now_unix_ms t =
  Map.data t.tickets
  |> List.filter ~f:(fun ticket -> not ticket.Ticket.archived)
  |> List.map ~f:(fun ticket ->
    { Coordinator.Ticket.id = ticket.id
    ; project = ticket.project
    ; title = ticket.title
    ; status = ticket.status
    ; prerequisites = ticket.prerequisites
    ; ready =
        List.for_all (eligibility_reasons ?run ?now_unix_ms t ticket) ~f:(function
          | Eligibility_reason.Coordination _ | Coordination_clock_required _ -> true
          | Archived_scope | Status _ | Held _ | Claimed _ | Prerequisite _ -> false)
    ; blockers = readiness_view ?run ?now_unix_ms t ticket
    ; claim =
        Option.map ticket.claim ~f:(fun c ->
          { Coordinator.Claim.actor = c.actor
          ; run = c.run_id
          ; token = c.token
          ; lease = c.lease
          })
    })
;;

let admission t =
  let meter limit used = unwrap_domain (Admission.create limit ~used) in
  [ meter Planning_payload_bytes t.retained_bytes
  ; meter Tickets (Map.length t.tickets)
  ; meter Projects (Map.length t.projects)
  ; meter Milestones (Map.length t.milestones)
  ; meter Resources (Map.length t.resources)
  ; meter Referenced_resource_bytes (resource_admission_bytes t.resources)
  ]
  @ Facts.admission t.facts
;;

let project_view (value : Project.t) : Planning_wire.Project.t =
  { project_id = value.id
  ; title = value.title
  ; description = value.description
  ; revision = value.revision
  ; status = value.status
  ; priority = value.priority
  ; summary = value.summary
  ; acceptance_criteria = value.acceptance_criteria
  ; archived = value.archived
  }
;;

let milestone_view (value : Milestone.t) : Planning_wire.Milestone.t =
  { milestone_id = value.id
  ; project_id = value.project
  ; title = value.title
  ; description = value.description
  ; target_date = value.target_date
  ; status = value.status
  ; revision = value.revision
  ; archived = value.archived
  }
;;

let workspace_settings_view (value : Workspace_settings.t)
  : Planning_wire.Workspace_settings.t
  =
  { description = value.description
  ; instructions = value.instructions
  ; summary = value.summary
  ; revision = value.revision
  ; name = value.name
  ; archived = value.archived
  }
;;

let project_view_json value = Planning_wire.Response.data (Project (project_view value))

let milestone_view_json value =
  match Api_codec.encode Planning_wire.Milestone.codec (milestone_view value) with
  | Ok json -> json
  | Error problem -> raise (Api_method.Invalid_response ("milestone projection", problem))
;;
