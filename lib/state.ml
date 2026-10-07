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

module Ticket = struct
  type t =
    { id : Id.Ticket.t
    ; display_key : string
    ; title : string
    ; description : string
    ; project : Id.Project.t option
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
    ; created_sequence : Revision.t
    ; created_at : string
    ; updated_at : string
    ; next_token : Revision.t
    }
  [@@deriving sexp, jsonaf]
end

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
  ; discussion : Discussion.t
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

type prepared =
  { candidate : t
  ; events : Jsonaf.t
  ; result : Jsonaf.t
  ; blobs : (string * string) list
  }

let candidate t = t.candidate
let events t = t.events
let result t = t.result
let blobs t = t.blobs
let revision t = t.revision
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
      ; discussion = Discussion.empty
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

let ready t (ticket : Ticket.t) =
  active_scope t ticket
  && Domain_command.Status.equal ticket.status Todo
  && Option.is_none ticket.hold
  && Option.is_none ticket.claim
  && List.is_empty (blockers t ticket)
;;

let readiness t (ticket : Ticket.t) =
  let reason kind fields = Json.obj (("kind", Json.string kind) :: fields) in
  let reasons =
    (if active_scope t ticket then [] else [ reason "archived_scope" [] ])
    @ (if Domain_command.Status.equal ticket.status Todo
       then []
       else
         [ reason "status" [ "category", Domain_command.Status.jsonaf_of_t ticket.status ]
         ])
    @ (Option.to_list ticket.hold
       |> List.map ~f:(fun hold -> reason "hold" [ "details", Hold.jsonaf_of_t hold ]))
    @ (Option.to_list ticket.claim
       |> List.map ~f:(fun claim ->
         reason "claimed" [ "details", Claim.jsonaf_of_t claim ]))
    @ List.map (blockers t ticket) ~f:(fun id ->
      reason "prerequisite" [ "ticket_id", Id.Ticket.jsonaf_of_t id ])
  in
  Json.obj
    [ ("ready", if ready t ticket then `True else `False); "reasons", `Array reasons ]
;;

let sort_ready tickets =
  List.sort tickets ~compare:(fun a b ->
    let rank priority = if priority = 0 then 5 else priority in
    match Int.compare (rank a.Ticket.priority) (rank b.Ticket.priority) with
    | 0 ->
      (match Int.compare a.created_sequence b.created_sequence with
       | 0 -> Id.Ticket.compare a.id b.id
       | order -> order)
    | order -> order)
;;

let check_complete t (ticket : Ticket.t) =
  (match Evidence.ensure_can_complete t.evidence ~ticket:ticket.id with
   | Ok () -> ()
   | Error error -> raise (Json.Decode_error error));
  require (Option.is_none ticket.hold) Blocked "explicit hold";
  require (List.is_empty (blockers t ticket)) Blocked "unfinished prerequisites";
  require
    (not
       (Map.exists t.tickets ~f:(fun child ->
          Option.value_map
            child.Ticket.parent
            ~default:false
            ~f:(Id.Ticket.equal ticket.id)
          && not (Domain_command.Status.equal child.status Done))))
    Blocked
    "unfinished child tickets"
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
    List.iter (Evidence.event_references t.evidence) ~f:(fun ref_ ->
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

let validate t =
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
     Evidence.validate_references
       t.evidence
       ~attempt:(Agent_run.get_attempt t.agent_runs)
       ~entity_exists:(fun target ->
         Result.is_ok (Json.decode (fun () -> validate_target t target)))
       ~review_request_exists:(fun id ->
         Option.is_some (Communication.get_request t.communication id))
       ~pin_exists:(function
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
    (Map.length t.tickets <= 10_000
     && Map.length t.projects <= 1_000
     && Map.length t.milestones <= 1_000)
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
      (ticket.next_token > 0 && ticket.next_token <= ticket.revision + 1)
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
    (Map.length t.resources <= 10_000)
    Invalid_argument
    "resource count exceeds 10000";
  let sizes =
    Map.fold t.resources ~init:String.Map.empty ~f:(fun ~key:_ ~data:resource sizes ->
      Resource.validate resource;
      List.iter resource.metadata.targets ~f:(validate_target t);
      List.fold resource.versions ~init:sizes ~f:(fun sizes version ->
        let size = Option.value version.Resource.Version.size_bytes ~default:65_536 in
        Map.update sizes version.digest ~f:(function
          | None -> size
          | Some old -> Int.max old size)))
  in
  require
    (Map.fold sizes ~init:0 ~f:(fun ~key:_ ~data:size total -> total + size)
     <= 512 * 1024 * 1024)
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

let apply_event t = function
  | Event.Policy_changed change ->
    (match Agent_run_policy.apply t.policies change with
     | Ok policies -> { t with policies }
     | Error error -> raise (Json.Decode_error error))
  | Event.Policy_unchanged change ->
    let p =
      match Agent_run_policy.prepare t.policies change.command with
      | Ok p -> p
      | Error error -> raise (Json.Decode_error error)
    in
    require
      (List.is_empty (Agent_run_policy.changes p)
       && Int.equal
            change.revision
            (Json.integer (Json.field (Agent_run_policy.result p) "revision")))
      Corrupt_store
      "policy no-op is not an identical duplicate";
    t
  | Event.Allocation_empty _ -> t
  | Event.Agent_run_changed change ->
    (match change.Agent_run.Change.update with
     | Attempt_put attempt ->
       if Option.is_none (Agent_run.get_attempt t.agent_runs attempt.id)
       then (
         match
           Agent_run_policy.validate_allocation t.policies attempt.run ~runs:t.agent_runs
         with
         | Ok () -> ()
         | Error error -> raise (Json.Decode_error error))
     | Run_put _ | Reservation_put _ | Actions_set _ | Pool_put _ | Ticket_policy_put _ ->
       ());
    (match Agent_run.apply t.agent_runs change with
     | Ok agent_runs -> { t with agent_runs }
     | Error error -> raise (Json.Decode_error error))
  | Event.Evidence_changed change ->
    (match change.Evidence.Change.update with
     | Reconciliation_put reconciliation ->
       let attempt =
         match Agent_run.get_attempt t.agent_runs reconciliation.attempt with
         | Some attempt -> attempt
         | None -> Json.fail Not_found "reconciliation consumer attempt not found"
       in
       if Attempt.State.terminal attempt.state
       then (
         match reconciliation.state with
         | Acknowledged _ | Continued _ ->
           validate_terminal_reconciliation_owner
             t
             attempt
             ~actor:change.attribution.actor
             ~run:change.attribution.run
         | Pending | Revised _ ->
           Json.fail Stale_claim "terminal consumer cannot revise reconciliation inputs")
     | Contract_put _
     | Manifest_put _
     | Policy_put _
     | Submission_put _
     | Review_added _
     | Validation_added _
     | Decision_put _
     | Input_changed _ -> ());
    (match Evidence.apply t.evidence change with
     | Ok evidence -> { t with evidence }
     | Error error -> raise (Json.Decode_error error))
  | Event.Communication_changed change ->
    (match Communication.apply t.communication change with
     | Ok communication -> { t with communication }
     | Error error -> raise (Json.Decode_error error))
  | Event.Settings_changed change ->
    { t with workflow = Workflow.apply t.workflow change }
  | Workspace_updated settings ->
    expected settings.revision (t.settings.revision + 1);
    { t with settings }
  | Project_put p ->
    let previous =
      Option.value_map (Map.find t.projects p.id) ~default:0 ~f:(fun p ->
        p.Project.revision)
    in
    expected p.revision (previous + 1);
    { t with projects = Map.set t.projects ~key:p.id ~data:p }
  | Milestone_put milestone ->
    let previous =
      Option.value_map (Map.find t.milestones milestone.id) ~default:0 ~f:(fun m ->
        m.Milestone.revision)
    in
    expected milestone.revision (previous + 1);
    { t with milestones = Map.set t.milestones ~key:milestone.id ~data:milestone }
  | Ticket_put ticket ->
    let display_key =
      Option.value_map
        (Map.find t.tickets ticket.id)
        ~default:("WG-" ^ Int.to_string (Map.length t.tickets + 1))
        ~f:(fun old -> old.Ticket.display_key)
    in
    require
      (String.equal ticket.display_key display_key)
      Corrupt_store
      "ticket display key changed or was allocated out of sequence";
    if not (Map.mem t.tickets ticket.id)
    then Option.iter ticket.claim ~f:(validate_new_claim_run t);
    Option.iter (Map.find t.tickets ticket.id) ~f:(fun previous ->
      require
        (ticket.next_token >= previous.Ticket.next_token)
        Corrupt_store
        "claim token counter moved backwards";
      require
        (String.equal ticket.created_at previous.created_at)
        Corrupt_store
        "ticket creation time changed";
      require
        (Int.equal ticket.created_sequence previous.created_sequence)
        Corrupt_store
        "ticket creation sequence changed";
      Option.iter ticket.claim ~f:(fun claim ->
        let unchanged =
          Option.value_map previous.claim ~default:false ~f:(fun old ->
            Id.Actor.equal old.Claim.actor claim.actor
            && Option.equal Id.Run.equal old.run_id claim.run_id
            && Int.equal old.token claim.token)
        in
        require
          (unchanged || claim.token >= previous.next_token)
          Corrupt_store
          "claim token was reused";
        if unchanged
        then (
          let old = Option.value_exn previous.claim in
          if not (Allocation_lease.equal old.lease claim.lease)
          then (
            let renewed =
              match
                Allocation_lease.renew
                  old.lease
                  ~expected_revision:(Allocation_lease.revision old.lease)
                  ~epoch:old.token
                  ~now_unix_ms:(Allocation_lease.last_unix_ms claim.lease)
              with
              | Ok value -> value
              | Error _ -> Json.fail Corrupt_store "invalid claim lease renewal"
            in
            require
              (Allocation_lease.equal renewed claim.lease)
              Corrupt_store
              "claim lease renewal payload differs"))
        else (
          validate_new_claim_run t claim;
          require
            (Int.equal (Allocation_lease.revision claim.lease) 1)
            Corrupt_store
            "new claim lease revision must start at one")));
    let previous =
      Option.value_map (Map.find t.tickets ticket.id) ~default:0 ~f:(fun t ->
        t.Ticket.revision)
    in
    expected ticket.revision (previous + 1);
    { t with
      tickets = Map.set t.tickets ~key:ticket.id ~data:ticket
    ; ticket_keys = Map.set t.ticket_keys ~key:display_key ~data:ticket.id
    }
  | Comment_changed change ->
    { t with
      discussion = Discussion.apply t.discussion change ~sequence:(t.revision + 1)
    }
  | Handoff_put handoff ->
    ignore (find_ticket t handoff.ticket : Ticket.t);
    bounded handoff.summary 65_536;
    bounded handoff.next_steps 65_536;
    bounded handoff.evidence 65_536;
    List.iter
      [ handoff.objective; handoff.completed; handoff.decisions; handoff.blockers ]
      ~f:(fun text -> bounded text 65_536);
    bounded handoff.timestamp 128;
    require
      (handoff.covers_through >= 0 && handoff.covers_through <= t.revision)
      Conflict
      "handoff cursor is ahead of observed state";
    let previous =
      Option.value_map (Map.find t.handoffs handoff.ticket) ~default:0 ~f:(fun h ->
        h.Handoff.revision)
    in
    expected handoff.revision (previous + 1);
    { t with handoffs = Map.set t.handoffs ~key:handoff.ticket ~data:handoff }
  | Resource_changed change ->
    (match change with
     | Resource.Change.Published { version; _ } ->
       require
         (Option.is_some version.size_bytes)
         Corrupt_store
         "published resource requires byte size"
     | Metadata_changed _ -> ());
    let id =
      match change with
      | Resource.Change.Published { id; _ } | Metadata_changed { id; _ } -> id
    in
    let resource = Resource.apply (Map.find t.resources id) change in
    { t with resources = Map.set t.resources ~key:id ~data:resource }
;;

let audit_payload previous current payload changes =
  let communication_before = ref previous.communication in
  let evidence_before = ref previous.evidence in
  let runs_before = ref previous.agent_runs in
  let direct =
    List.concat_map changes ~f:(function
      | Event.Policy_changed change | Policy_unchanged change ->
        (match change.Agent_run_policy.Change.command with
         | Template_register template -> [ Entity_ref.Resource template.resource ]
         | Instance_register instance ->
           List.map instance.tickets ~f:(fun p ->
             Entity_ref.Ticket p.Workflow_template.Planned_ticket.ticket)
         | Budget_put _ | Usage_report _ -> [ Entity_ref.Workspace ])
      | Event.Allocation_empty _ -> [ Entity_ref.Workspace ]
      | Event.Evidence_changed change ->
        let targets = Evidence.change_targets !evidence_before change in
        (match Evidence.apply !evidence_before change with
         | Ok state -> evidence_before := state
         | Error error -> raise (Json.Decode_error error));
        targets
      | Event.Agent_run_changed change ->
        let targets =
          match change.Agent_run.Change.update with
          | Agent_run.Change.Update.Attempt_put attempt ->
            [ Entity_ref.Ticket attempt.ticket ]
          | Run_put _
          | Reservation_put _
          | Actions_set _
          | Pool_put _
          | Ticket_policy_put _ -> [ Entity_ref.Workspace ]
        in
        (match Agent_run.apply !runs_before change with
         | Ok state -> runs_before := state
         | Error error -> raise (Json.Decode_error error));
        targets
      | Event.Communication_changed change ->
        let targets = Communication.change_targets !communication_before change in
        (match Communication.apply !communication_before change with
         | Ok state -> communication_before := state
         | Error error -> raise (Json.Decode_error error));
        targets
      | Event.Project_put p -> [ Entity_ref.Project p.id ]
      | Milestone_put m -> [ Milestone m.id; Project m.project ]
      | Ticket_put ticket ->
        Entity_ref.Ticket ticket.id
        :: (Option.to_list ticket.project |> List.map ~f:(fun id -> Entity_ref.Project id))
      | Comment_changed (Discussion.Change.Create { target; _ }) -> [ target ]
      | Comment_changed (Revise { id; _ }) -> [ Discussion.target current.discussion id ]
      | Handoff_put h -> [ Ticket h.ticket ]
      | Resource_changed
          ( Resource.Change.Published { id; metadata; _ }
          | Metadata_changed { id; metadata; _ } ) ->
        Entity_ref.Resource id
        :: (metadata.targets
            @ Option.value_map (Map.find previous.resources id) ~default:[] ~f:(fun r ->
              r.Resource.metadata.targets))
      | Settings_changed _ | Workspace_updated _ -> [ Workspace ])
  in
  let parents state target =
    match target with
    | Entity_ref.Ticket id ->
      Option.value_map (Map.find state.tickets id) ~default:[] ~f:(fun ticket ->
        (Option.to_list ticket.Ticket.project
         |> List.map ~f:(fun id -> Entity_ref.Project id))
        @ (Option.to_list ticket.milestone
           |> List.map ~f:(fun id -> Entity_ref.Milestone id)))
    | Milestone id ->
      Option.value_map (Map.find state.milestones id) ~default:[] ~f:(fun m ->
        [ Entity_ref.Project m.Milestone.project ])
    | Workspace | Project _ | Resource _ -> []
  in
  let targets =
    Entity_ref.Workspace
    :: List.concat_map direct ~f:(fun target ->
      target :: (parents previous target @ parents current target))
    |> List.dedup_and_sort ~compare:Entity_ref.compare
  in
  match payload with
  | `Object fields ->
    Json.obj (fields @ [ "targets", `Array (List.map targets ~f:Entity_ref.jsonaf_of_t) ])
  | _ -> assert false
;;

let replay t payload =
  Json.decode (fun () ->
    let wire =
      match Storage_event.of_json payload with
      | Ok wire -> wire
      | Error error -> raise (Json.Decode_error error)
    in
    let payload = Storage_event.to_json wire in
    expected (Json.integer (Json.field payload "revision")) (t.revision + 1);
    let events =
      try List.map (Json.list (Json.field payload "changes")) ~f:Event.t_of_jsonaf with
      | Jsonaf_kernel.Conv.Of_jsonaf_error (exn, _) ->
        Json.fail Corrupt_store (Exn.to_string exn)
    in
    require
      (List.length events > 0 && List.length events <= 10_064)
      Corrupt_store
      "invalid event count";
    let rec apply_resolved state = function
      | [] -> state
      | event :: remaining ->
        let publication =
          match event with
          | Event.Resource_changed (Resource.Change.Published { id; version; _ }) ->
            Option.map (Map.find state.resources id) ~f:(fun old ->
              let old = Resource.get_version old ~revision:None in
              let pin (version : Resource.Version.t) =
                Evidence.Pin.Resource
                  { id; revision = version.revision; digest = version.digest }
              in
              pin old, pin version)
          | Comment_changed (Discussion.Change.Revise { id; version }) ->
            Some
              ( Evidence.Pin.Comment
                  { id; revision = Discussion.revision state.discussion id }
              , Evidence.Pin.Comment { id; revision = version.revision } )
          | _ -> None
        in
        Option.iter publication ~f:(fun (previous, current) ->
          require
            (match remaining with
             | Evidence_changed { update = Evidence_event.Update.Input_changed pins; _ }
               :: _ ->
               Evidence.Pin.equal previous pins.previous
               && Evidence.Pin.equal current pins.current
             | _ -> false)
            Corrupt_store
            "publication lacks its exact atomic input change");
        apply_resolved (apply_event state event) remaining
    in
    let state = apply_resolved t events in
    validate state;
    Map.iter state.tickets ~f:(fun ticket ->
      if
        Domain_command.Status.equal ticket.Ticket.status Done
        && not
             (Option.value_map
                (Map.find t.tickets ticket.id)
                ~default:false
                ~f:(fun previous ->
                  Domain_command.Status.equal previous.Ticket.status Done))
      then check_complete state ticket);
    List.iter events ~f:(function
      | Event.Agent_run_changed { update = Agent_run_event.Update.Attempt_put attempt; _ }
        when Attempt.State.equal attempt.state Completed ->
        (match
           Evidence.ensure_attempt_can_complete
             state.evidence
             ~attempt:attempt.id
             ~ticket:attempt.ticket
         with
         | Ok () -> ()
         | Error error -> raise (Json.Decode_error error))
      | _ -> ());
    let retained_bytes = t.retained_bytes + String.length (Json.canonical payload) in
    require
      (retained_bytes <= 64 * 1024 * 1024)
      Invalid_argument
      "MVP workspace event data exceeds 64 MiB";
    let audit = audit_payload t state payload events in
    let activity_by_target =
      List.fold
        (Json.list (Json.field audit "targets"))
        ~init:t.activity_by_target
        ~f:(fun index json ->
          Map.update index (Entity_ref.t_of_jsonaf json) ~f:(fun previous ->
            audit :: Option.value previous ~default:[]))
    in
    { state with
      revision = t.revision + 1
    ; activity = audit :: t.activity
    ; activity_by_target
    ; retained_bytes
    })
;;

let unwrap_domain = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

let check_claim_at ticket ~actor ~run ~token ~now_unix_ms =
  check_claim ticket ~actor ~run ~token;
  let claim = Option.value_exn ticket.Ticket.claim in
  match Allocation_lease.policy claim.lease with
  | Indefinite -> ()
  | Duration_ms _ ->
    let now =
      match now_unix_ms with
      | Some now -> now
      | None -> Json.fail Invalid_argument "timed ownership requires server clock"
    in
    unwrap_domain
      (Allocation_lease.validate_owner claim.lease ~epoch:token ~now_unix_ms:now)
;;

let new_lease ~token ~duration ~now_unix_ms =
  let policy =
    Option.value_map duration ~default:Allocation_lease.Policy.Indefinite ~f:(fun ms ->
      Allocation_lease.Policy.Duration_ms ms)
  in
  let now =
    match duration, now_unix_ms with
    | Some _, None -> Json.fail Invalid_argument "timed ownership requires server clock"
    | _, Some now -> now
    | None, None -> 0L
  in
  unwrap_domain (Allocation_lease.create ~epoch:token ~now_unix_ms:now ~policy ())
;;

let attempt_owner t id ~actor ~run ~now_unix_ms ?(check_lease = true) () =
  let attempt =
    match Agent_run.get_attempt t.agent_runs id with
    | Some a -> a
    | None -> Json.fail Not_found "attempt not found"
  in
  let attributed_run =
    match run with
    | Some run -> run
    | None -> Json.fail Stale_claim "attempt mutation requires run attribution"
  in
  unwrap_domain
    (Agent_run.validate_attempt_owner
       t.agent_runs
       id
       ~actor
       ~run:attributed_run
       ~ticket:attempt.ticket
       ~token:attempt.token);
  if check_lease
  then
    check_claim_at
      (find_ticket t attempt.ticket)
      ~actor
      ~run
      ~token:attempt.token
      ~now_unix_ms
  else check_claim (find_ticket t attempt.ticket) ~actor ~run ~token:attempt.token;
  attempt
;;

let active_attempts t ticket =
  Agent_run.attempts_for_ticket t.agent_runs ticket
  |> List.filter ~f:(fun a -> not (Attempt.State.terminal a.Attempt.state))
;;

let instantiate_plan t ~template ~template_revision ~id ~parameters =
  let registered =
    match
      Agent_run_policy.get_template t.policies template ~revision:template_revision
    with
    | Some x -> x
    | None -> Json.fail Not_found "template version is not registered"
  in
  let plan = unwrap_domain (Workflow_template.instantiate registered ~id ~parameters) in
  let creates =
    List.map plan.tickets ~f:(fun node ->
      Domain_command.Ticket_create
        { id = node.Workflow_template.Planned_ticket.ticket
        ; title = node.title
        ; description = node.description
        ; project = None
        ; parent = node.parent
        ; milestone = None
        })
  in
  let dependencies =
    List.concat_map plan.tickets ~f:(fun node ->
      List.map node.Workflow_template.Planned_ticket.dependencies ~f:(fun prerequisite ->
        Domain_command.Dependency_add { ticket = node.ticket; prerequisite }))
  in
  let capabilities =
    List.filter_map plan.tickets ~f:(fun node ->
      if List.is_empty node.Workflow_template.Planned_ticket.capabilities
      then None
      else
        Some
          (Domain_command.Agent_run
             (Agent_run.Command.Ticket_policy_put
                { ticket = node.ticket
                ; expected_revision = 0
                ; required_capabilities = node.capabilities
                ; pools = []
                })))
  in
  let reviews =
    List.filter_map plan.tickets ~f:(fun node ->
      if List.is_empty node.Workflow_template.Planned_ticket.reviewers
      then None
      else
        Some
          (Domain_command.Evidence
             (Evidence.Command.Policy_put
                { ticket = node.ticket
                ; expected_revision = 0
                ; enabled = true
                ; reviewers =
                    List.map node.reviewers ~f:(fun actor ->
                      Evidence.Policy.Requirement.Named_actor actor)
                ; separate_actor = node.separate_actor
                ; validators = []
                })))
  in
  let commands =
    creates
    @ dependencies
    @ capabilities
    @ reviews
    @ [ Domain_command.Policy (Agent_run_policy.Command.Instance_register plan) ]
  in
  require
    (List.length commands <= 32)
    Invalid_argument
    "expanded template exceeds 32 atomic operations";
  plan, commands
;;

let rec stage t command ~actor ~run ~timestamp ~now_unix_ms =
  let update (ticket : Ticket.t) =
    Event.Ticket_put
      { ticket with Ticket.revision = ticket.revision + 1; updated_at = timestamp }
  in
  let version ~revision body ~tombstone =
    { Discussion.Version.revision
    ; serial = Discussion.next_serial t.discussion
    ; sequence = t.revision + 1
    ; actor
    ; timestamp
    ; body
    ; tombstone
    }
  in
  let create_comment ~id ~target ~reply_to ~kind body =
    let id =
      Option.value
        id
        ~default:(Discussion.generated_id t.discussion ~sequence:(t.revision + 1))
    in
    ( Event.Comment_changed
        (Discussion.Change.Create
           { id
           ; target
           ; reply_to
           ; kind
           ; version = version ~revision:1 body ~tombstone:false
           })
    , id )
  in
  let comment ticket kind body =
    fst
      (create_comment
         ~id:None
         ~target:(Entity_ref.Ticket ticket)
         ~reply_to:None
         ~kind
         body)
  in
  let publish ~id ~expected_revision ~title ~filename ~mime_type ~digest ~size_bytes =
    let previous = Map.find t.resources id in
    expected
      (Option.value_map previous ~default:0 ~f:(fun r -> r.Resource.revision))
      expected_revision;
    let metadata =
      Option.value_map
        previous
        ~default:
          { Resource.Metadata.title
          ; filename
          ; mime_type
          ; description = ""
          ; archived = false
          ; targets = []
          }
        ~f:(fun r -> { r.Resource.metadata with title; filename; mime_type })
    in
    require (not metadata.archived) Conflict "resource is archived";
    let version =
      { Resource.Version.revision =
          Option.value_map previous ~default:1 ~f:(fun r ->
            List.length r.Resource.versions + 1)
      ; digest
      ; size_bytes = Some size_bytes
      ; actor
      ; timestamp
      ; filename
      ; mime_type
      }
    in
    ( Event.Resource_changed
        (Published { id; revision = expected_revision + 1; metadata; version })
    , Json.obj
        [ "resource_id", Id.Resource.jsonaf_of_t id
        ; "revision", Json.int (expected_revision + 1)
        ; "version", Resource.Version.jsonaf_of_t version
        ] )
  in
  let changes, result, blobs =
    match command with
    | Domain_command.Template_instantiate { template; template_revision; id; parameters }
      ->
      let plan, commands =
        instantiate_plan t ~template ~template_revision ~id ~parameters
      in
      (match Agent_run_policy.get_instance t.policies id with
       | Some existing ->
         require
           (Workflow_template.Instance.equal existing plan)
           Idempotency_conflict
           "instance retry parameters differ";
         let _, events, result, _ =
           stage t (Policy (Instance_register plan)) ~actor ~run ~timestamp ~now_unix_ms
         in
         events, result, []
       | None ->
         let _, events, results, blobs =
           List.fold
             commands
             ~init:(t, [], [], [])
             ~f:(fun (state, events, results, blobs) command ->
               let state, changes, result, new_blobs =
                 stage state command ~actor ~run ~timestamp ~now_unix_ms
               in
               ( state
               , List.rev_append changes events
               , result :: results
               , List.rev_append new_blobs blobs ))
         in
         ( List.rev events
         , Json.obj
             [ "instance", Workflow_template.Instance.to_json plan
             ; "results", `Array (List.rev results)
             ]
         , List.rev blobs ))
    | Domain_command.Policy command ->
      (match command with
       | Agent_run_policy.Command.Usage_report record ->
         require
           (Id.Actor.equal record.actor actor)
           Conflict
           "usage reporter attribution differs"
       | Instance_register plan ->
         List.iter plan.tickets ~f:(fun node ->
           let actual = find_ticket t node.Workflow_template.Planned_ticket.ticket in
           require
             (String.equal actual.title node.title
              && String.equal actual.description node.description
              && Option.equal Id.Ticket.equal actual.parent node.parent
              && List.equal
                   Id.Ticket.equal
                   (List.dedup_and_sort actual.prerequisites ~compare:Id.Ticket.compare)
                   (List.dedup_and_sort node.dependencies ~compare:Id.Ticket.compare))
             Conflict
             "instance ticket graph differs from its plan";
           let policy = Agent_run.get_ticket_policy t.agent_runs node.ticket in
           require
             (if List.is_empty node.capabilities
              then
                Option.is_none policy
                || Option.value_map policy ~default:false ~f:(fun p ->
                  List.is_empty p.Allocation.Ticket_policy.required_capabilities)
              else
                Option.value_map policy ~default:false ~f:(fun p ->
                  List.equal
                    String.equal
                    (List.dedup_and_sort
                       p.Allocation.Ticket_policy.required_capabilities
                       ~compare:String.compare)
                    (List.dedup_and_sort node.capabilities ~compare:String.compare)))
             Conflict
             "instance capabilities differ from plan";
           require
             (List.equal
                Id.Actor.equal
                (Evidence.review_recipients t.evidence ~ticket:node.ticket)
                (List.dedup_and_sort node.reviewers ~compare:Id.Actor.compare))
             Conflict
             "instance reviewers differ from plan")
       | Template_register _ | Budget_put _ -> ());
      let p = unwrap_domain (Agent_run_policy.prepare t.policies command) in
      let events =
        match Agent_run_policy.changes p with
        | [] ->
          [ Event.Policy_unchanged
              { revision =
                  Json.integer (Json.field (Agent_run_policy.result p) "revision")
              ; command
              }
          ]
        | changes -> List.map changes ~f:(fun change -> Event.Policy_changed change)
      in
      events, Agent_run_policy.result p, []
    | Domain_command.Evidence command ->
      List.iter (Evidence.command_attempts t.evidence command) ~f:(fun id ->
        let terminal_reconciliation =
          match command with
          | Evidence.Command.Reconcile { disposition = Acknowledge | Continue _; _ } ->
            (match Agent_run.get_attempt t.agent_runs id with
             | Some attempt when Attempt.State.terminal attempt.state -> Some attempt
             | Some _ | None -> None)
          | Reconcile { disposition = Revised _; _ }
          | Contract_put _
          | Manifest_publish _
          | Policy_put _
          | Submit _
          | Review _
          | Accept _
          | Validate _
          | Decision_put _
          | Input_changed _ -> None
        in
        match terminal_reconciliation with
        | Some attempt -> validate_terminal_reconciliation_owner t attempt ~actor ~run
        | None -> ignore (attempt_owner t id ~actor ~run ~now_unix_ms () : Attempt.t));
      let make_request
            state
            ~key
            ~ticket
            ~manifest
            ~contract
            ~recipients
            ~kind
            ~reply_to
            ~body
        =
        let prefix = "review-" ^ String.prefix (Json.hash key) 32 in
        let board =
          Communication_id.Board.of_string (prefix ^ "-board") |> unwrap_domain
        in
        let thread =
          Communication_id.Thread.of_string (prefix ^ "-thread") |> unwrap_domain
        in
        let request =
          Communication_id.Request.of_string (prefix ^ "-request") |> unwrap_domain
        in
        let comment = Id.Comment.of_string (prefix ^ "-comment") |> unwrap_domain in
        let correlation_id =
          "review:"
          ^ Json.hash
              (Json.canonical
                 (Json.obj
                    [ "ticket", Id.Ticket.jsonaf_of_t ticket
                    ; "manifest", Evidence.Manifest_ref.jsonaf_of_t manifest
                    ; "contract", Evidence.Contract_ref.jsonaf_of_t contract
                    ]))
        in
        let participants =
          List.filter_map recipients ~f:(function
            | Communication.Recipient.Actor a -> Some a
            | Run _ -> None)
          |> List.dedup_and_sort ~compare:Id.Actor.compare
        in
        let thread, revision, comment_parent, creates =
          match reply_to with
          | Some id ->
            let parent =
              Communication.get_request state.communication id |> Option.value_exn
            in
            let record =
              Communication.get_thread state.communication parent.thread
              |> Option.value_exn
            in
            parent.thread, record.revision, Some parent.message, []
          | None ->
            ( thread
            , 1
            , None
            , [ Domain_command.Communication
                  (Board_put
                     { id = board
                     ; expected_revision = 0
                     ; scope = Workspace
                     ; title = "Output reviews"
                     })
              ; Communication
                  (Thread_put
                     { id = thread
                     ; expected_revision = 0
                     ; board
                     ; title = "Review " ^ Id.Ticket.to_string ticket
                     ; participants
                     ; mentions = []
                     ; links = [ Ticket ticket ]
                     ; state = Awaiting_response
                     ; pinned = false
                     })
              ] )
        in
        let commands =
          creates
          @ [ Domain_command.Thread_reply
                { id = thread
                ; expected_revision = revision
                ; comment_id = Some comment
                ; reply_to = comment_parent
                ; kind = Discussion.Kind.Evidence
                ; body
                }
            ; Communication
                (Request_create
                   { id = request
                   ; thread
                   ; kind
                   ; message = comment
                   ; recipients
                   ; teams = []
                   ; resolver = actor
                   ; correlation_id = Some correlation_id
                   ; reply_to
                   ; deadline_unix_ms = None
                   })
            ]
        in
        let state, events =
          List.fold commands ~init:(state, []) ~f:(fun (state, events) command ->
            let state, changes, _, _ =
              stage state command ~actor ~run ~timestamp ~now_unix_ms
            in
            state, List.rev_append changes events)
        in
        state, List.rev events, request
      in
      let prepared_state, before, command =
        match command with
        | Evidence.Command.Submit
            ({ ticket; manifest; review_request = None; expected_revision } as fields) ->
          let m =
            match Evidence.get_manifest t.evidence manifest with
            | Some m -> m
            | None -> Json.fail Not_found "manifest not found"
          in
          let recipients =
            Evidence.review_recipients t.evidence ~ticket
            |> List.map ~f:(fun a -> Communication.Recipient.Actor a)
          in
          if List.is_empty recipients
          then t, [], command
          else (
            let state, events, request =
              make_request
                t
                ~key:
                  (Id.Ticket.to_string ticket
                   ^ ":"
                   ^ Int.to_string expected_revision
                   ^ ":"
                   ^ Json.canonical (Evidence.Manifest_ref.jsonaf_of_t manifest))
                ~ticket
                ~manifest
                ~contract:m.contract
                ~recipients
                ~kind:Communication.Request.Kind.Review
                ~reply_to:None
                ~body:"Review the exact output manifest and contract."
            in
            ( state
            , events
            , Evidence.Command.Submit { fields with review_request = Some request } ))
        | _ -> t, [], command
      in
      let p =
        unwrap_domain
          (Evidence.prepare
             prepared_state.evidence
             command
             ~actor
             ~run
             ~timestamp
             ~sequence:(t.revision + 1))
      in
      let evidence_changes =
        List.map (Evidence.changes p) ~f:(fun change -> Event.Evidence_changed change)
      in
      let with_evidence =
        List.fold evidence_changes ~init:prepared_state ~f:apply_event
      in
      let after =
        match command with
        | Evidence.Command.Review { id; ticket; verdict = Request_changes; evidence; _ }
          ->
          let submission =
            Evidence.get_submission with_evidence.evidence ticket |> Option.value_exn
          in
          let m =
            Evidence.get_manifest with_evidence.evidence submission.manifest
            |> Option.value_exn
          in
          let a = Agent_run.get_attempt t.agent_runs m.attempt |> Option.value_exn in
          let recipients =
            [ Communication.Recipient.Actor submission.author.actor; Run a.run ]
          in
          let _, events, _ =
            make_request
              with_evidence
              ~key:("changes:" ^ Evidence_id.Review.to_string id)
              ~ticket
              ~manifest:submission.manifest
              ~contract:submission.contract
              ~recipients
              ~kind:Communication.Request.Kind.Blocker_resolution
              ~reply_to:submission.review_request
              ~body:evidence
          in
          events
        | Evidence.Command.Accept { ticket; _ } ->
          let submission =
            Evidence.get_submission with_evidence.evidence ticket |> Option.value_exn
          in
          (match submission.review_request with
           | None -> []
           | Some id ->
             let request =
               Communication.get_request with_evidence.communication id
               |> Option.value_exn
             in
             if
               Communication.Request.Status.equal request.status Open
               && Id.Actor.equal request.resolver actor
             then (
               let _, events, _, _ =
                 stage
                   with_evidence
                   (Communication
                      (Request_resolve { id; expected_revision = request.revision }))
                   ~actor
                   ~run
                   ~timestamp
                   ~now_unix_ms
               in
               events)
             else [])
        | _ -> []
      in
      before @ evidence_changes @ after, Evidence.result p, []
    | Domain_command.Agent_run command ->
      (match command with
       | Agent_run.Command.Attempt_start { run = target_run; ticket; token; _ } ->
         unwrap_domain
           (Agent_run_policy.validate_allocation t.policies target_run ~runs:t.agent_runs);
         require
           (Option.value_map run ~default:false ~f:(Id.Run.equal target_run))
           Stale_claim
           "attempt run and attribution differ";
         check_claim_at (find_ticket t ticket) ~actor ~run ~token ~now_unix_ms
       | Attempt_checkpoint { id; _ } ->
         ignore (attempt_owner t id ~actor ~run ~now_unix_ms () : Attempt.t)
       | Attempt_finish { id; state; _ } ->
         let a =
           attempt_owner
             t
             id
             ~actor
             ~run
             ~now_unix_ms
             ~check_lease:(Attempt.State.equal state Completed)
             ()
         in
         if Attempt.State.equal state Completed
         then
           unwrap_domain
             (Evidence.ensure_attempt_can_complete
                t.evidence
                ~attempt:a.id
                ~ticket:a.ticket)
       | Register _
       | Transition _
       | Observe _
       | Link_session _
       | Reservation_acquire _
       | Reservation_release _
       | Reservation_renew _
       | Action_acknowledge _
       | Pool_put _
       | Ticket_policy_put _ -> ());
      let p =
        unwrap_domain
          (Agent_run.prepare
             ?now_unix_ms
             t.agent_runs
             command
             ~actor
             ~run
             ~timestamp
             ~sequence:(t.revision + 1))
      in
      ( List.map (Agent_run.changes p) ~f:(fun change -> Event.Agent_run_changed change)
      , Agent_run.result p
      , [] )
    | Domain_command.Claim_next { attempt; run = target_run; project; lease_duration_ms }
      ->
      unwrap_domain
        (Agent_run_policy.validate_allocation t.policies target_run ~runs:t.agent_runs);
      require
        (Option.value_map run ~default:false ~f:(Id.Run.equal target_run))
        Stale_claim
        "claim-next run and attribution differ";
      let registered =
        match Agent_run.get_run t.agent_runs target_run with
        | Some r -> r
        | None -> Json.fail Not_found "run is not registered"
      in
      require
        (Id.Actor.equal registered.actor actor
         && not (Agent_run.Status.terminal registered.status))
        Conflict
        "claim-next run actor differs or run is terminal";
      Option.iter project ~f:(fun id -> ignore (find_project t id : Project.t));
      require
        (Option.is_none (Agent_run.get_attempt t.agent_runs attempt))
        Conflict
        "attempt ID already exists";
      let candidates =
        Map.data t.tickets
        |> List.filter ~f:(fun ticket ->
          Option.value_map project ~default:true ~f:(fun id ->
            Option.value_map ticket.Ticket.project ~default:false ~f:(Id.Project.equal id)))
        |> List.map ~f:(fun ticket ->
          Agent_run.allocation_candidate
            t.agent_runs
            ~ticket:ticket.Ticket.id
            ~priority:ticket.priority
            ~creation_sequence:ticket.created_sequence
            ~ready:(ready t ticket)
            ~available:(Option.is_none ticket.claim))
      in
      (match
         unwrap_domain
           (Allocation.choose candidates ~capabilities:registered.capabilities)
       with
       | Empty ->
         ( [ Event.Allocation_empty { run = target_run; attempt } ]
         , Json.obj [ "kind", Json.string "empty" ]
         , [] )
       | Selected selected ->
         let ticket = find_ticket t selected.ticket in
         let claimed, claim_events, claim_result, _ =
           stage
             t
             (match lease_duration_ms with
              | None ->
                Ticket_claim { id = ticket.id; expected_revision = ticket.revision }
              | Some lease_duration_ms ->
                Ticket_claim_with_lease
                  { id = ticket.id
                  ; expected_revision = ticket.revision
                  ; lease_duration_ms
                  })
             ~actor
             ~run
             ~timestamp
             ~now_unix_ms
         in
         let _, attempt_events, attempt_result, _ =
           stage
             claimed
             (Agent_run
                (Attempt_start
                   { id = attempt
                   ; run = target_run
                   ; ticket = ticket.id
                   ; token = ticket.next_token
                   ; sessions = []
                   }))
             ~actor
             ~run
             ~timestamp
             ~now_unix_ms
         in
         ( claim_events @ attempt_events
         , Json.obj
             [ "kind", Json.string "selected"
             ; "claim", claim_result
             ; "attempt", attempt_result
             ]
         , [] ))
    | Domain_command.Thread_reply
        { id; expected_revision; comment_id; reply_to; kind; body } ->
      let thread =
        match Communication.get_thread t.communication id with
        | Some thread -> thread
        | None -> Json.fail Not_found "thread not found"
      in
      expected thread.revision expected_revision;
      Option.iter reply_to ~f:(fun parent ->
        require
          (List.mem thread.messages parent ~equal:Id.Comment.equal)
          Conflict
          "reply parent is not attached to this thread");
      let target = unwrap_domain (Communication.thread_target t.communication id) in
      let comment_event, message =
        create_comment ~id:comment_id ~target ~reply_to ~kind body
      in
      let p =
        unwrap_domain
          (Communication.prepare
             t.communication
             (Thread_attach { id; expected_revision; message })
             ~actor
             ~run
             ~timestamp
             ~sequence:(t.revision + 1))
      in
      ( comment_event
        :: List.map (Communication.changes p) ~f:(fun change ->
          Event.Communication_changed change)
      , Json.obj
          [ "comment_id", Id.Comment.jsonaf_of_t message
          ; "thread", Communication.result p
          ]
      , [] )
    | Domain_command.Communication command ->
      let prepared =
        match
          Communication.prepare
            t.communication
            command
            ~actor
            ~run
            ~timestamp
            ~sequence:(t.revision + 1)
        with
        | Ok prepared -> prepared
        | Error error -> raise (Json.Decode_error error)
      in
      ( List.map (Communication.changes prepared) ~f:(fun change ->
          Event.Communication_changed change)
      , Communication.result prepared
      , [] )
    | Domain_command.Batch _ ->
      Json.fail Invalid_argument "nested transactions are unsupported"
    | Settings_put command ->
      let change = Workflow.prepare t.workflow command in
      [ Event.Settings_changed change ], Workflow.Change.jsonaf_of_t change, []
    | Workspace_update
        { expected_revision; name; description; instructions; summary; archived } ->
      expected t.settings.revision expected_revision;
      let settings =
        { Workspace_settings.description =
            Option.value description ~default:t.settings.description
        ; instructions = Option.value instructions ~default:t.settings.instructions
        ; summary = Option.value summary ~default:t.settings.summary
        ; name =
            (match name with
             | None -> t.settings.name
             | Some _ -> name)
        ; archived = Option.value archived ~default:t.settings.archived
        ; revision = expected_revision + 1
        }
      in
      [ Event.Workspace_updated settings ], Workspace_settings.jsonaf_of_t settings, []
    | Ticket_metadata
        { id
        ; expected_revision
        ; priority
        ; assignee
        ; labels
        ; acceptance_criteria
        ; status_id
        } ->
      let ticket = find_ticket t id in
      expected ticket.revision expected_revision;
      Option.iter (Option.join assignee) ~f:(fun id ->
        require (not (Workflow.actor t.workflow id).archived) Conflict "actor is archived");
      Option.iter
        labels
        ~f:
          (List.iter ~f:(fun id ->
             require
               (not (Workflow.label t.workflow id).archived)
               Conflict
               "label is archived"));
      let status =
        match status_id with
        | None | Some None -> ticket.status
        | Some (Some id) ->
          let value = Workflow.status t.workflow id in
          require (not value.archived) Conflict "status is archived";
          require
            (Option.is_none ticket.claim)
            Already_claimed
            "release claim before changing status";
          value.category
      in
      let ticket =
        { ticket with
          status
        ; status_id = Option.value status_id ~default:ticket.status_id
        ; priority = Option.value priority ~default:ticket.priority
        ; assignee = Option.value assignee ~default:ticket.assignee
        ; labels =
            Option.value labels ~default:ticket.labels
            |> List.sort ~compare:Id.Label.compare
        ; acceptance_criteria =
            Option.value acceptance_criteria ~default:ticket.acceptance_criteria
        }
      in
      if Option.is_some (Option.join status_id) && Domain_command.Status.equal status Done
      then check_complete t ticket;
      [ update ticket ], Json.obj [ "revision", Json.int (ticket.revision + 1) ], []
    | Project_create { id; title; description } ->
      require (not (Map.mem t.projects id)) Conflict "project already exists";
      let p =
        { Project.id
        ; title
        ; description
        ; revision = 1
        ; status = Todo
        ; priority = 0
        ; summary = ""
        ; acceptance_criteria = ""
        ; archived = false
        }
      in
      [ Event.Project_put p ], Project.jsonaf_of_t p, []
    | Project_update
        { id
        ; expected_revision
        ; title
        ; description
        ; status
        ; priority
        ; summary
        ; acceptance_criteria
        ; archived
        } ->
      let p = find_project t id in
      expected p.revision expected_revision;
      let p =
        { p with
          title = Option.value title ~default:p.title
        ; description = Option.value description ~default:p.description
        ; priority = Option.value priority ~default:p.priority
        ; status = Option.value status ~default:p.status
        ; summary = Option.value summary ~default:p.summary
        ; acceptance_criteria =
            Option.value acceptance_criteria ~default:p.acceptance_criteria
        ; archived = Option.value archived ~default:p.archived
        ; revision = p.revision + 1
        }
      in
      [ Event.Project_put p ], Project.jsonaf_of_t p, []
    | Milestone_create { id; project; title; description; target_date } ->
      require (not (Map.mem t.milestones id)) Conflict "milestone already exists";
      let milestone =
        { Milestone.id
        ; project
        ; title
        ; description
        ; target_date
        ; status = Todo
        ; revision = 1
        ; archived = false
        }
      in
      [ Event.Milestone_put milestone ], Milestone.jsonaf_of_t milestone, []
    | Milestone_update { id; expected_revision; title; description; status; archived } ->
      let milestone = find_milestone t id in
      expected milestone.revision expected_revision;
      let milestone =
        { milestone with
          title = Option.value title ~default:milestone.title
        ; description = Option.value description ~default:milestone.description
        ; status = Option.value status ~default:milestone.status
        ; archived = Option.value archived ~default:milestone.archived
        ; revision = milestone.revision + 1
        }
      in
      [ Event.Milestone_put milestone ], Milestone.jsonaf_of_t milestone, []
    | Milestone_schedule { id; expected_revision; target_date } ->
      let milestone = find_milestone t id in
      expected milestone.revision expected_revision;
      let milestone = { milestone with target_date; revision = milestone.revision + 1 } in
      [ Event.Milestone_put milestone ], Milestone.jsonaf_of_t milestone, []
    | Ticket_move { id; expected_revision; project; milestone; parent } ->
      let root = find_ticket t id in
      expected root.revision expected_revision;
      let tickets =
        Map.data t.tickets
        |> List.filter ~f:(fun ticket ->
          reachable t ~from:ticket.Ticket.id ~target:id ~parents:true)
      in
      let changes =
        List.map tickets ~f:(fun ticket ->
          let is_root = Id.Ticket.equal ticket.Ticket.id id in
          let milestone =
            if is_root
            then milestone
            else if Option.equal Id.Project.equal project ticket.project
            then ticket.milestone
            else None
          in
          update
            { ticket with
              project
            ; milestone
            ; parent = (if is_root then parent else ticket.parent)
            })
      in
      changes, Json.obj [ "moved", Json.int (List.length changes) ], []
    | Ticket_archive { id; expected_revision; archived } ->
      let ticket = find_ticket t id in
      expected ticket.revision expected_revision;
      ( [ update { ticket with archived } ]
      , Json.obj [ ("archived", if archived then `True else `False) ]
      , [] )
    | Ticket_create { id; title; description; project; parent; milestone } ->
      require (not (Map.mem t.tickets id)) Conflict "ticket already exists";
      let ticket =
        { Ticket.id
        ; display_key = "WG-" ^ Int.to_string (Map.length t.tickets + 1)
        ; title
        ; description
        ; project
        ; parent
        ; milestone
        ; archived = false
        ; status_id = None
        ; priority = 0
        ; assignee = None
        ; labels = []
        ; acceptance_criteria = ""
        ; status = Todo
        ; revision = 1
        ; hold = None
        ; waivers = []
        ; prerequisites = []
        ; related = []
        ; claim = None
        ; created_sequence = t.revision + 1
        ; created_at = timestamp
        ; updated_at = timestamp
        ; next_token = 1
        }
      in
      [ Event.Ticket_put ticket ], Ticket.jsonaf_of_t ticket, []
    | Ticket_update { id; expected_revision; title; description; status } ->
      let ticket = find_ticket t id in
      expected ticket.revision expected_revision;
      require
        (Option.is_none ticket.claim)
        Already_claimed
        "release the claim or use ticket.complete";
      let ticket =
        { ticket with
          title = Option.value title ~default:ticket.title
        ; description = Option.value description ~default:ticket.description
        ; status = Option.value status ~default:ticket.status
        ; status_id = (if Option.is_some status then None else ticket.status_id)
        }
      in
      if Option.value_map status ~default:false ~f:(Domain_command.Status.equal Done)
      then check_complete t ticket;
      let event = update ticket in
      ( [ event ]
      , Json.obj
          [ "ticket_id", Id.Ticket.jsonaf_of_t id
          ; "revision", Json.int (ticket.revision + 1)
          ]
      , [] )
    | Ticket_hold { id; expected_revision; reason } ->
      let ticket = find_ticket t id in
      expected ticket.revision expected_revision;
      let hold = Option.map reason ~f:(fun reason -> { Hold.actor; reason; timestamp }) in
      ( [ update { ticket with hold } ]
      , Json.obj [ "revision", Json.int (ticket.revision + 1) ]
      , [] )
    | Dependency_waive { ticket; prerequisite; expected_revision; reason } ->
      let ticket = find_ticket t ticket in
      expected ticket.revision expected_revision;
      require
        (List.mem ticket.prerequisites prerequisite ~equal:Id.Ticket.equal)
        Not_found
        "dependency absent";
      let waivers =
        List.filter ticket.waivers ~f:(fun waiver ->
          not (Id.Ticket.equal waiver.Waiver.prerequisite prerequisite))
      in
      let waivers =
        match reason with
        | None -> waivers
        | Some reason -> { Waiver.prerequisite; actor; reason; timestamp } :: waivers
      in
      let waivers =
        List.sort waivers ~compare:(fun a b ->
          Id.Ticket.compare a.Waiver.prerequisite b.prerequisite)
      in
      ( [ update { ticket with waivers } ]
      , Json.obj [ "revision", Json.int (ticket.revision + 1) ]
      , [] )
    | Related_link
        { ticket; related; expected_revision; related_expected_revision; linked } ->
      require
        (not (Id.Ticket.equal ticket related))
        Conflict
        "ticket cannot relate to itself";
      let ticket = find_ticket t ticket
      and related = find_ticket t related in
      expected ticket.revision expected_revision;
      expected related.revision related_expected_revision;
      let present = List.mem ticket.related related.id ~equal:Id.Ticket.equal in
      require
        (not (Bool.equal present linked))
        (if linked then Conflict else Not_found)
        (if linked then "related link already exists" else "related link absent");
      let change (item : Ticket.t) id =
        let values =
          if linked
          then id :: item.related
          else
            List.filter item.related ~f:(fun candidate ->
              not (Id.Ticket.equal candidate id))
        in
        update { item with related = List.sort values ~compare:Id.Ticket.compare }
      in
      ( [ change ticket related.id; change related ticket.id ]
      , Json.obj
          [ "ticket_revision", Json.int (ticket.revision + 1)
          ; "related_revision", Json.int (related.revision + 1)
          ]
      , [] )
    | Ticket_reassign { id; expected_revision; claimant; claimant_run; reason } ->
      require
        (List.is_empty (active_attempts t id))
        Conflict
        "finish the active attempt before reassigning its ticket";
      let ticket = find_ticket t id in
      expected ticket.revision expected_revision;
      bounded reason 65_536;
      require
        (not (String.is_empty (String.strip reason)))
        Invalid_argument
        "reassignment requires a reason";
      require (Option.is_some ticket.claim) Conflict "ticket has no claim to reassign";
      let token = ticket.next_token in
      require
        (Option.is_some claimant || Option.is_none claimant_run)
        Invalid_argument
        "claimant run requires a claimant";
      let claim =
        Option.map claimant ~f:(fun actor ->
          { Claim.actor
          ; run_id = claimant_run
          ; token
          ; lease = new_lease ~token ~duration:None ~now_unix_ms
          })
      in
      let status =
        if Option.is_some claim then Domain_command.Status.In_progress else Todo
      in
      ( [ update { ticket with claim; status; status_id = None; next_token = token + 1 }
        ; comment id Decision reason
        ]
      , Json.obj [ ("token", if Option.is_some claim then Json.int token else `Null) ]
      , [] )
    | Dependency_add { ticket; prerequisite } ->
      let value = find_ticket t ticket in
      ignore (find_ticket t prerequisite : Ticket.t);
      require
        (not (List.mem value.prerequisites prerequisite ~equal:Id.Ticket.equal))
        Conflict
        "dependency exists";
      let value =
        { value with
          prerequisites =
            List.sort (prerequisite :: value.prerequisites) ~compare:Id.Ticket.compare
        }
      in
      [ update value ], Json.obj [ "ticket_id", Id.Ticket.jsonaf_of_t ticket ], []
    | Dependency_remove { ticket; prerequisite } ->
      let value = find_ticket t ticket in
      require
        (List.mem value.prerequisites prerequisite ~equal:Id.Ticket.equal)
        Not_found
        "dependency absent";
      ( [ update
            { value with
              prerequisites =
                List.filter value.prerequisites ~f:(fun id ->
                  not (Id.Ticket.equal id prerequisite))
            ; waivers =
                List.filter value.waivers ~f:(fun waiver ->
                  not (Id.Ticket.equal waiver.Waiver.prerequisite prerequisite))
            }
        ]
      , Json.obj [ "ticket_id", Id.Ticket.jsonaf_of_t ticket ]
      , [] )
    | Ticket_claim { id; expected_revision }
    | Ticket_claim_with_lease { id; expected_revision; lease_duration_ms = _ } ->
      let duration =
        match command with
        | Ticket_claim_with_lease { lease_duration_ms; _ } -> Some lease_duration_ms
        | _ -> None
      in
      let ticket = find_ticket t id in
      expected ticket.revision expected_revision;
      require (Option.is_none ticket.claim) Already_claimed "ticket is claimed";
      require (ready t ticket) Blocked "ticket is not ready";
      let token = ticket.next_token in
      ( [ update
            { ticket with
              claim =
                Some
                  { Claim.actor
                  ; run_id = run
                  ; token
                  ; lease = new_lease ~token ~duration ~now_unix_ms
                  }
            ; next_token = token + 1
            ; status = In_progress
            ; status_id = None
            }
        ]
      , Json.obj [ "ticket_id", Id.Ticket.jsonaf_of_t id; "token", Json.int token ]
      , [] )
    | Ticket_renew_lease { id; token; expected_lease_revision } ->
      let ticket = find_ticket t id in
      check_claim_at ticket ~actor ~run ~token ~now_unix_ms;
      let claim = Option.value_exn ticket.claim in
      let now =
        match now_unix_ms with
        | Some now -> now
        | None -> Json.fail Invalid_argument "lease renewal requires server clock"
      in
      let lease =
        unwrap_domain
          (Allocation_lease.renew
             claim.lease
             ~expected_revision:expected_lease_revision
             ~epoch:token
             ~now_unix_ms:now)
      in
      ( [ update { ticket with claim = Some { claim with lease } } ]
      , Json.obj
          [ "ticket_id", Id.Ticket.jsonaf_of_t id
          ; "lease", Allocation_lease.to_json lease
          ]
      , [] )
    | Ticket_release { id; token } ->
      let ticket = find_ticket t id in
      check_claim ticket ~actor ~run ~token;
      let finished =
        List.concat_map (active_attempts t ticket.id) ~f:(fun a ->
          let p =
            unwrap_domain
              (Agent_run.prepare
                 ?now_unix_ms
                 t.agent_runs
                 (Attempt_finish
                    { id = a.id
                    ; expected_revision = a.revision
                    ; state = Cancelled
                    ; evidence = "ticket claim released"
                    })
                 ~actor
                 ~run
                 ~timestamp
                 ~sequence:(t.revision + 1))
          in
          List.map (Agent_run.changes p) ~f:(fun c -> Event.Agent_run_changed c))
      in
      ( finished @ [ update { ticket with claim = None; status = Todo; status_id = None } ]
      , Json.obj [ "released", `True ]
      , [] )
    | Ticket_complete { id; token; evidence } ->
      let ticket = find_ticket t id in
      check_claim_at ticket ~actor ~run ~token ~now_unix_ms;
      check_complete t ticket;
      require
        (not (String.is_empty (String.strip evidence)))
        Invalid_argument
        "completion requires evidence";
      let finished =
        List.concat_map (active_attempts t ticket.id) ~f:(fun a ->
          ignore (attempt_owner t a.id ~actor ~run ~now_unix_ms () : Attempt.t);
          unwrap_domain
            (Evidence.ensure_attempt_can_complete
               t.evidence
               ~attempt:a.id
               ~ticket:a.ticket);
          let p =
            unwrap_domain
              (Agent_run.prepare
                 ?now_unix_ms
                 t.agent_runs
                 (Attempt_finish
                    { id = a.id
                    ; expected_revision = a.revision
                    ; state = Completed
                    ; evidence
                    })
                 ~actor
                 ~run
                 ~timestamp
                 ~sequence:(t.revision + 1))
          in
          List.map (Agent_run.changes p) ~f:(fun c -> Event.Agent_run_changed c))
      in
      ( finished
        @ [ update { ticket with claim = None; status = Done; status_id = None }
          ; comment id Evidence evidence
          ]
      , Json.obj [ "completed", `True ]
      , [] )
    | Comment_add { id; target; reply_to; kind; body } ->
      let change, id = create_comment ~id ~target ~reply_to ~kind body in
      ( [ change ]
      , Json.obj
          [ "comment_id", Id.Comment.jsonaf_of_t id
          ; "sequence", Json.int (t.revision + 1)
          ; "revision", Json.int 1
          ]
      , [] )
    | Comment_edit { id; expected_revision; body; tombstone } ->
      expected (Discussion.revision t.discussion id) expected_revision;
      let change =
        Discussion.Change.Revise
          { id; version = version ~revision:(expected_revision + 1) body ~tombstone }
      in
      ( [ Event.Comment_changed change ]
      , Json.obj
          [ "comment_id", Id.Comment.jsonaf_of_t id
          ; "revision", Json.int (expected_revision + 1)
          ]
      , [] )
    | Ticket_progress { ticket; token; kind; body } ->
      check_claim_at (find_ticket t ticket) ~actor ~run ~token ~now_unix_ms;
      let change, id =
        create_comment
          ~id:None
          ~target:(Entity_ref.Ticket ticket)
          ~reply_to:None
          ~kind
          body
      in
      ( [ change ]
      , Json.obj
          [ "comment_id", Id.Comment.jsonaf_of_t id
          ; "sequence", Json.int (t.revision + 1)
          ]
      , [] )
    | Handoff_set
        { ticket
        ; expected_revision
        ; token
        ; summary
        ; next_steps
        ; evidence
        ; objective
        ; completed
        ; decisions
        ; blockers
        ; resources
        ; covers_through
        } ->
      let value = find_ticket t ticket in
      (match value.claim, token with
       | None, None -> ()
       | Some _, Some token -> check_claim_at value ~actor ~run ~token ~now_unix_ms
       | Some _, None | None, Some _ ->
         Json.fail Stale_claim "handoff requires current claim token");
      let current =
        Option.value_map (Map.find t.handoffs ticket) ~default:0 ~f:(fun h ->
          h.Handoff.revision)
      in
      expected current expected_revision;
      let handoff =
        { Handoff.ticket
        ; actor
        ; summary
        ; next_steps
        ; evidence
        ; objective
        ; completed
        ; decisions
        ; blockers
        ; resources
        ; timestamp
        ; revision = current + 1
        ; covers_through = Option.value covers_through ~default:t.revision
        }
      in
      [ Event.Handoff_put handoff ], Handoff.jsonaf_of_t handoff, []
    | Resource_put { id; expected_revision; title; text; filename; mime_type } ->
      bounded text 65_536;
      let digest = Json.hash text in
      let previous = Map.find t.resources id in
      let filename =
        Option.value
          filename
          ~default:
            (Option.value_map
               previous
               ~default:(Id.Resource.to_string id ^ ".txt")
               ~f:(fun r -> r.Resource.metadata.filename))
      in
      let mime_type =
        Option.value
          mime_type
          ~default:
            (Option.value_map previous ~default:"text/plain" ~f:(fun r ->
               r.Resource.metadata.mime_type))
      in
      let event, result =
        publish
          ~id
          ~expected_revision
          ~title
          ~filename
          ~mime_type
          ~digest
          ~size_bytes:(String.length text)
      in
      [ event ], result, [ digest, text ]
    | Resource_publish
        { id; expected_revision; title; filename; mime_type; digest; size_bytes } ->
      let event, result =
        publish ~id ~expected_revision ~title ~filename ~mime_type ~digest ~size_bytes
      in
      [ event ], result, []
    | Resource_metadata
        { id; expected_revision; title; filename; mime_type; description; archived } ->
      let resource =
        match Map.find t.resources id with
        | Some r -> r
        | None -> Json.fail Not_found "resource not found"
      in
      expected resource.revision expected_revision;
      let old = resource.metadata in
      let metadata =
        { old with
          title = Option.value title ~default:old.title
        ; filename = Option.value filename ~default:old.filename
        ; mime_type = Option.value mime_type ~default:old.mime_type
        ; description = Option.value description ~default:old.description
        ; archived = Option.value archived ~default:old.archived
        }
      in
      ( [ Event.Resource_changed
            (Metadata_changed { id; revision = resource.revision + 1; metadata })
        ]
      , Json.obj [ "revision", Json.int (resource.revision + 1) ]
      , [] )
    | Resource_link { id; expected_revision; target; remove } ->
      let resource =
        match Map.find t.resources id with
        | Some r -> r
        | None -> Json.fail Not_found "resource not found"
      in
      expected resource.revision expected_revision;
      require
        (not (Entity_ref.equal target (Entity_ref.Resource id)))
        Invalid_argument
        "resource cannot attach to itself";
      let targets = resource.metadata.targets in
      require
        (Bool.equal (List.mem targets target ~equal:Entity_ref.equal) remove)
        Conflict
        "resource link already exists or is absent";
      let targets =
        if remove
        then List.filter targets ~f:(fun old -> not (Entity_ref.equal target old))
        else target :: targets |> List.sort ~compare:Entity_ref.compare
      in
      let metadata = { resource.metadata with targets } in
      ( [ Event.Resource_changed
            (Metadata_changed { id; revision = resource.revision + 1; metadata })
        ]
      , Json.obj [ "revision", Json.int (resource.revision + 1) ]
      , [] )
  in
  let staged, resolved =
    List.fold changes ~init:(t, []) ~f:(fun (state, resolved) change ->
      let updated = apply_event state change in
      match change with
      | Event.Resource_changed (Resource.Change.Published { id; version; _ }) ->
        (match Map.find state.resources id with
         | None -> updated, change :: resolved
         | Some old ->
           let previous = Resource.get_version old ~revision:None in
           let resource_pin (v : Resource.Version.t) =
             Evidence.Pin.Resource { id; revision = v.revision; digest = v.digest }
           in
           let p =
             unwrap_domain
               (Evidence.prepare
                  updated.evidence
                  (Input_changed
                     { previous = resource_pin previous; current = resource_pin version })
                  ~actor
                  ~run
                  ~timestamp
                  ~sequence:(t.revision + 1))
           in
           let evidence_changes =
             List.map (Evidence.changes p) ~f:(fun event -> Event.Evidence_changed event)
           in
           let final = List.fold evidence_changes ~init:updated ~f:apply_event in
           final, List.rev_append evidence_changes (change :: resolved))
      | Event.Comment_changed (Discussion.Change.Revise { id; version }) ->
        let previous =
          Evidence.Pin.Comment { id; revision = Discussion.revision state.discussion id }
        in
        let current = Evidence.Pin.Comment { id; revision = version.revision } in
        let p =
          unwrap_domain
            (Evidence.prepare
               updated.evidence
               (Input_changed { previous; current })
               ~actor
               ~run
               ~timestamp
               ~sequence:(t.revision + 1))
        in
        let evidence_changes =
          List.map (Evidence.changes p) ~f:(fun event -> Event.Evidence_changed event)
        in
        let final = List.fold evidence_changes ~init:updated ~f:apply_event in
        final, List.rev_append evidence_changes (change :: resolved)
      | Communication_changed _
      | Agent_run_changed _
      | Evidence_changed _
      | Policy_changed _
      | Policy_unchanged _
      | Allocation_empty _
      | Settings_changed _
      | Workspace_updated _
      | Project_put _
      | Milestone_put _
      | Ticket_put _
      | Comment_changed (Create _)
      | Handoff_put _
      | Resource_changed (Metadata_changed _) -> updated, change :: resolved)
  in
  staged, List.rev resolved, result, blobs
;;

let prepare t ?run ?now_unix_ms command ~actor ~timestamp =
  Json.decode (fun () ->
    require (t.revision < 100_000) Invalid_argument "MVP transaction limit is 100000";
    let commands, is_batch =
      match command with
      | Domain_command.Batch commands -> commands, true
      | command -> [ command ], false
    in
    require
      ((not (List.is_empty commands)) && List.length commands <= 32)
      Invalid_argument
      "transaction requires 1..32 operations";
    let staged, changes, results, blobs, _ =
      List.fold
        commands
        ~init:(t, [], [], [], 0)
        ~f:(fun (state, events, results, blobs, operations) command ->
          let count =
            match command with
            | Domain_command.Template_instantiate
                { template; template_revision; id; parameters } ->
              if Option.is_some (Agent_run_policy.get_instance state.policies id)
              then 1
              else
                List.length
                  (snd
                     (instantiate_plan state ~template ~template_revision ~id ~parameters))
            | Batch _
            | Communication _
            | Agent_run _
            | Evidence _
            | Policy _
            | Claim_next _
            | Thread_reply _
            | Settings_put _
            | Workspace_update _
            | Ticket_metadata _
            | Project_create _
            | Project_update _
            | Milestone_create _
            | Milestone_update _
            | Milestone_schedule _
            | Ticket_move _
            | Ticket_archive _
            | Ticket_create _
            | Ticket_update _
            | Ticket_hold _
            | Dependency_waive _
            | Ticket_reassign _
            | Dependency_add _
            | Dependency_remove _
            | Related_link _
            | Ticket_claim _
            | Ticket_claim_with_lease _
            | Ticket_renew_lease _
            | Ticket_release _
            | Ticket_complete _
            | Comment_add _
            | Comment_edit _
            | Ticket_progress _
            | Handoff_set _
            | Resource_put _
            | Resource_publish _
            | Resource_metadata _
            | Resource_link _ -> 1
          in
          require
            (operations + count <= 32)
            Invalid_argument
            "expanded transaction exceeds 32 atomic operations";
          let state, changes, result, new_blobs =
            stage state command ~actor ~run ~timestamp ~now_unix_ms
          in
          ( state
          , List.rev_append changes events
          , result :: results
          , List.rev_append new_blobs blobs
          , operations + count ))
    in
    validate staged;
    List.iter changes ~f:(function
      | Event.Agent_run_changed { update = Agent_run_event.Update.Attempt_put attempt; _ }
        when Attempt.State.equal attempt.state Completed ->
        unwrap_domain
          (Evidence.ensure_attempt_can_complete
             staged.evidence
             ~attempt:attempt.id
             ~ticket:attempt.ticket)
      | _ -> ());
    (* Later operations must not invalidate a completion performed in this batch. *)
    List.iter commands ~f:(function
      | Domain_command.Ticket_complete { id; _ }
      | Ticket_update { id; status = Some Done; _ }
      | Ticket_metadata { id; status_id = Some (Some _); _ } ->
        let ticket = find_ticket staged id in
        if Domain_command.Status.equal ticket.status Done
        then check_complete staged ticket
      | Agent_run
          (Agent_run.Command.Attempt_finish { id; state = Attempt.State.Completed; _ }) ->
        let attempt =
          match Agent_run.get_attempt staged.agent_runs id with
          | Some a -> a
          | None -> Json.fail Not_found "completed attempt not found"
        in
        unwrap_domain
          (Evidence.ensure_attempt_can_complete
             staged.evidence
             ~attempt:attempt.id
             ~ticket:attempt.ticket)
      | Batch _
      | Communication _
      | Agent_run _
      | Evidence _
      | Policy _
      | Template_instantiate _
      | Claim_next _
      | Thread_reply _
      | Settings_put _
      | Workspace_update _
      | Project_create _
      | Project_update _
      | Milestone_create _
      | Milestone_update _
      | Milestone_schedule _
      | Ticket_hold _
      | Ticket_reassign _
      | Dependency_waive _
      | Ticket_move _
      | Ticket_archive _
      | Ticket_create _
      | Ticket_update _
      | Ticket_metadata _
      | Dependency_add _
      | Dependency_remove _
      | Ticket_claim _
      | Ticket_claim_with_lease _
      | Ticket_renew_lease _
      | Ticket_release _
      | Comment_edit _
      | Ticket_progress _
      | Comment_add _
      | Handoff_set _
      | Resource_publish _
      | Resource_metadata _
      | Resource_link _
      | Related_link _
      | Resource_put _ -> ());
    let events =
      Json.obj
        [ "version", Json.int 1
        ; "revision", Json.int (t.revision + 1)
        ; "actor", Id.Actor.jsonaf_of_t actor
        ; "timestamp", Json.string timestamp
        ; "changes", `Array (List.map (List.rev changes) ~f:Event.jsonaf_of_t)
        ]
    in
    let events =
      match events, run with
      | `Object fields, Some run -> Json.obj (("run_id", Id.Run.jsonaf_of_t run) :: fields)
      | _, None -> events
      | _, Some _ -> assert false
    in
    let candidate =
      match replay t events with
      | Ok state -> state
      | Error error -> raise (Json.Decode_error error)
    in
    let result =
      if is_batch
      then Json.obj [ "results", `Array (List.rev results) ]
      else List.hd_exn results
    in
    { candidate; events; result; blobs = List.rev blobs })
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

