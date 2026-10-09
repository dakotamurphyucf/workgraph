open Core
module Status = Agent_run_event.Status
module Parent_stop_policy = Agent_run_event.Parent_stop_policy
module Runner_action = Agent_run_event.Runner_action
module Record = Agent_run_event.Record
module Change = Agent_run_event
module Command = Agent_run_command
module Update = Change.Update

type t =
  { revision : int
  ; runs : Record.t Id.Run.Map.t
  ; attempts : Attempt.t Attempt.Id.Map.t
  ; attempt_started : int Attempt.Id.Map.t
  ; reservations : Reservation.t Reservation.Name.Map.t
  ; path_reservations : Path_reservation.t Path_scope.Map.t
  ; ticket_paths : Ticket_paths.t Id.Ticket.Map.t
  ; conditions : External_condition.t
  ; recoveries : Ownership_recovery.t Coordination_id.Recovery.Map.t
  ; pools : Allocation.Definition.t String.Map.t
  ; ticket_policies : Allocation.Ticket_policy.t Id.Ticket.Map.t
  ; actions : Runner_action.t list
  }

type prepared =
  { candidate : t
  ; changes : Change.t list
  ; result : Jsonaf.t
  }

let empty =
  { revision = 0
  ; runs = Id.Run.Map.empty
  ; attempts = Attempt.Id.Map.empty
  ; attempt_started = Attempt.Id.Map.empty
  ; reservations = Reservation.Name.Map.empty
  ; path_reservations = Path_scope.Map.empty
  ; ticket_paths = Id.Ticket.Map.empty
  ; conditions = External_condition.empty
  ; recoveries = Coordination_id.Recovery.Map.empty
  ; pools = String.Map.empty
  ; ticket_policies = Id.Ticket.Map.empty
  ; actions = []
  }
;;

let revision t = t.revision
let candidate p = p.candidate
let changes p = p.changes
let result p = p.result
let get_run t id = Map.find t.runs id
let get_attempt t id = Map.find t.attempts id
let get_reservation t id = Map.find t.reservations id
let pending_actions t = t.actions

let attempts_for_ticket t ticket =
  List.filter (Map.data t.attempts) ~f:(fun a -> Id.Ticket.equal a.Attempt.ticket ticket)
;;

let require condition kind message = if not condition then Json.fail kind message

let find map id =
  match Map.find map id with
  | Some value -> value
  | None -> Json.fail Not_found "Run coordination record not found"
;;

let expected actual revision =
  if not (Int.equal actual revision)
  then
    raise
      (Json.Decode_error
         (Problem.with_details
            (Problem.create Conflict "Revision conflict")
            (Revision { expected = revision; actual })))
;;

let bound text max =
  require (String.length text <= max) Invalid_argument "Run metadata exceeds byte limit"
;;

let nonempty text max =
  bound text max;
  require (not (String.is_empty (String.strip text))) Invalid_argument "Run text is empty"
;;

let active record =
  require (not (Status.terminal record.Record.status)) Conflict "Run is terminal"
;;

let owner (record : Record.t) actor actor_run =
  require (Id.Actor.equal record.actor actor) Conflict "Run actor differs";
  Option.iter actor_run ~f:(fun id ->
    require (Id.Run.equal id record.id) Conflict "Run attribution differs")
;;

let children_actions t parent =
  Map.data t.runs
  |> List.filter_map ~f:(fun child ->
    if
      Option.value_map child.Record.parent ~default:false ~f:(Id.Run.equal parent)
      && not (Status.terminal child.status)
    then (
      match child.parent_stop_policy with
      | Parent_stop_policy.Continue -> None
      | Request_cancel | Request_wait ->
        Some { Runner_action.parent; child = child.id; policy = child.parent_stop_policy })
    else None)
;;

module Start_blocker = struct
  type t =
    | Run_required of Path_scope.t
    | Path_conflict of
        { target : Path_scope.t
        ; reservation : Path_scope.t
        ; holder : Reservation.Holder.t
        }
    | Expired_required_ownership of
        { target : Path_scope.t
        ; reservation : Path_scope.t
        ; holder : Reservation.Holder.t
        }
    | Ownership_mode of
        { target : Path_scope.t
        ; holder : Reservation.Holder.t
        }
    | External_condition of External_condition.Blocker.t
  [@@deriving sexp, equal]

  let to_json blocker =
    let target t = Path_scope.jsonaf_of_t t in
    let holder h = Coordination_wire.encode_exn Agent_run_wire.holder h in
    let kind name fields = Json.obj (("kind", Json.string name) :: fields) in
    match blocker with
    | Run_required t -> kind "run_required" [ "target", target t ]
    | Path_conflict p ->
      kind
        "path_conflict"
        [ "target", target p.target
        ; "reservation", target p.reservation
        ; "holder", holder p.holder
        ]
    | Expired_required_ownership p ->
      kind
        "expired_required_ownership"
        [ "target", target p.target
        ; "reservation", target p.reservation
        ; "holder", holder p.holder
        ]
    | Ownership_mode p ->
      kind "ownership_mode" [ "target", target p.target; "holder", holder p.holder ]
    | External_condition c ->
      kind
        "external_condition"
        [ "condition_id", Coordination_id.Condition.jsonaf_of_t c.condition_id
        ; "revision", Json.int c.revision
        ; "operation_id", Coordination_id.Operation.jsonaf_of_t c.operation_id
        ; "artifact", Coordination_wire.encode_exn Evidence_wire.pin c.artifact
        ; "label", Json.string c.label
        ]
  ;;
end

let required_declarations t ticket =
  match Map.find t.ticket_paths ticket with
  | Some p when p.require_reservations -> p.declarations
  | Some _ | None -> []
;;

let compatible held required =
  Reservation.Mode.equal required Shared || Reservation.Mode.equal held Exclusive
;;

let owned_covering t (declaration : Ticket_paths.Declaration.t) run =
  Map.data t.path_reservations
  |> List.concat_map ~f:(fun reservation ->
    if Path_scope.covers reservation.Path_reservation.target declaration.target
    then
      List.filter_map reservation.holders ~f:(fun holder ->
        if
          Id.Run.equal holder.Reservation.Holder.run run
          && compatible holder.mode declaration.mode
        then Some (reservation.target, holder)
        else None)
    else [])
;;

let live holder now =
  Allocation_lease.Status.equal
    (Allocation_lease.status holder.Reservation.Holder.lease ~now_unix_ms:now)
    Valid
;;

let start_blockers t ~ticket ~run ~now_unix_ms =
  let path_blockers =
    List.concat_map (required_declarations t ticket) ~f:(fun declaration ->
      let conflicts =
        Map.data t.path_reservations
        |> List.concat_map ~f:(fun reservation ->
          Path_reservation.conflicts
            reservation
            ~target:declaration.target
            ~mode:declaration.mode
            ~excluding_run:run
          |> List.map ~f:(fun holder ->
            Start_blocker.Path_conflict
              { target = declaration.target; reservation = reservation.target; holder }))
      in
      let ownership =
        match run with
        | None -> [ Start_blocker.Run_required declaration.target ]
        | Some run ->
          let covering = owned_covering t declaration run in
          if List.exists covering ~f:(fun (_, h) -> live h now_unix_ms)
          then []
          else if not (List.is_empty covering)
          then
            List.map covering ~f:(fun (reservation, holder) ->
              Start_blocker.Expired_required_ownership
                { target = declaration.target; reservation; holder })
          else (
            match Map.find t.path_reservations declaration.target with
            | None -> []
            | Some reservation ->
              List.filter_map reservation.holders ~f:(fun holder ->
                if
                  Id.Run.equal holder.Reservation.Holder.run run
                  && not (compatible holder.mode declaration.mode)
                then
                  Some
                    (Start_blocker.Ownership_mode { target = declaration.target; holder })
                else None))
      in
      ownership @ conflicts)
  in
  path_blockers
  @ List.map (External_condition.blockers t.conditions ~ticket) ~f:(fun b ->
    Start_blocker.External_condition b)
;;