let search_scope t params =
  let include_archived =
    match Json.optional params "include_archived" with
    | None | Some `False -> false
    | Some `True -> true
    | Some _ -> Json.fail Invalid_argument "include_archived must be boolean"
  in
  let project =
    Option.map (Json.optional params "project_id") ~f:Id.Project.t_of_jsonaf
  in
  Option.iter project ~f:(fun id -> ignore (find_project t id : Project.t));
  let target = Option.map (Json.optional params "target") ~f:Entity_ref.t_of_jsonaf in
  Option.iter target ~f:(validate_target t);
  let rec visible = function
    | Entity_ref.Workspace -> true
    | Project id -> include_archived || not (find_project t id).archived
    | Milestone id ->
      let m = find_milestone t id in
      include_archived || ((not m.archived) && visible (Project m.project))
    | Ticket id -> include_archived || active_scope t (find_ticket t id)
    | Resource id ->
      let r = Map.find_exn t.resources id in
      include_archived || not r.metadata.archived
  in
  let belongs target =
    match target with
    | Entity_ref.Workspace -> None
    | Project id -> Some id
    | Milestone id -> Some (find_milestone t id).project
    | Ticket id -> (find_ticket t id).project
    | Resource _ -> None
  in
  fun entity ->
    visible entity
    && Option.for_all target ~f:(fun target ->
      Entity_ref.equal entity target
      ||
      match entity with
      | Resource id ->
        List.mem
          (Map.find_exn t.resources id).metadata.targets
          target
          ~equal:Entity_ref.equal
      | Workspace | Project _ | Milestone _ | Ticket _ -> false)
    && Option.for_all project ~f:(fun project ->
      match entity with
      | Resource id ->
        (Map.find_exn t.resources id).metadata.targets
        |> List.exists ~f:(fun target ->
          Option.equal Id.Project.equal (belongs target) (Some project))
      | Workspace | Project _ | Milestone _ | Ticket _ ->
        Option.equal Id.Project.equal (belongs entity) (Some project))