let rec apply_exn ?started_at t (change : Change.t) =
  Change.validate change;
  expected change.revision (t.revision + 1);
  let next =
    match change.update with
    | Update.Pool_put pool ->
      nonempty pool.name 96;
      require
        (pool.limit > 0 && pool.limit <= 10000)
        Invalid_argument
        "Pool limit must be 1..10000";
      expected
        pool.revision
        (Option.value_map (Map.find t.pools pool.name) ~default:1 ~f:(fun p ->
           p.Allocation.Definition.revision + 1));
      { t with pools = Map.set t.pools ~key:pool.name ~data:pool }
    | Ticket_policy_put policy ->
      require
        (not
           (Map.exists t.attempts ~f:(fun a ->
              Id.Ticket.equal a.Attempt.ticket policy.ticket
              && not (Attempt.State.terminal a.state))))
        Conflict
        "Cannot change allocation policy while ticket has an active attempt";
      expected
        policy.revision
        (Option.value_map
           (Map.find t.ticket_policies policy.ticket)
           ~default:1
           ~f:(fun p -> p.Allocation.Ticket_policy.revision + 1));
      require
        (List.length policy.required_capabilities <= 100
         && List.length policy.pools <= 100)
        Invalid_argument
        "Ticket allocation policy exceeds limit";
      List.iter policy.required_capabilities ~f:(fun c -> nonempty c 96);
      require
        ((not (List.contains_dup policy.required_capabilities ~compare:String.compare))
         && not (List.contains_dup policy.pools ~compare:String.compare))
        Invalid_argument
        "Duplicate allocation policy member";
      List.iter policy.pools ~f:(fun name ->
        ignore (find t.pools name : Allocation.Definition.t));
      { t with
        ticket_policies = Map.set t.ticket_policies ~key:policy.ticket ~data:policy
      }
    | Update.Run_put record ->
      Record.validate record;
      let actions =
        match Map.find t.runs record.id with
        | None ->
          require
            (record.revision = 1
             && Status.equal record.status Running
             && Option.is_none record.last_observed_unix_ms
             && List.is_empty record.sessions
             && String.is_empty record.evidence)
            Conflict
            "Registered run has invalid initial state";
          require
            (Id.Actor.equal record.actor change.actor)
            Conflict
            "Registration actor differs";
          Option.iter record.parent ~f:(fun id -> active (find t.runs id));
          t.actions
        | Some previous ->
          expected record.revision (previous.revision + 1);
          active previous;
          owner previous change.actor change.actor_run;
          require
            (Id.Run.equal previous.id record.id
             && Id.Actor.equal previous.actor record.actor
             && Option.equal Id.Run.equal previous.parent record.parent
             && Parent_stop_policy.equal
                  previous.parent_stop_policy
                  record.parent_stop_policy
             && String.equal previous.objective record.objective
             && List.equal String.equal previous.capabilities record.capabilities
             && Option.equal String.equal previous.process_ref record.process_ref
             && Option.equal String.equal previous.worktree_ref record.worktree_ref)
            Conflict
            "Run provenance is immutable";
          require
            (List.is_prefix
               record.sessions
               ~prefix:previous.sessions
               ~equal:Session_id.equal
             && List.length record.sessions <= List.length previous.sessions + 1)
            Conflict
            "Run session history is append-only";
          (match previous.last_observed_unix_ms, record.last_observed_unix_ms with
           | Some before, Some after ->
             require Int64.(after >= before) Conflict "Observation time moved backwards"
           | Some _, None -> Json.fail Conflict "Observation time cannot be removed"
           | None, Some _ | None, None -> ());
          let status_changed = not (Status.equal previous.status record.status) in
          let observation_changed =
            not
              (Option.equal
                 Int64.equal
                 previous.last_observed_unix_ms
                 record.last_observed_unix_ms)
          in
          let sessions_changed =
            not (List.equal Session_id.equal previous.sessions record.sessions)
          in
          require
            (Bool.to_int status_changed
             + Bool.to_int observation_changed
             + Bool.to_int sessions_changed
             = 1)
            Conflict
            "Run event must change exactly one lifecycle field";
          if not status_changed
          then
            require
              (String.equal previous.evidence record.evidence)
              Conflict
              "Run evidence only changes with status";
          if Status.equal record.status Completed
          then
            require
              (not
                 (Map.exists t.attempts ~f:(fun a ->
                    Id.Run.equal a.Attempt.run record.id
                    && not (Attempt.State.terminal a.state))))
              Conflict
              "Run still has active attempts";
          if Status.equal record.status Cancelled
          then t.actions @ children_actions t record.id
          else t.actions
      in
      { t with runs = Map.set t.runs ~key:record.id ~data:record; actions }
    | Attempt_started { attempt; now_unix_ms } ->
      require
        Int64.(now_unix_ms >= 0L)
        Invalid_argument
        "Attempt start clock must be nonnegative";
      require
        (Option.is_none (Map.find t.attempts attempt.id))
        Conflict
        "Attempt already exists";
      require
        (List.is_empty
           (start_blockers t ~ticket:attempt.ticket ~run:(Some attempt.run) ~now_unix_ms))
        Blocked
        "Required paths or external conditions block attempt start";
      List.iter (required_declarations t attempt.ticket) ~f:(fun d ->
        require
          (List.exists (owned_covering t d attempt.run) ~f:(fun (_, h) ->
             live h now_unix_ms))
          Blocked
          "Attempt start requires committed path ownership");
      apply_exn ~started_at:now_unix_ms t { change with update = Attempt_put attempt }
    | Attempt_put attempt ->
      let record = find t.runs attempt.run in
      let previous = Map.find t.attempts attempt.id in
      Attempt.validate_transition ~previous attempt;
      (match previous with
       | None ->
         require
           (Option.is_some started_at)
           Corrupt_store
           "New attempt requires recorded start clock";
         active record;
         Option.iter (Map.find t.ticket_policies attempt.ticket) ~f:(fun policy ->
           require
             (List.for_all
                policy.Allocation.Ticket_policy.required_capabilities
                ~f:(fun c -> List.mem record.capabilities c ~equal:String.equal))
             Blocked
             "Run lacks a required capability";
           List.iter policy.pools ~f:(fun name ->
             let pool = find t.pools name in
             let active =
               Map.count t.attempts ~f:(fun a ->
                 (not (Attempt.State.terminal a.Attempt.state))
                 && Option.value_map
                      (Map.find t.ticket_policies a.ticket)
                      ~default:false
                      ~f:(fun p ->
                        List.mem p.Allocation.Ticket_policy.pools name ~equal:String.equal))
             in
             require
               (active < pool.Allocation.Definition.limit)
               Blocked
               "Concurrency pool is full"));
         require
           (not
              (Map.exists t.attempts ~f:(fun a ->
                 Id.Ticket.equal a.Attempt.ticket attempt.ticket
                 && not (Attempt.State.terminal a.state))))
           Already_claimed
           "Ticket has an active attempt"
       | Some _ -> ());
      owner record change.actor change.actor_run;
      { t with
        attempts = Map.set t.attempts ~key:attempt.id ~data:attempt
      ; attempt_started =
          (match previous with
           | None -> Map.set t.attempt_started ~key:attempt.id ~data:change.revision
           | Some _ -> t.attempt_started)
      }
    | Reservation_put reservation ->
      Reservation.validate reservation;
      let old =
        Option.value
          (Map.find t.reservations reservation.name)
          ~default:{ Reservation.name = reservation.name; epoch = 0; holders = [] }
      in
      let added =
        List.filter reservation.holders ~f:(fun h ->
          not (List.exists old.holders ~f:(Reservation.Holder.equal h)))
      in
      let removed =
        List.filter old.holders ~f:(fun h ->
          not (List.exists reservation.holders ~f:(Reservation.Holder.equal h)))
      in
      (match added, removed with
       | [ h ], [] ->
         let record = find t.runs h.run in
         active record;
         owner record change.actor change.actor_run;
         require
           (Id.Actor.equal h.actor change.actor)
           Conflict
           "Reservation attribution differs";
         let reconstructed =
           Reservation.acquire
             old
             ~run:h.run
             ~actor:h.actor
             ~mode:h.mode
             ~now_unix_ms:(Allocation_lease.last_unix_ms h.lease)
             ~lease_duration_ms:
               (match Allocation_lease.policy h.lease with
                | Indefinite -> None
                | Duration_ms n -> Some n)
         in
         require
           (Reservation.equal reconstructed reservation)
           Conflict
           "Invalid reservation acquisition"
       | [], [ h ] ->
         owner (find t.runs h.run) change.actor change.actor_run;
         require
           (Reservation.equal
              (Reservation.release old ~run:h.run ~token:h.token)
              reservation)
           Conflict
           "Invalid reservation release"
       | [ next ], [ previous ] ->
         owner (find t.runs next.run) change.actor change.actor_run;
         require
           (Id.Run.equal next.run previous.run
            && Int.equal next.token previous.token
            && Id.Actor.equal next.actor previous.actor
            && Reservation.Mode.equal next.mode previous.mode)
           Conflict
           "Reservation renewal cannot change ownership";
         let reconstructed =
           Reservation.renew
             old
             ~run:next.run
             ~token:next.token
             ~expected_lease_revision:(Allocation_lease.revision previous.lease)
             ~now_unix_ms:(Allocation_lease.last_unix_ms next.lease)
         in
         require
           (Reservation.equal reconstructed reservation)
           Conflict
           "Invalid reservation renewal"
       | [], [] | _ :: _, _ :: _ | [], _ :: _ :: _ | _ :: _ :: _, [] ->
         Json.fail Conflict "Reservation event must grant or release one holder");
      { t with
        reservations = Map.set t.reservations ~key:reservation.name ~data:reservation
      }
    | Path_reservation_put reservation ->
      Path_reservation.validate reservation;
      let old =
        Option.value
          (Map.find t.path_reservations reservation.target)
          ~default:
            { Path_reservation.target = reservation.target; epoch = 0; holders = [] }
      in
      let added =
        List.filter reservation.holders ~f:(fun h ->
          not (List.mem old.holders h ~equal:Reservation.Holder.equal))
      in
      let removed =
        List.filter old.holders ~f:(fun h ->
          not (List.mem reservation.holders h ~equal:Reservation.Holder.equal))
      in
      (match added, removed with
       | [ h ], [] ->
         let record = find t.runs h.run in
         active record;
         owner record change.actor change.actor_run;
         require
           (Id.Actor.equal h.actor change.actor)
           Conflict
           "Path reservation actor differs";
         Map.iter t.path_reservations ~f:(fun other ->
           require
             (List.is_empty
                (Path_reservation.conflicts
                   other
                   ~target:reservation.target
                   ~mode:h.mode
                   ~excluding_run:(Some h.run)))
             Already_claimed
             "Overlapping path reservation is unavailable");
         let reconstructed =
           Path_reservation.acquire
             old
             ~run:h.run
             ~actor:h.actor
             ~mode:h.mode
             ~now_unix_ms:(Allocation_lease.last_unix_ms h.lease)
             ~lease_duration_ms:
               (match Allocation_lease.policy h.lease with
                | Indefinite -> None
                | Duration_ms n -> Some n)
         in
         require
           (Path_reservation.equal reconstructed reservation)
           Conflict
           "Invalid path acquisition"
       | [], [ h ] ->
         owner (find t.runs h.run) change.actor change.actor_run;
         require
           (Path_reservation.equal
              (Path_reservation.release old ~run:h.run ~token:h.token)
              reservation)
           Conflict
           "Invalid path release"
       | [ next ], [ previous ] ->
         owner (find t.runs next.run) change.actor change.actor_run;
         require
           (Id.Run.equal next.run previous.run
            && Int.equal next.token previous.token
            && Id.Actor.equal next.actor previous.actor
            && Reservation.Mode.equal next.mode previous.mode)
           Conflict
           "Path renewal cannot change ownership";
         let reconstructed =
           Path_reservation.renew
             old
             ~run:next.run
             ~token:next.token
             ~expected_lease_revision:(Allocation_lease.revision previous.lease)
             ~now_unix_ms:(Allocation_lease.last_unix_ms next.lease)
         in
         require
           (Path_reservation.equal reconstructed reservation)
           Conflict
           "Invalid path renewal"
       | [], [] | _ :: _, _ :: _ | [], _ :: _ :: _ | _ :: _ :: _, [] ->
         Json.fail Conflict "Path event must grant, renew or release one holder");
      { t with
        path_reservations =
          Map.set t.path_reservations ~key:reservation.target ~data:reservation
      }
    | Ticket_paths_put policy ->
      Ticket_paths.validate policy;
      let old = Map.find t.ticket_paths policy.ticket_id in
      let previous_revision =
        Option.value_map old ~default:0 ~f:(fun p -> p.Ticket_paths.revision)
      in
      require
        (previous_revision < Int.max_value)
        Conflict
        "Ticket paths revision exhausted";
      expected policy.revision (previous_revision + 1);
      { t with ticket_paths = Map.set t.ticket_paths ~key:policy.ticket_id ~data:policy }
    | External_condition_changed condition ->
      Option.iter change.actor_run ~f:(fun run ->
        owner (find t.runs run) change.actor (Some run));
      let conditions =
        match
          External_condition.apply
            t.conditions
            condition
            ~actor:change.actor
            ~run:change.actor_run
            ~timestamp:change.timestamp
            ~sequence:change.sequence
        with
        | Ok conditions -> conditions
        | Error e -> raise (Json.Decode_error e)
      in
      { t with conditions }
    | Ownership_recovered { recovery; after } ->
      ignore (Ownership_recovery.jsonaf_of_t recovery : Jsonaf.t);
      let request = recovery.request in
      require
        (not (Map.mem t.recoveries request.recovery_id))
        Conflict
        "Recovery ID already exists";
      require
        (Id.Actor.equal recovery.actor_id change.actor
         && Option.equal Id.Run.equal recovery.run_id change.actor_run
         && String.equal recovery.timestamp change.timestamp
         && Int.equal recovery.sequence change.sequence)
        Conflict
        "Recovery attribution differs";
      Option.iter recovery.run_id ~f:(fun run ->
        owner (find t.runs run) recovery.actor_id (Some run));
      require
        (Id.Actor.equal (find t.runs request.old_run_id).actor request.old_actor_id)
        Stale_claim
        "Recovery old run actor differs";
      let next =
        match request.target, after with
        | Ownership_recovery.Target.Named name, Change.Recovery_snapshot.Named reservation
          ->
          require
            (Reservation.Name.equal name reservation.name)
            Conflict
            "Recovery named target differs";
          let old = find t.reservations name in
          Ownership_recovery.Request.validate_holder
            request
            ~epoch:old.epoch
            ~holders:old.holders;
          require
            (Reservation.equal
               (Reservation.release old ~run:request.old_run_id ~token:request.token)
               reservation)
            Conflict
            "Recovery release snapshot differs";
          { t with reservations = Map.set t.reservations ~key:name ~data:reservation }
        | Path target, Path reservation ->
          require
            (Path_scope.equal target reservation.target)
            Conflict
            "Recovery path target differs";
          let old = find t.path_reservations target in
          Ownership_recovery.Request.validate_holder
            request
            ~epoch:old.epoch
            ~holders:old.holders;
          require
            (Path_reservation.equal
               (Path_reservation.release old ~run:request.old_run_id ~token:request.token)
               reservation)
            Conflict
            "Recovery path release snapshot differs";
          { t with
            path_reservations = Map.set t.path_reservations ~key:target ~data:reservation
          }
        | Named _, Path _ | Path _, Named _ ->
          Json.fail Conflict "Recovery snapshot target kind differs"
      in
      { next with
        recoveries = Map.set next.recoveries ~key:request.recovery_id ~data:recovery
      }
    | Actions_set { actions; evidence } ->
      nonempty evidence 65536;
      let removed =
        List.filter t.actions ~f:(fun a ->
          not (List.mem actions a ~equal:Runner_action.equal))
      in
      require
        (List.length removed = 1
         && List.length actions = List.length t.actions - 1
         && List.equal
              Runner_action.equal
              actions
              (List.filter t.actions ~f:(fun a ->
                 List.mem actions a ~equal:Runner_action.equal)))
        Conflict
        "Runner action acknowledgement must remove exactly one action";
      List.iter removed ~f:(fun action ->
        let child = find t.runs action.child in
        let parent = find t.runs action.parent in
        require
          (Id.Actor.equal change.actor child.actor
           || Id.Actor.equal change.actor parent.actor)
          Conflict
          "Runner action actor differs");
      { t with actions }
  in
  { next with revision = change.revision }
;;

let apply t change = Json.decode (fun () -> apply_exn t change)

let prepare t ?now_unix_ms command ~actor ~run ~timestamp ~sequence =
  Json.decode (fun () ->
    let emitted = ref [] in
    let domain_result = ref [] in
    let current = ref t in
    let emit update =
      let change =
        { Change.version = 1
        ; revision = !current.revision + 1
        ; actor
        ; actor_run = run
        ; timestamp
        ; sequence
        ; update
        }
      in
      current := apply_exn !current change;
      emitted := change :: !emitted
    in
    let run_record id revision =
      let r = find !current.runs id in
      expected r.Record.revision revision;
      r
    in
    let attempt_record id revision =
      let a = find !current.attempts id in
      expected a.Attempt.revision revision;
      a
    in
    (match command with
     | Command.Coordination command ->
       (match Agent_coordination_api.encode_command command with
        | Ok _ -> ()
        | Error e -> raise (Json.Decode_error e));
       (match command with
        | Agent_coordination_command.Paths_acquire { run = owner_run; requests } ->
          List.iter
            (List.sort requests ~compare:(fun a b ->
               Path_scope.compare a.Path_reservation.Request.target b.target))
            ~f:(fun request ->
              let old =
                Option.value
                  (Map.find !current.path_reservations request.target)
                  ~default:
                    { Path_reservation.target = request.target; epoch = 0; holders = [] }
              in
              let now =
                match now_unix_ms, request.lease_duration_ms with
                | Some now, _ -> now
                | None, None -> 0L
                | None, Some _ ->
                  Json.fail
                    Invalid_argument
                    "Timed path reservation requires server clock"
              in
              emit
                (Path_reservation_put
                   (Path_reservation.acquire
                      old
                      ~run:owner_run
                      ~actor
                      ~mode:request.mode
                      ~now_unix_ms:now
                      ~lease_duration_ms:request.lease_duration_ms)))
        | Path_renew { run = owner_run; target; token; expected_lease_revision } ->
          let now =
            match now_unix_ms with
            | Some now -> now
            | None -> Json.fail Invalid_argument "Path renewal requires server clock"
          in
          emit
            (Path_reservation_put
               (Path_reservation.renew
                  (find t.path_reservations target)
                  ~run:owner_run
                  ~token
                  ~expected_lease_revision
                  ~now_unix_ms:now))
        | Path_release { run = owner_run; target; token } ->
          emit
            (Path_reservation_put
               (Path_reservation.release
                  (find t.path_reservations target)
                  ~run:owner_run
                  ~token))
        | Ticket_paths_put
            { ticket_id; expected_revision; declarations; require_reservations } ->
          let actual =
            Option.value_map (Map.find t.ticket_paths ticket_id) ~default:0 ~f:(fun p ->
              p.Ticket_paths.revision)
          in
          expected actual expected_revision;
          require
            (actual < Int.max_value)
            Conflict
            "Ticket path policy revision exhausted";
          let declarations =
            match Ticket_paths.canonicalize declarations with
            | Ok d -> d
            | Error e -> raise (Json.Decode_error e)
          in
          emit
            (Ticket_paths_put
               { Ticket_paths.ticket_id
               ; revision = actual + 1
               ; declarations
               ; require_reservations
               })
        | Condition command ->
          let p =
            match
              External_condition.prepare
                t.conditions
                command
                ~actor
                ~run
                ~timestamp
                ~sequence
            with
            | Ok p -> p
            | Error e -> raise (Json.Decode_error e)
          in
          List.iter (External_condition.changes p) ~f:(fun c ->
            emit (External_condition_changed c));
          let field =
            match command with
            | External_condition.Command.Put _ -> "condition"
            | Signal _ -> "signal"
          in
          domain_result := [ field, External_condition.result p ]
        | Recover request ->
          let recovery =
            { Ownership_recovery.request
            ; actor_id = actor
            ; run_id = run
            ; timestamp
            ; sequence
            }
          in
          let after =
            match request.target with
            | Ownership_recovery.Target.Named name ->
              let old = find t.reservations name in
              Ownership_recovery.Request.validate_holder
                request
                ~epoch:old.epoch
                ~holders:old.holders;
              Change.Recovery_snapshot.Named
                (Reservation.release old ~run:request.old_run_id ~token:request.token)
            | Path target ->
              let old = find t.path_reservations target in
              Ownership_recovery.Request.validate_holder
                request
                ~epoch:old.epoch
                ~holders:old.holders;
              Change.Recovery_snapshot.Path
                (Path_reservation.release
                   old
                   ~run:request.old_run_id
                   ~token:request.token)
          in
          emit (Ownership_recovered { recovery; after });
          domain_result := [ "recovery", Ownership_recovery.jsonaf_of_t recovery ])
     | Command.Pool_put { name; expected_revision; limit } ->
       expected
         (Option.value_map (Map.find t.pools name) ~default:0 ~f:(fun p ->
            p.Allocation.Definition.revision))
         expected_revision;
       emit
         (Pool_put { Allocation.Definition.name; revision = expected_revision + 1; limit })
     | Ticket_policy_put { ticket; expected_revision; required_capabilities; pools } ->
       expected
         (Option.value_map (Map.find t.ticket_policies ticket) ~default:0 ~f:(fun p ->
            p.Allocation.Ticket_policy.revision))
         expected_revision;
       emit
         (Ticket_policy_put
            { Allocation.Ticket_policy.ticket
            ; revision = expected_revision + 1
            ; required_capabilities
            ; pools
            })
     | Command.Register
         { id
         ; parent
         ; parent_stop_policy
         ; objective
         ; capabilities
         ; process_ref
         ; worktree_ref
         } ->
       require (not (Map.mem t.runs id)) Conflict "Run is already registered";
       emit
         (Run_put
            { Record.id
            ; revision = 1
            ; parent
            ; parent_stop_policy
            ; objective
            ; actor
            ; capabilities
            ; sessions = []
            ; process_ref
            ; worktree_ref
            ; status = Running
            ; last_observed_unix_ms = None
            ; evidence = ""
            })
     | Transition { id; expected_revision; status; evidence } ->
       let r = run_record id expected_revision in
       owner r actor run;
       require (not (Status.equal r.status status)) Conflict "Run already has this status";
       emit (Run_put { r with revision = r.revision + 1; status; evidence })
     | Observe { id; expected_revision; observed_unix_ms } ->
       let r = run_record id expected_revision in
       owner r actor run;
       emit
         (Run_put
            { r with
              revision = r.revision + 1
            ; last_observed_unix_ms = Some observed_unix_ms
            })
     | Link_session { id; expected_revision; session } ->
       let r = run_record id expected_revision in
       owner r actor run;
       emit
         (Run_put
            { r with revision = r.revision + 1; sessions = r.sessions @ [ session ] })
     | Attempt_start { id; run = attempt_run; ticket; token; sessions } ->
       require (not (Map.mem t.attempts id)) Conflict "Attempt ID already exists";
       emit
         (Attempt_started
            { now_unix_ms = Option.value now_unix_ms ~default:0L
            ; attempt =
                { Attempt.id
                ; revision = 1
                ; run = attempt_run
                ; ticket
                ; token
                ; state = Running
                ; sessions
                ; checkpoints = []
                ; evidence = ""
                }
            })
     | Attempt_checkpoint { id; expected_revision; checkpoint } ->
       let a = attempt_record id expected_revision in
       emit
         (Attempt_put
            { a with
              revision = a.revision + 1
            ; checkpoints = a.checkpoints @ [ checkpoint ]
            })
     | Attempt_finish { id; expected_revision; state; evidence } ->
       let a = attempt_record id expected_revision in
       require
         (Attempt.State.terminal state)
         Invalid_argument
         "Attempt finish requires a terminal state";
       emit (Attempt_put { a with revision = a.revision + 1; state; evidence })
     | Reservation_acquire { run = owner_run; requests } ->
       require
         ((not (List.is_empty requests)) && List.length requests <= 32)
         Invalid_argument
         "Reservation batch must contain 1..32 names";
       require
         (not
            (List.contains_dup
               (List.map requests ~f:(fun r -> r.Reservation.name))
               ~compare:Reservation.Name.compare))
         Invalid_argument
         "Duplicate reservation name";
       List.iter
         (List.sort requests ~compare:(fun a b ->
            Reservation.Name.compare a.Reservation.name b.name))
         ~f:(fun request ->
           let old =
             Option.value
               (get_reservation !current request.name)
               ~default:{ Reservation.name = request.name; epoch = 0; holders = [] }
           in
           emit
             (Reservation_put
                (Reservation.acquire
                   old
                   ~run:owner_run
                   ~actor
                   ~mode:request.mode
                   ~now_unix_ms:
                     (match now_unix_ms, request.lease_duration_ms with
                      | Some now, _ -> now
                      | None, None -> 0L
                      | None, Some _ ->
                        Json.fail
                          Invalid_argument
                          "Timed reservation requires the server clock")
                   ~lease_duration_ms:request.lease_duration_ms)))
     | Reservation_renew { run = owner_run; name; token; expected_lease_revision } ->
       let now =
         match now_unix_ms with
         | Some n -> n
         | None ->
           Json.fail Invalid_argument "Reservation renewal requires the server clock"
       in
       emit
         (Reservation_put
            (Reservation.renew
               (find t.reservations name)
               ~run:owner_run
               ~token
               ~expected_lease_revision
               ~now_unix_ms:now))
     | Reservation_release { run = owner_run; name; token } ->
       emit
         (Reservation_put
            (Reservation.release (find t.reservations name) ~run:owner_run ~token))
     | Action_acknowledge { child; evidence } ->
       nonempty evidence 65536;
       require
         (List.exists t.actions ~f:(fun a -> Id.Run.equal a.Runner_action.child child))
         Not_found
         "Pending runner action not found";
       emit
         (Actions_set
            { actions =
                List.filter t.actions ~f:(fun a ->
                  not (Id.Run.equal a.Runner_action.child child))
            ; evidence
            }));
    let result =
      let entity revision = Json.obj [ "revision", Json.int revision ] in
      let coordination () =
        Json.obj ([ "coordination_revision", Json.int !current.revision ] @ !domain_result)
      in
      match command with
      | Register { id; _ }
      | Transition { id; _ }
      | Observe { id; _ }
      | Link_session { id; _ } -> entity (find !current.runs id).Record.revision
      | Pool_put { name; _ } ->
        entity (find !current.pools name).Allocation.Definition.revision
      | Ticket_policy_put { ticket; _ } ->
        entity (find !current.ticket_policies ticket).Allocation.Ticket_policy.revision
      | Attempt_start { id; _ } | Attempt_checkpoint { id; _ } | Attempt_finish { id; _ }
        ->
        Agent_run_api.Attempt_result.to_json
          (Agent_run_api.Attempt_result.of_attempt (find !current.attempts id))
      | Coordination (Ticket_paths_put { ticket_id; _ }) ->
        entity (find !current.ticket_paths ticket_id).Ticket_paths.revision
      | Coordination
          (Paths_acquire _ | Path_renew _ | Path_release _ | Condition _ | Recover _)
      | Reservation_acquire _
      | Reservation_renew _
      | Reservation_release _
      | Action_acknowledge _ -> coordination ()
    in
    { candidate = !current; changes = List.rev !emitted; result })