;;

let search_kinds params =
  Option.map (Json.optional params "kinds") ~f:(fun value ->
    let kinds = Json.list value |> List.map ~f:Json.text in
    require
      ((not (List.is_empty kinds))
       && List.length kinds <= List.length Search.kinds
       && List.length kinds
          = List.length (List.dedup_and_sort kinds ~compare:String.compare)
       && List.for_all kinds ~f:(fun kind ->
         List.mem Search.kinds kind ~equal:String.equal))
      Invalid_argument
      "invalid search kinds";
    kinds)
;;

let searchable_text mime =
  let mime = String.lowercase mime in
  String.is_prefix mime ~prefix:"text/"
  || List.mem
       [ "application/json"; "application/xml"; "application/javascript" ]
       mime
       ~equal:String.equal
;;

let search_resources t ~params =
  Json.decode (fun () ->
    Json.fields
      params
      ~allowed:
        [ "workspace_id"
        ; "limit"
        ; "offset"
        ; "at_revision"
        ; "include_archived"
        ; "max_bytes"
        ; "text"
        ; "project_id"
        ; "target"
        ; "kinds"
        ];
    ignore (Query_budget.of_params params : int);
    let text = Json.bounded_text (Json.field params "text") ~max_bytes:256 in
    require
      (not (String.is_empty (String.strip text)))
      Invalid_argument
      "search text cannot be empty";
    let limit =
      Option.value_map (Json.optional params "limit") ~default:50 ~f:Json.integer
    in
    require (limit > 0 && limit <= 100) Invalid_argument "limit must be 1..100";
    let offset =
      Option.value_map (Json.optional params "offset") ~default:0 ~f:Json.integer
    in
    Option.iter (Json.optional params "at_revision") ~f:(fun value ->
      expected t.revision (Json.integer value));
    require
      (offset = 0 || Option.is_some (Json.optional params "at_revision"))
      Invalid_argument
      "pagination requires at_revision";
    let scope = search_scope t params in
    let kinds = search_kinds params in
    if
      not
        (Option.for_all kinds ~f:(fun kinds ->
           List.mem kinds "resource_text" ~equal:String.equal))
    then []
    else
      Map.data t.resources
      |> List.filter ~f:(fun r ->
        scope (Entity_ref.Resource r.Resource.id)
        && searchable_text (Resource.get_version r ~revision:None).mime_type))