;;

let start_clock_required t ~ticket ~run =
  match run with
  | None -> []
  | Some run ->
    required_declarations t ticket
    |> List.filter_map ~f:(fun d ->
      let covering = owned_covering t d run in
      let indefinite =
        List.exists covering ~f:(fun (_, h) ->
          match Allocation_lease.policy h.lease with
          | Indefinite -> true
          | Duration_ms _ -> false)
      in
      let timed =
        List.exists covering ~f:(fun (_, h) ->
          match Allocation_lease.policy h.lease with
          | Indefinite -> false
          | Duration_ms _ -> true)
      in
      if timed && not indefinite then Some d.target else None)
;;

let prepare_start_reservations t ~ticket ~run ~actor ~timestamp ~sequence ~now_unix_ms =
  match start_blockers t ~ticket ~run:(Some run) ~now_unix_ms with
  | _ :: _ ->
    Error
      (Problem.create Blocked "Required paths or external conditions block ticket start")
  | [] ->
    let missing =
      required_declarations t ticket
      |> List.filter ~f:(fun d ->
        not (List.exists (owned_covering t d run) ~f:(fun (_, h) -> live h now_unix_ms)))
    in
    (* Acquisition batches stay within the public 32-target bound; one prepared
       value combines every batch, so the lifecycle commits all or none. *)
    let rec acquire current changes = function
      | [] ->
        Ok
          { candidate = current
          ; changes = List.rev changes
          ; result = Json.obj [ "coordination_revision", Json.int current.revision ]
          }
      | remaining ->
        let batch = List.take remaining 32 in
        let rest = List.drop remaining 32 in
        let requests =
          List.map batch ~f:(fun d ->
            { Path_reservation.Request.target = d.Ticket_paths.Declaration.target
            ; mode = d.mode
            ; lease_duration_ms = None
            })
        in
        Result.bind
          (prepare
             current
             ~now_unix_ms
             (Command.Coordination (Paths_acquire { run; requests }))
             ~actor
             ~run:(Some run)
             ~timestamp
             ~sequence)
          ~f:(fun p -> acquire p.candidate (List.rev_append p.changes changes) rest)
    in
    acquire t [] missing