;;

let search_documents t ~params ~resource_texts =
  let scope = search_scope t params in
  let doc source target revision fields =
    { Search.Document.source; target; revision; fields }
  in
  let documents =
    [ doc
        (Workspace t.workspace)
        Workspace
        t.settings.revision
        [ "name", name t
        ; "description", t.settings.description
        ; "instructions", t.settings.instructions
        ; "summary", t.settings.summary
        ]
    ]
    @ (Map.data t.projects
       |> List.map ~f:(fun p ->
         doc
           (Project p.Project.id)
           (Project p.id)
           p.revision
           [ "title", p.title
           ; "description", p.description
           ; "summary", p.summary
           ; "acceptance_criteria", p.acceptance_criteria
           ]))
    @ (Map.data t.milestones
       |> List.map ~f:(fun m ->
         doc
           (Milestone m.Milestone.id)
           (Milestone m.id)
           m.revision
           [ "title", m.title; "description", m.description ]))
    @ (Map.data t.tickets
       |> List.map ~f:(fun ticket ->
         doc
           (Ticket ticket.Ticket.id)
           (Ticket ticket.id)
           ticket.revision
           [ "title", ticket.title
           ; "description", ticket.description
           ; "acceptance_criteria", ticket.acceptance_criteria
           ]))
    @ Discussion.search_documents t.discussion
    @ (Map.data t.handoffs
       |> List.map ~f:(fun h ->
         doc
           (Handoff h.Handoff.ticket)
           (Ticket h.ticket)
           h.revision
           [ "summary", h.summary
           ; "objective", h.objective
           ; "completed", h.completed
           ; "decisions", h.decisions
           ; "blockers", h.blockers
           ; "next_steps", h.next_steps
           ; "evidence", h.evidence
           ]))
    @ (Map.data t.resources
       |> List.map ~f:(fun r ->
         doc
           (Resource r.Resource.id)
           (Resource r.id)
           r.revision
           [ "title", r.metadata.title
           ; "filename", r.metadata.filename
           ; "description", r.metadata.description
           ]))
    @ List.filter_map resource_texts ~f:(fun extracted ->
      let resource =
        match Map.find t.resources extracted.Search.Text.id with
        | Some resource -> resource
        | None -> Json.fail Not_found "unknown extracted resource"
      in
      let current = Resource.get_version resource ~revision:None in
      require
        (scope (Entity_ref.Resource resource.id) && searchable_text current.mime_type)
        Invalid_argument
        "resource extraction is outside search scope";
      require
        (Int.equal current.revision extracted.version
         && String.equal current.digest extracted.digest)
        Conflict
        "stale resource text extraction";
      match extracted.outcome with
      | Invalid_utf8 -> None
      | Content { text; total_bytes } ->
        require
          (String.length text <= 65_536 && total_bytes >= String.length text)
          Invalid_argument
          "invalid extracted text bounds";
        Some
          (doc
             (Resource_text resource.id)
             (Resource resource.id)
             current.revision
             [ "text", text ]))
  in
  List.filter documents ~f:(fun document -> scope document.Search.Document.target)