;;

let get_path_reservation t target = Map.find t.path_reservations target
let get_ticket_paths t ticket = Map.find t.ticket_paths ticket
let path_reservations t = Map.data t.path_reservations
let ticket_paths t = Map.data t.ticket_paths
let external_conditions t = t.conditions
let get_recovery t id = Map.find t.recoveries id
let recoveries t = Map.data t.recoveries

let coordination_pins t =
  External_condition.pins t.conditions
  @ List.concat_map (recoveries t) ~f:(fun r -> r.Ownership_recovery.request.evidence)
;;

let event_references t =
  List.filter_map (coordination_pins t) ~f:(function
    | Evidence_event.Pin.Event ref_ -> Some ref_
    | Resource _ | Commit _ | Checksum _ | Comment _ | Contract _ | Decision _ -> None)
  |> List.dedup_and_sort ~compare:Session.Event_ref.compare
;;

let validate_coordination_references t ~ticket_exists ~pin_exists =
  Json.decode (fun () ->
    Map.iter t.ticket_paths ~f:(fun p ->
      require
        (ticket_exists p.Ticket_paths.ticket_id)
        Not_found
        "Ticket paths ticket missing");
    (match
       External_condition.validate_references t.conditions ~ticket_exists ~pin_exists
     with
     | Ok () -> ()
     | Error e -> raise (Json.Decode_error e));
    List.iter (coordination_pins t) ~f:(fun p ->
      require (pin_exists p) Not_found "Recovery or condition evidence missing"))
;;

let validate_references
      t
      ~ticket_exists
      ~session_exists
      ~resource_version_exists
      ~handoff_exists
  =
  Json.decode (fun () ->
    Map.iter t.ticket_policies ~f:(fun p ->
      require
        (ticket_exists p.Allocation.Ticket_policy.ticket)
        Not_found
        "Allocation policy ticket does not exist");
    Map.iter t.runs ~f:(fun r ->
      List.iter r.Record.sessions ~f:(fun id ->
        require (session_exists id) Not_found "Run session does not exist"));
    Map.iter t.attempts ~f:(fun a ->
      require (ticket_exists a.Attempt.ticket) Not_found "Attempt ticket does not exist";
      List.iter a.sessions ~f:(fun id ->
        require (session_exists id) Not_found "Attempt session does not exist");
      List.iter a.checkpoints ~f:(function
        | Attempt.Checkpoint.Resource { id; revision } ->
          require
            (resource_version_exists id ~revision)
            Not_found
            "Checkpoint resource version does not exist"
        | Handoff { ticket; revision } ->
          require
            (handoff_exists ticket ~revision)
            Not_found
            "Checkpoint handoff does not exist")))
;;

let validate_attempt_owner t id ~actor ~run ~ticket ~token =
  Json.decode (fun () ->
    let a = find t.attempts id in
    require
      (not (Attempt.State.terminal a.Attempt.state))
      Stale_claim
      "Attempt is terminal";
    require
      (Id.Run.equal a.run run
       && Id.Ticket.equal a.ticket ticket
       && Int.equal a.token token)
      Stale_claim
      "Attempt owner or fencing token differs";
    owner (find t.runs run) actor (Some run))
;;

let validate_reservation_owner t ?now_unix_ms name ~run ~token =
  Json.decode (fun () ->
    Reservation.validate_owner (find t.reservations name) ~now_unix_ms ~run ~token)
;;

module Liveness = struct
  type t =
    | Unobserved
    | Fresh
    | Stale
  [@@deriving sexp, equal]
end

let liveness r ~now_unix_ms ~after_ms =
  match r.Record.last_observed_unix_ms with
  | None -> Liveness.Unobserved
  | Some observed ->
    if
      Int64.(
        now_unix_ms < observed || after_ms < zero || now_unix_ms - observed >= after_ms)
    then Liveness.Stale
    else Liveness.Fresh
;;

let stale r ~now_unix_ms ~after_ms =
  Liveness.equal (liveness r ~now_unix_ms ~after_ms) Stale
;;

let to_json t =
  Json.obj
    [ "revision", Json.int t.revision
    ; "runs", `Array (List.map (Map.data t.runs) ~f:Record.jsonaf_of_t)
    ; "attempts", `Array (List.map (Map.data t.attempts) ~f:Attempt.jsonaf_of_t)
    ; ( "reservations"
      , `Array (List.map (Map.data t.reservations) ~f:Reservation.jsonaf_of_t) )
    ; ( "path_reservations"
      , `Array (List.map (path_reservations t) ~f:Path_reservation.jsonaf_of_t) )
    ; "ticket_paths", `Array (List.map (ticket_paths t) ~f:Ticket_paths.jsonaf_of_t)
    ; ( "conditions"
      , `Array
          (List.map
             (External_condition.declarations t.conditions)
             ~f:(Agent_coordination_api.condition_json t.conditions)) )
    ; "recoveries", `Array (List.map (recoveries t) ~f:Ownership_recovery.jsonaf_of_t)
    ; "pending_actions", `Array (List.map t.actions ~f:Runner_action.jsonaf_of_t)
    ]
;;

let session_references t =
  List.dedup_and_sort
    (List.concat_map (Map.data t.runs) ~f:(fun r -> r.Record.sessions)
     @ List.concat_map (Map.data t.attempts) ~f:(fun a -> a.Attempt.sessions))
    ~compare:Session_id.compare
;;

let mutation_methods = Agent_run_api.mutation_methods
let query_methods = Agent_run_api.query_methods
let decode = Agent_run_api.decode_command

let encode command =
  match Agent_run_api.encode_command command with
  | Ok wire -> wire
  | Error error -> raise (Json.Decode_error error)
;;

let coordination_query t ~method_ ~params =
  Result.bind (Agent_coordination_api.Query.decode ~method_ ~params) ~f:(fun query ->
    Json.decode (fun () ->
      let get max_bytes record =
        require
          (Api_response.encoded_size (Domain_record Runs) record <= max_bytes)
          Invalid_argument
          "Complete coordination record cannot fit; increase max_bytes";
        record
      in
      let page (bounds : Agent_coordination_api.Query.Page.t) values =
        let { Agent_coordination_api.Query.Page.limit
            ; max_bytes
            ; offset
            ; expected_revision
            }
          =
          bounds
        in
        if offset > 0 then expected t.revision (Option.value_exn expected_revision);
        let result items =
          let next = offset + List.length items in
          Json.obj
            [ "revision", Json.int t.revision
            ; "items", `Array items
            ; ("next_offset", if next < List.length values then Json.int next else `Null)
            ; "omitted", Json.int (Int.max 0 (List.length values - next))
            ]
        in
        let selected = List.take (List.drop values offset) limit in
        let rec fit reversed = function
          | [] -> List.rev reversed
          | item :: rest ->
            let candidate = List.rev (item :: reversed) in
            if
              Api_response.encoded_size (Domain_query Runs) (result candidate) > max_bytes
            then List.rev reversed
            else fit (item :: reversed) rest
        in
        let items = fit [] selected in
        require
          (List.is_empty selected || not (List.is_empty items))
          Invalid_argument
          "One complete coordination record cannot fit; increase max_bytes";
        let result = result items in
        require
          (Api_response.encoded_size (Domain_query Runs) result <= max_bytes)
          Invalid_argument
          "Coordination metadata cannot fit; increase max_bytes";
        result
      in
      let open Agent_coordination_api.Query in
      match query with
      | Path_get { target; max_bytes } ->
        get
          max_bytes
          (Agent_coordination_api.path_reservation_json (find t.path_reservations target))
      | Ticket_paths_get { ticket; max_bytes } ->
        get max_bytes (Ticket_paths.jsonaf_of_t (find t.ticket_paths ticket))
      | Condition_get { condition; max_bytes } ->
        let d =
          match External_condition.get t.conditions condition with
          | Some d -> d
          | None -> Json.fail Not_found "Condition does not exist"
        in
        get max_bytes (Agent_coordination_api.condition_json t.conditions d)
      | Recovery_get { recovery; max_bytes } ->
        get max_bytes (Ownership_recovery.jsonaf_of_t (find t.recoveries recovery))
      | Paths bounds ->
        page
          bounds
          (List.map (path_reservations t) ~f:Agent_coordination_api.path_reservation_json)
      | Ticket_paths bounds ->
        page bounds (List.map (ticket_paths t) ~f:Ticket_paths.jsonaf_of_t)
      | Conditions { page = bounds; ticket } ->
        page
          bounds
          (External_condition.declarations t.conditions
           |> List.filter ~f:(fun d ->
             Option.value_map
               ticket
               ~default:true
               ~f:(Id.Ticket.equal d.External_condition.Declaration.ticket_id))
           |> List.map ~f:(Agent_coordination_api.condition_json t.conditions))
      | Signals { page = bounds; condition } ->
        require
          (Option.is_some (External_condition.get t.conditions condition))
          Not_found
          "Condition does not exist";
        page
          bounds
          (List.map
             (External_condition.signals t.conditions ~condition)
             ~f:External_condition.Signal.jsonaf_of_t)
      | Recoveries bounds ->
        page bounds (List.map (recoveries t) ~f:Ownership_recovery.jsonaf_of_t)))