;;

let query_with_texts t ~resource_texts ~method_ ~params =
  Json.decode (fun () ->
    let common =
      [ "workspace_id"
      ; "limit"
      ; "offset"
      ; "at_revision"
      ; "include_archived"
      ; "max_bytes"
      ]
    in
    let extra =
      match method_ with
      | "search.query" -> [ "text"; "project_id"; "target"; "kinds" ]
      | "ticket.resolve" -> [ "display_key" ]
      | "ticket.list" | "ticket.ready" ->
        [ "text"
        ; "project_id"
        ; "milestone_id"
        ; "status"
        ; "assignee_id"
        ; "label_id"
        ; "priority"
        ]
      | "project.get" | "project.brief" | "milestone.list" -> [ "project_id" ]
      | "milestone.get" -> [ "milestone_id" ]
      | "ticket.context" | "ticket.readiness" | "handoff.get" | "handoff.history" ->
        [ "ticket_id" ]
      | "workspace.overview" -> [ "actor_id"; "run_id" ]
      | "ticket.blockers" -> [ "ticket_id" ]
      | "activity.since" -> [ "after"; "target"; "project_id"; "actor_id" ]
      | "comment.list" -> [ "target"; "ticket_id"; "include_tombstones" ]
      | "comment.get" | "comment.history" -> [ "comment_id" ]
      | "resource.get" | "resource.history" -> [ "resource_id" ]
      | "resource.list" -> [ "target" ]
      | _ -> []
    in
    Json.fields params ~allowed:(common @ extra);
    let max_bytes = Query_budget.of_params params in
    let limit =
      Option.value_map (Json.optional params "limit") ~default:50 ~f:Json.integer
    in
    require (limit > 0 && limit <= 100) Invalid_argument "limit must be 1..100";
    let offset =
      Option.value_map (Json.optional params "offset") ~default:0 ~f:Json.integer
    in
    Option.iter (Json.optional params "at_revision") ~f:(fun j ->
      expected t.revision (Json.integer j));
    if offset > 0
    then
      require
        (Option.is_some (Json.optional params "at_revision"))
        Invalid_argument
        "pagination requires at_revision";
    let page items =
      let items = List.drop items offset in
      let selected = List.take items limit in
      Json.obj
        [ "items", `Array selected
        ; "offset", Json.int offset
        ; "remaining", Json.int (List.length items - List.length selected)
        ; ( "next_offset"
          , if List.length items > limit then Json.int (offset + limit) else `Null )
        ]
    in
    let include_archived =
      match Json.optional params "include_archived" with
      | None | Some `False -> false
      | Some `True -> true
      | Some _ -> Json.fail Invalid_argument "include_archived must be boolean"
    in
    let resource_json r =
      Json.obj
        [ "id", Id.Resource.jsonaf_of_t r.Resource.id
        ; "revision", Json.int r.revision
        ; "metadata", Resource.Metadata.jsonaf_of_t r.metadata
        ; ( "current_version"
          , Resource.Version.jsonaf_of_t (Resource.get_version r ~revision:None) )
        ; "version_count", Json.int (List.length r.versions)
        ]
    in
    let resources target =
      Map.data t.resources
      |> List.filter ~f:(fun r ->
        (include_archived || not r.Resource.metadata.archived)
        && List.mem r.metadata.targets target ~equal:Entity_ref.equal)
      |> List.map ~f:resource_json
      |> page
    in
    let progress tickets =
      Json.obj
        [ "total", Json.int (List.length tickets)
        ; ( "done"
          , Json.int
              (List.count tickets ~f:(fun ticket ->
                 Domain_command.Status.equal ticket.Ticket.status Done)) )
        ; ( "blocked"
          , Json.int
              (List.count tickets ~f:(fun ticket ->
                 Option.is_some ticket.Ticket.hold
                 || not (List.is_empty (blockers t ticket)))) )
        ]
    in
    let blocked ticket =
      Option.is_some ticket.Ticket.hold || not (List.is_empty (blockers t ticket))
    in
    let ticket_summary (ticket : Ticket.t) =
      Json.obj
        [ "id", Id.Ticket.jsonaf_of_t ticket.id
        ; "display_key", Json.string ticket.display_key
        ; "title", Json.string ticket.title
        ; "revision", Json.int ticket.revision
        ; "status", Domain_command.Status.jsonaf_of_t ticket.status
        ; "priority", Json.int ticket.priority
        ; "readiness", readiness t ticket
        ]
    in
    let ticket_page tickets = page (List.map tickets ~f:ticket_summary) in
    let scoped_activity target =
      match target with
      | None -> t.activity
      | Some target -> Option.value (Map.find t.activity_by_target target) ~default:[]
    in
    let communication_context target =
      let threads =
        Communication.threads t.communication
        |> List.filter ~f:(fun thread ->
          List.mem thread.Communication.Thread.links target ~equal:Entity_ref.equal
          ||
          match Communication.thread_target t.communication thread.id with
          | Ok scope -> Entity_ref.equal scope target
          | Error _ -> false)
      in
      let ids =
        Communication_id.Thread.Set.of_list
          (List.map threads ~f:(fun thread -> thread.Communication.Thread.id))
      in
      Json.obj
        [ "threads", page (List.map threads ~f:Communication.Thread.jsonaf_of_t)
        ; ( "requests"
          , page
              (Communication.requests t.communication
               |> List.filter ~f:(fun request ->
                 Set.mem ids request.Communication.Request.thread)
               |> List.map ~f:Communication.Request.jsonaf_of_t) )
        ]
    in
    let event_summary event =
      Json.obj
        [ "revision", Json.field event "revision"
        ; "actor", Json.field event "actor"
        ; "run_id", Option.value (Json.optional event "run_id") ~default:`Null
        ; "timestamp", Json.field event "timestamp"
        ; "targets", Json.field event "targets"
        ; "changes", Json.int (List.length (Json.list (Json.field event "changes")))
        ]
    in
    let body =
      match method_ with
      | "workspace.get" ->
        Json.obj
          [ "name", Json.string (name t)
          ; "settings", Workspace_settings.jsonaf_of_t t.settings
          ]
      | "workspace.overview" ->
        let run = Option.map (Json.optional params "run_id") ~f:Id.Run.t_of_jsonaf in
        let actor =
          Option.map (Json.optional params "actor_id") ~f:Id.Actor.t_of_jsonaf
        in
        let tickets =
          Map.data t.tickets
          |> List.filter ~f:(fun ticket -> include_archived || active_scope t ticket)
        in
        let counts =
          [ Domain_command.Status.Backlog; Todo; In_progress; Done; Canceled ]
          |> List.map ~f:(fun status ->
            ( Json.text (Domain_command.Status.jsonaf_of_t status)
            , Json.int
                (List.count tickets ~f:(fun ticket ->
                   Domain_command.Status.equal ticket.Ticket.status status)) ))
        in
        Json.obj
          [ "name", Json.string (name t)
          ; "settings", Workspace_settings.jsonaf_of_t t.settings
          ; "projects", Json.int (Map.length t.projects)
          ; "tickets", Json.int (Map.length t.tickets)
          ; "ready", Json.int (List.count tickets ~f:(ready t))
          ; "counts_by_status", Json.obj counts
          ; ( "active_projects"
            , page
                (Map.data t.projects
                 |> List.filter ~f:(fun p ->
                   (not p.Project.archived)
                   && not
                        (Domain_command.Status.equal p.status Done
                         || Domain_command.Status.equal p.status Canceled))
                 |> List.map ~f:Project.jsonaf_of_t) )
          ; ( "held_work"
            , ticket_page
                (List.filter tickets ~f:(fun ticket ->
                   Option.exists ticket.Ticket.claim ~f:(fun claim ->
                     Option.for_all actor ~f:(Id.Actor.equal claim.Claim.actor)
                     && Option.for_all run ~f:(fun run ->
                       Option.exists claim.run_id ~f:(Id.Run.equal run))))) )
          ; "blocked_work", ticket_page (List.filter tickets ~f:blocked)
          ; "recent_changes", page (List.map t.activity ~f:event_summary)
          ; "resources", resources Entity_ref.Workspace
          ]
      | "actor.list" -> page (Workflow.items t.workflow ~kind:`Actors ~include_archived)
      | "label.list" -> page (Workflow.items t.workflow ~kind:`Labels ~include_archived)
      | "status.list" ->
        page (Workflow.items t.workflow ~kind:`Statuses ~include_archived)
      | "project.list" ->
        page
          (Map.data t.projects
           |> List.filter ~f:(fun p -> include_archived || not p.Project.archived)
           |> List.map ~f:Project.jsonaf_of_t)
      | "project.get" ->
        find_project t (Id.Project.t_of_jsonaf (Json.field params "project_id"))
        |> Project.jsonaf_of_t
      | "project.brief" ->
        let id = Id.Project.t_of_jsonaf (Json.field params "project_id") in
        let project = find_project t id in
        let tickets =
          Map.data t.tickets
          |> List.filter ~f:(fun ticket ->
            Option.value_map ticket.Ticket.project ~default:false ~f:(Id.Project.equal id)
            && (include_archived || not ticket.archived))
        in
        let milestones =
          Map.data t.milestones
          |> List.filter ~f:(fun m ->
            Id.Project.equal m.Milestone.project id && (include_archived || not m.archived))
        in
        Json.obj
          [ "project", Project.jsonaf_of_t project
          ; "resources", resources (Entity_ref.Project id)
          ; "communication", communication_context (Entity_ref.Project id)
          ; "progress", progress tickets
          ; "ready_work", ticket_page (List.filter tickets ~f:(ready t) |> sort_ready)
          ; ( "in_progress_work"
            , ticket_page
                (List.filter tickets ~f:(fun ticket ->
                   Domain_command.Status.equal ticket.Ticket.status In_progress)) )
          ; "blocked_work", ticket_page (List.filter tickets ~f:blocked)
          ; "tickets", page (List.map tickets ~f:Ticket.jsonaf_of_t)
          ; "milestones", page (List.map milestones ~f:Milestone.jsonaf_of_t)
          ]
      | "milestone.list" ->
        let project =
          Option.map (Json.optional params "project_id") ~f:Id.Project.t_of_jsonaf
        in
        page
          (Map.data t.milestones
           |> List.filter ~f:(fun milestone ->
             Option.for_all project ~f:(Id.Project.equal milestone.Milestone.project)
             && (include_archived || not milestone.archived))
           |> List.map ~f:Milestone.jsonaf_of_t)
      | "milestone.get" ->
        let id = Id.Milestone.t_of_jsonaf (Json.field params "milestone_id") in
        let milestone = find_milestone t id in
        let tickets =
          Map.data t.tickets
          |> List.filter ~f:(fun ticket ->
            Option.value_map
              ticket.Ticket.milestone
              ~default:false
              ~f:(Id.Milestone.equal id)
            && (include_archived || not ticket.archived))
        in
        Json.obj
          [ "milestone", Milestone.jsonaf_of_t milestone; "progress", progress tickets ]
      | "search.query" ->
        let documents = search_documents t ~params ~resource_texts in
        let kinds = search_kinds params in
        let matches =
          Search.matches
            documents
            ~text:(Json.text (Json.field params "text"))
            ~kinds
            ~offset
            ~limit
        in
        let eligible =
          match search_resources t ~params with
          | Ok resources -> resources
          | Error error -> raise (Json.Decode_error error)
        in
        let indexed =
          List.count resource_texts ~f:(fun text ->
            match text.Search.Text.outcome with
            | Content _ -> true
            | Invalid_utf8 -> false)
        in
        let truncated =
          List.count resource_texts ~f:(fun text ->
            match text.Search.Text.outcome with
            | Content { text; total_bytes } -> String.length text < total_bytes
            | Invalid_utf8 -> false)
        in
        let scope = search_scope t params in
        let omitted_resources =
          Map.data t.resources
          |> List.filter ~f:(fun r -> scope (Entity_ref.Resource r.Resource.id))
          |> List.filter_map ~f:(fun resource ->
            let version = Resource.get_version resource ~revision:None in
            let reason =
              match
                List.find resource_texts ~f:(fun text ->
                  Id.Resource.equal text.Search.Text.id resource.id)
              with
              | Some { outcome = Search.Text.Content { text; total_bytes }; _ }
                when String.length text < total_bytes ->
                Some ("prefix_only", String.length text, total_bytes - String.length text)
              | Some { outcome = Content _; _ } -> None
              | Some { outcome = Invalid_utf8; _ } ->
                Some ("invalid_utf8", 0, Option.value version.size_bytes ~default:0)
              | None ->
                Some
                  ( (if
                       not
                         (Option.for_all kinds ~f:(fun kinds ->
                            List.mem kinds "resource_text" ~equal:String.equal))
                     then "not_requested"
                     else if searchable_text version.mime_type
                     then "query_text_budget"
                     else "unsupported_mime")
                  , 0
                  , Option.value version.size_bytes ~default:0 )
            in
            Option.map reason ~f:(fun (reason, indexed, omitted) ->
              Json.obj
                [ ( "source"
                  , Search.Source.json
                      (Resource_text resource.id)
                      ~revision:version.revision )
                ; "reason", Json.string reason
                ; "indexed_bytes", Json.int indexed
                ; "omitted_bytes", Json.int omitted
                ; ( "size_known"
                  , if Option.is_some version.size_bytes then `True else `False )
                ]))
        in
        let remaining = Int.max 0 (matches.total - offset - List.length matches.items) in
        let results =
          Json.obj
            [ "items", `Array matches.items
            ; "offset", Json.int offset
            ; "remaining", Json.int remaining
            ; ( "next_offset"
              , if remaining > 0
                then Json.int (offset + List.length matches.items)
                else `Null )
            ]
        in
        (match results with
         | `Object fields ->
           Json.obj
             (fields
              @ [ "unindexed_resources", page omitted_resources
                ; "index_revision", Json.int t.revision
                ; "sources_scanned", Json.int (List.length documents)
                ; ( "coverage"
                  , Json.obj
                      [ "current_revisions_only", `True
                      ; "eligible_text_resources", Json.int (List.length eligible)
                      ; "indexed_text_resources", Json.int indexed
                      ; ( "unindexed_text_resources"
                        , Json.int (List.length eligible - indexed) )
                      ; "truncated_text_resources", Json.int truncated
                      ; "resource_prefix_bytes", Json.int 65_536
                      ; "request_text_bytes", Json.int (1024 * 1024)
                      ] )
                ])
         | _ -> assert false)
      | "ticket.list" | "ticket.ready" ->
        let search =
          Option.value_map (Json.optional params "text") ~default:"" ~f:Json.text
          |> String.lowercase
        in
        let project =
          Option.map (Json.optional params "project_id") ~f:Id.Project.t_of_jsonaf
        in
        let filter key f = Option.map (Json.optional params key) ~f in
        let milestone = filter "milestone_id" Id.Milestone.t_of_jsonaf in
        let assignee = filter "assignee_id" Id.Actor.t_of_jsonaf in
        let label = filter "label_id" Id.Label.t_of_jsonaf in
        let status =
          filter "status" (fun j -> Domain_command.Status.of_name (Json.text j))
        in
        let priority = filter "priority" Json.integer in
        Option.iter priority ~f:(fun value ->
          require (value <= 4) Invalid_argument "invalid priority");
        let tickets =
          Map.data t.tickets
          |> List.filter ~f:(fun ticket ->
            (include_archived || active_scope t ticket)
            && ((not (String.equal method_ "ticket.ready")) || ready t ticket)
            && (Option.is_none project
                || Option.equal Id.Project.equal project ticket.project)
            && Option.for_all milestone ~f:(fun id ->
              Option.equal Id.Milestone.equal ticket.milestone (Some id))
            && Option.for_all assignee ~f:(fun id ->
              Option.equal Id.Actor.equal ticket.assignee (Some id))
            && Option.for_all label ~f:(fun id ->
              List.mem ticket.labels id ~equal:Id.Label.equal)
            && Option.for_all status ~f:(Domain_command.Status.equal ticket.status)
            && Option.for_all priority ~f:(Int.equal ticket.priority)
            && String.is_substring
                 (String.lowercase (ticket.title ^ "\n" ^ ticket.description))
                 ~substring:search)
        in
        let tickets =
          if String.equal method_ "ticket.ready" then sort_ready tickets else tickets
        in
        page (List.map tickets ~f:Ticket.jsonaf_of_t)
      | "ticket.readiness" ->
        readiness
          t
          (find_ticket t (Id.Ticket.t_of_jsonaf (Json.field params "ticket_id")))
      | "ticket.blockers" ->
        let ticket =
          find_ticket t (Id.Ticket.t_of_jsonaf (Json.field params "ticket_id"))
        in
        ticket_page (List.map (blockers t ticket) ~f:(find_ticket t))
      | "ticket.resolve" ->
        let key = Json.bounded_text (Json.field params "display_key") ~max_bytes:96 in
        let id =
          match Map.find t.ticket_keys key with
          | Some id -> id
          | None -> Json.fail Not_found "ticket display key not found"
        in
        Json.obj [ "ticket_id", Id.Ticket.jsonaf_of_t id; "display_key", Json.string key ]
      | "ticket.context" ->
        let id = Id.Ticket.t_of_jsonaf (Json.field params "ticket_id") in
        let ticket = find_ticket t id in
        let after =
          Option.value_map (Map.find t.handoffs id) ~default:0 ~f:(fun h ->
            h.Handoff.covers_through)
        in
        let updates =
          Discussion.since t.discussion ~target:(Entity_ref.Ticket id) ~after
        in
        Json.obj
          [ "ticket", Ticket.jsonaf_of_t ticket
          ; "related", ticket_page (List.map ticket.related ~f:(find_ticket t))
          ; "resources", resources (Entity_ref.Ticket id)
          ; "communication", communication_context (Entity_ref.Ticket id)
          ; ( "attempts"
            , page
                (List.map
                   (Agent_run.attempts_for_ticket t.agent_runs id)
                   ~f:Attempt.jsonaf_of_t) )
          ; ( "evidence"
            , unwrap_domain
                (Evidence.query
                   t.evidence
                   ~method_:"evidence.context"
                   ~params:
                     (Json.obj
                        [ "ticket_id", Id.Ticket.jsonaf_of_t id
                        ; "max_bytes", Json.int max_bytes
                        ])) )
          ; "readiness", readiness t ticket
          ; ( "parent"
            , Option.value_map ticket.parent ~default:`Null ~f:(fun id ->
                Ticket.jsonaf_of_t (find_ticket t id)) )
          ; ( "children"
            , page
                (Map.data t.tickets
                 |> List.filter ~f:(fun child ->
                   Option.value_map
                     child.Ticket.parent
                     ~default:false
                     ~f:(Id.Ticket.equal id))
                 |> List.map ~f:Ticket.jsonaf_of_t) )
          ; "blockers", `Array (List.map (blockers t ticket) ~f:Id.Ticket.jsonaf_of_t)
          ; ( "handoff"
            , Option.value_map
                (Map.find t.handoffs id)
                ~default:`Null
                ~f:Handoff.jsonaf_of_t )
          ; "updates", page updates
          ; ( "activity_since_handoff"
            , page
                (List.rev (scoped_activity (Some (Entity_ref.Ticket id)))
                 |> List.filter ~f:(fun event ->
                   Json.integer (Json.field event "revision") > after)
                 |> List.map ~f:event_summary) )
          ]
      | "handoff.get" | "handoff.history" ->
        let id = Id.Ticket.t_of_jsonaf (Json.field params "ticket_id") in
        ignore (find_ticket t id : Ticket.t);
        if String.equal method_ "handoff.get"
        then (
          match Map.find t.handoffs id with
          | Some handoff -> Handoff.jsonaf_of_t handoff
          | None -> Json.fail Not_found "handoff not found")
        else
          List.rev t.activity
          |> List.concat_map ~f:(fun event ->
            Json.list (Json.field event "changes")
            |> List.filter_map ~f:(fun change ->
              match Event.t_of_jsonaf change with
              | Handoff_put handoff when Id.Ticket.equal handoff.ticket id ->
                Some (Handoff.jsonaf_of_t handoff)
              | Handoff_put _
              | Communication_changed _
              | Agent_run_changed _
              | Evidence_changed _
              | Allocation_empty _
              | Policy_changed _
              | Policy_unchanged _
              | Settings_changed _
              | Workspace_updated _
              | Project_put _
              | Milestone_put _
              | Ticket_put _
              | Comment_changed _
              | Resource_changed _ -> None))
          |> page
      | "comment.get" | "comment.history" ->
        let id = Id.Comment.t_of_jsonaf (Json.field params "comment_id") in
        if String.equal method_ "comment.get"
        then Discussion.get t.discussion id
        else page (Discussion.history t.discussion id)
      | "comment.list" ->
        let target =
          match Json.optional params "target", Json.optional params "ticket_id" with
          | None, None -> None
          | Some value, None -> Some (Entity_ref.t_of_jsonaf value)
          | None, Some value -> Some (Entity_ref.Ticket (Id.Ticket.t_of_jsonaf value))
          | Some _, Some _ ->
            Json.fail Invalid_argument "provide target or ticket_id, not both"
        in
        Option.iter target ~f:(validate_target t);
        let include_tombstones =
          match Json.optional params "include_tombstones" with
          | None | Some `False -> false
          | Some `True -> true
          | Some _ -> Json.fail Invalid_argument "include_tombstones must be boolean"
        in
        page (Discussion.list t.discussion ~target ~include_tombstones)
      | "activity.since" ->
        let after =
          Option.value_map (Json.optional params "after") ~default:0 ~f:Json.integer
        in
        let target =
          match Json.optional params "target", Json.optional params "project_id" with
          | None, None -> None
          | Some value, None -> Some (Entity_ref.t_of_jsonaf value)
          | None, Some value -> Some (Entity_ref.Project (Id.Project.t_of_jsonaf value))
          | Some _, Some _ ->
            Json.fail Invalid_argument "provide target or project_id, not both"
        in
        Option.iter target ~f:(validate_target t);
        let actor =
          Option.map (Json.optional params "actor_id") ~f:Id.Actor.t_of_jsonaf
        in
        let items =
          List.rev (scoped_activity target)
          |> List.filter ~f:(fun j ->
            Json.integer (Json.field j "revision") > after
            && Option.for_all actor ~f:(fun actor ->
              Id.Actor.equal actor (Id.Actor.t_of_jsonaf (Json.field j "actor"))))
        in
        page items
      | "resource.list" ->
        let target =
          Option.map (Json.optional params "target") ~f:Entity_ref.t_of_jsonaf
        in
        Option.iter target ~f:(validate_target t);
        page
          (Map.data t.resources
           |> List.filter ~f:(fun r ->
             (include_archived || not r.Resource.metadata.archived)
             && Option.for_all target ~f:(fun target ->
               List.mem r.metadata.targets target ~equal:Entity_ref.equal))
           |> List.map ~f:resource_json)
      | "resource.get" | "resource.history" ->
        let id = Id.Resource.t_of_jsonaf (Json.field params "resource_id") in
        let resource =
          match Map.find t.resources id with
          | Some r -> r
          | None -> Json.fail Not_found "resource not found"
        in
        if String.equal method_ "resource.history"
        then page (List.rev_map resource.versions ~f:Resource.Version.jsonaf_of_t)
        else resource_json resource
      | _ -> Json.fail Invalid_argument ("unknown query method: " ^ method_)
    in
    Query_budget.fit
      ~max_bytes
      (Json.obj [ "workspace_revision", Json.int t.revision; "data", body ]))
;;

let query t ~method_ ~params =
  if String.equal method_ "changes.read"
  then
    Change_feed.read
      ~workspace:t.workspace
      ~revision:t.revision
      ~activity:t.activity
      ~params
  else if List.mem Agent_run_policy.query_methods method_ ~equal:String.equal
  then Agent_run_policy.query t.policies ~runs:t.agent_runs ~method_ ~params
  else if List.mem Agent_run.query_methods method_ ~equal:String.equal
  then Agent_run.query t.agent_runs ~method_ ~params
  else if List.mem Evidence.query_methods method_ ~equal:String.equal
  then Evidence.query t.evidence ~method_ ~params
  else if List.mem Communication.query_methods method_ ~equal:String.equal
  then Communication.query t.communication ~method_ ~params
  else query_with_texts t ~resource_texts:[] ~method_ ~params
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

let required_blobs prepared =
  Json.list (Json.field prepared.events "changes")
  |> List.filter_map ~f:(fun change ->
    match Event.t_of_jsonaf change with
    | Resource_changed (Resource.Change.Published { version; _ }) ->
      Some (version.digest, version.size_bytes)
    | Resource_changed (Metadata_changed _)
    | Communication_changed _
    | Agent_run_changed _
    | Evidence_changed _
    | Allocation_empty _
    | Policy_changed _
    | Policy_unchanged _
    | Project_put _
    | Milestone_put _
    | Ticket_put _
    | Comment_changed _
    | Handoff_put _
    | Settings_changed _
    | Workspace_updated _ -> None)
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

let readable_files t =
  let values map = Map.to_sequence map |> Sequence.map ~f:snd in
  let resources =
    values t.resources
    |> Sequence.map ~f:(fun resource ->
      ( "resources/" ^ Id.Resource.to_string resource.Resource.id ^ ".md"
      , "# "
        ^ resource.metadata.title
        ^ "\n\n"
        ^ resource.metadata.description
        ^ "\n\n```json\n"
        ^ Json.pretty (Resource.jsonaf_of_t resource)
        ^ "\n```\n\n"
        ^ String.concat
            (List.rev_map resource.versions ~f:(fun version ->
               "- Version "
               ^ Int.to_string version.Resource.Version.revision
               ^ ": [bytes]("
               ^ version.digest
               ^ ".bin)\n")) ))
  in
  let projects =
    values t.projects
    |> Sequence.map ~f:(fun p ->
      ( "projects/" ^ Id.Project.to_string p.Project.id ^ ".md"
      , "# "
        ^ p.title
        ^ "\n\n"
        ^ p.description
        ^ "\n\n```json\n"
        ^ Json.pretty (Project.jsonaf_of_t p)
        ^ "\n```\n" ))
  in
  let milestones =
    values t.milestones
    |> Sequence.map ~f:(fun m ->
      ( "milestones/" ^ Id.Milestone.to_string m.Milestone.id ^ ".md"
      , "# "
        ^ m.title
        ^ "\n\n"
        ^ m.description
        ^ "\n\n```json\n"
        ^ Json.pretty (Milestone.jsonaf_of_t m)
        ^ "\n```\n" ))
  in
  let comments =
    Discussion.ids t.discussion
    |> Sequence.map ~f:(fun id ->
      let comment = Discussion.get t.discussion id in
      ( "comments/" ^ Id.Comment.to_string id ^ ".md"
      , "# Comment "
        ^ Id.Comment.to_string id
        ^ "\n\n"
        ^ Json.text (Json.field comment "body")
        ^ "\n\n## Revision history\n\n```json\n"
        ^ Json.pretty (`Array (Discussion.history t.discussion id))
        ^ "\n```\n" ))
  in
  let tickets =
    values t.tickets
    |> Sequence.map ~f:(fun ticket ->
      let updates =
        Discussion.since
          t.discussion
          ~target:(Entity_ref.Ticket ticket.Ticket.id)
          ~after:0
        |> List.map ~f:(fun update ->
          "\n## Comment revision\n\n```json\n" ^ Json.pretty update ^ "\n```\n")
      in
      let handoff =
        Option.value_map (Map.find t.handoffs ticket.id) ~default:"" ~f:(fun h ->
          "\n## Handoff\n\n"
          ^ h.Handoff.summary
          ^ "\n\nNext steps: "
          ^ h.next_steps
          ^ "\n\nEvidence: "
          ^ h.evidence
          ^ "\n")
      in
      ( "tickets/" ^ Id.Ticket.to_string ticket.id ^ ".md"
      , "# "
        ^ ticket.display_key
        ^ " "
        ^ ticket.title
        ^ "\n\n"
        ^ ticket.description
        ^ "\n\n```json\n"
        ^ Json.pretty (Ticket.jsonaf_of_t ticket)
        ^ "\n```\n"
        ^ handoff
        ^ String.concat updates ))
  in
  Sequence.append
    (Sequence.of_lazy
       (lazy
         (Sequence.of_list
            [ "workspace.json", Json.pretty (to_json t) ^ "\n"
            ; ( "communication.json"
              , Json.pretty (Communication.to_json t.communication) ^ "\n" )
            ; "runs.json", Json.pretty (Agent_run.to_json t.agent_runs) ^ "\n"
            ; "evidence.json", Json.pretty (Evidence.to_json t.evidence) ^ "\n"
            ; "policies.json", Json.pretty (Agent_run_policy.to_json t.policies) ^ "\n"
            ; ( "README.md"
              , "# "
                ^ name t
                ^ "\n\nWorkspace revision "
                ^ Int.to_string t.revision
                ^ ".\n" )
            ])))
    (Sequence.of_list [ projects; milestones; comments; resources; tickets ]
     |> Sequence.concat)
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

let coordination_tickets t =
  Map.data t.tickets
  |> List.filter ~f:(fun ticket -> not ticket.Ticket.archived)
  |> List.map ~f:(fun ticket ->
    { Coordinator.Ticket.id = ticket.id
    ; project = ticket.project
    ; title = ticket.title
    ; status = ticket.status
    ; prerequisites = ticket.prerequisites
    ; ready = ready t ticket
    ; blockers = readiness t ticket
    ; claim =
        Option.map ticket.claim ~f:(fun c ->
          { Coordinator.Claim.actor = c.actor
          ; run = c.run_id
          ; token = c.token
          ; lease = c.lease
          })
    })
;;