;;

let query t ~method_ ~params =
  if List.mem Agent_coordination_api.query_methods method_ ~equal:String.equal
  then coordination_query t ~method_ ~params
  else
    Result.bind (Agent_run_api.Query.decode ~method_ ~params) ~f:(fun query ->
      Json.decode (fun () ->
        let page (bounds : Agent_run_api.Query.Page.t) values =
          let { Agent_run_api.Query.Page.limit; max_bytes; offset; expected_revision } =
            bounds
          in
          if offset > 0 then expected t.revision (Option.value_exn expected_revision);
          let result items =
            let next = offset + List.length items in
            Json.obj
              [ "revision", Json.int t.revision
              ; "items", `Array items
              ; ("next_offset", if next < List.length values then Json.int next else `Null)
              ; "omitted", Json.int (Int.max 0 (List.length values - next))
              ]
          in
          let selected = List.take (List.drop values offset) limit in
          let rec fit reversed = function
            | [] -> List.rev reversed
            | item :: rest ->
              let candidate = List.rev (item :: reversed) in
              if
                Api_response.encoded_size (Domain_query Runs) (result candidate)
                > max_bytes
              then List.rev reversed
              else fit (item :: reversed) rest
          in
          let items = fit [] selected in
          if (not (List.is_empty selected)) && List.is_empty items
          then
            Json.fail
              Invalid_argument
              "one complete record cannot fit; increase max_bytes";
          let result = result items in
          if Api_response.encoded_size (Domain_query Runs) result > max_bytes
          then Json.fail Invalid_argument "query metadata cannot fit; increase max_bytes";
          result
        in
        let open Agent_run_api.Query in
        let get max_bytes record =
          if Api_response.encoded_size (Domain_record Runs) record > max_bytes
          then Json.fail Invalid_argument "complete record cannot fit; increase max_bytes";
          record
        in
        match query with
        | Run_get { id; max_bytes } ->
          get max_bytes (Agent_run_api.run_json (find t.runs id))
        | Attempt_get { id; max_bytes } ->
          get max_bytes (Agent_run_api.attempt_json (find t.attempts id))
        | Reservation_get { id; max_bytes } ->
          get max_bytes (Agent_run_api.reservation_json (find t.reservations id))
        | Pools bounds ->
          page bounds (List.map (Map.data t.pools) ~f:Agent_run_api.pool_json)
        | Ticket_policies bounds ->
          page
            bounds
            (List.map (Map.data t.ticket_policies) ~f:Agent_run_api.ticket_policy_json)
        | Runs bounds ->
          page bounds (List.map (Map.data t.runs) ~f:Agent_run_api.run_json)
        | Reservations bounds ->
          page
            bounds
            (List.map (Map.data t.reservations) ~f:Agent_run_api.reservation_json)
        | Actions bounds -> page bounds (List.map t.actions ~f:Agent_run_api.action_json)
        | Attempts { page = bounds; ticket; run } ->
          page
            bounds
            (List.filter_map (Map.data t.attempts) ~f:(fun attempt ->
               if
                 Option.value_map
                   ticket
                   ~default:true
                   ~f:(Id.Ticket.equal attempt.Attempt.ticket)
                 && Option.value_map run ~default:true ~f:(Id.Run.equal attempt.run)
               then Some (Agent_run_api.attempt_json attempt)
               else None))))
;;

let get_ticket_policy t ticket = Map.find t.ticket_policies ticket

let allocation_candidate t ~ticket ~priority ~creation_sequence ~ready ~available =
  let policy = get_ticket_policy t ticket in
  let required_capabilities =
    Option.value_map policy ~default:[] ~f:(fun p ->
      p.Allocation.Ticket_policy.required_capabilities)
  in
  let names =
    Option.value_map policy ~default:[] ~f:(fun p -> p.Allocation.Ticket_policy.pools)
  in
  let pools =
    List.map names ~f:(fun name ->
      let definition = find t.pools name in
      let active =
        Map.count t.attempts ~f:(fun attempt ->
          (not (Attempt.State.terminal attempt.Attempt.state))
          && Option.value_map
               (get_ticket_policy t attempt.ticket)
               ~default:false
               ~f:(fun p -> List.mem p.pools name ~equal:String.equal))
      in
      { Allocation.Pool.name; limit = definition.limit; active })
  in
  { Allocation.Candidate.ticket
  ; priority
  ; creation_sequence
  ; ready
  ; available
  ; required_capabilities
  ; pools
  }
;;

let attempts_for_run t run =
  List.filter (Map.data t.attempts) ~f:(fun a -> Id.Run.equal a.Attempt.run run)
;;

let runs t = Map.data t.runs
let attempts t = Map.data t.attempts
let reservations t = Map.data t.reservations
let pools t = Map.data t.pools
let ticket_policies t = Map.data t.ticket_policies

let latest_attempt_for_ticket t ~ticket ~token =
  Map.data t.attempts
  |> List.filter ~f:(fun a ->
    Id.Ticket.equal a.Attempt.ticket ticket && Int.equal a.token token)
  |> List.max_elt ~compare:(fun a b ->
    Int.compare
      (Map.find_exn t.attempt_started a.Attempt.id)
      (Map.find_exn t.attempt_started b.Attempt.id))
;;

let cancel_recovered_attempts t (request : Ticket_lifecycle.Recovery.t) =
  Json.decode (fun () ->
    ignore
      (Coordination_wire.encode_exn Ticket_lifecycle.Recovery.codec request : Jsonaf.t);
    List.fold (attempts_for_ticket t request.ticket_id) ~init:t ~f:(fun current attempt ->
      if Attempt.State.terminal attempt.state
      then current
      else (
        require
          (Int.equal attempt.token request.token
           && Option.value_map
                request.old_run_id
                ~default:false
                ~f:(Id.Run.equal attempt.run))
          Stale_claim
          "Recovery attempt ownership differs";
        require
          (Id.Actor.equal (find current.runs attempt.run).actor request.old_actor_id)
          Stale_claim
          "Recovery attempt actor differs";
        require
          (current.revision < Int.max_value && attempt.revision < Int.max_value)
          Conflict
          "Recovery coordination counter exhausted";
        let cancelled =
          { attempt with
            revision = attempt.revision + 1
          ; state = Cancelled
          ; evidence = request.reason
          }
        in
        Attempt.validate_transition ~previous:(Some attempt) cancelled;
        { current with
          revision = current.revision + 1
        ; attempts = Map.set current.attempts ~key:attempt.id ~data:cancelled
        })))
;;
