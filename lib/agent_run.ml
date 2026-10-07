open Core
module Status = Agent_run_event.Status
module Parent_stop_policy = Agent_run_event.Parent_stop_policy
module Runner_action = Agent_run_event.Runner_action
module Record = Agent_run_event.Record
module Change = Agent_run_event

module Command = struct
  type t =
    | Pool_put of
        { name : string
        ; expected_revision : int
        ; limit : int
        }
    | Ticket_policy_put of
        { ticket : Id.Ticket.t
        ; expected_revision : int
        ; required_capabilities : string list
        ; pools : string list
        }
    | Register of
        { id : Id.Run.t
        ; parent : Id.Run.t option
        ; parent_stop_policy : Parent_stop_policy.t
        ; objective : string
        ; capabilities : string list
        ; process_ref : string option
        ; worktree_ref : string option
        }
    | Transition of
        { id : Id.Run.t
        ; expected_revision : int
        ; status : Status.t
        ; evidence : string
        }
    | Observe of
        { id : Id.Run.t
        ; expected_revision : int
        ; observed_unix_ms : int64
        }
    | Link_session of
        { id : Id.Run.t
        ; expected_revision : int
        ; session : Session_id.t
        }
    | Attempt_start of
        { id : Attempt.Id.t
        ; run : Id.Run.t
        ; ticket : Id.Ticket.t
        ; token : int
        ; sessions : Session_id.t list
        }
    | Attempt_checkpoint of
        { id : Attempt.Id.t
        ; expected_revision : int
        ; checkpoint : Attempt.Checkpoint.t
        }
    | Attempt_finish of
        { id : Attempt.Id.t
        ; expected_revision : int
        ; state : Attempt.State.t
        ; evidence : string
        }
    | Reservation_acquire of
        { run : Id.Run.t
        ; requests : Reservation.request list
        }
    | Reservation_renew of
        { run : Id.Run.t
        ; name : Reservation.Name.t
        ; token : int
        ; expected_lease_revision : int
        }
    | Reservation_release of
        { run : Id.Run.t
        ; name : Reservation.Name.t
        ; token : int
        }
    | Action_acknowledge of
        { child : Id.Run.t
        ; evidence : string
        }
  [@@deriving sexp]
end

module Update = Change.Update

type t =
  { revision : int
  ; runs : Record.t Id.Run.Map.t
  ; attempts : Attempt.t Attempt.Id.Map.t
  ; reservations : Reservation.t Reservation.Name.Map.t
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
  ; reservations = Reservation.Name.Map.empty
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
  require (Int.equal actual revision) Conflict "Run coordination revision conflict"
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

let apply_exn t (change : Change.t) =
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
    | Attempt_put attempt ->
      let record = find t.runs attempt.run in
      let previous = Map.find t.attempts attempt.id in
      Attempt.validate_transition ~previous attempt;
      (match previous with
       | None ->
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
      { t with attempts = Map.set t.attempts ~key:attempt.id ~data:attempt }
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
         (Attempt_put
            { Attempt.id
            ; revision = 1
            ; run = attempt_run
            ; ticket
            ; token
            ; state = Running
            ; sessions
            ; checkpoints = []
            ; evidence = ""
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
    { candidate = !current
    ; changes = List.rev !emitted
    ; result = Json.obj [ "revision", Json.int !current.revision ]
    })
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

let stale r ~now_unix_ms ~after_ms =
  match r.Record.last_observed_unix_ms with
  | None -> true
  | Some observed ->
    Int64.(
      now_unix_ms < observed || after_ms < zero || now_unix_ms - observed >= after_ms)
;;

let to_json t =
  Json.obj
    [ "revision", Json.int t.revision
    ; "runs", `Array (List.map (Map.data t.runs) ~f:Record.jsonaf_of_t)
    ; "attempts", `Array (List.map (Map.data t.attempts) ~f:Attempt.jsonaf_of_t)
    ; ( "reservations"
      , `Array (List.map (Map.data t.reservations) ~f:Reservation.jsonaf_of_t) )
    ; "pending_actions", `Array (List.map t.actions ~f:Runner_action.jsonaf_of_t)
    ]
;;

let session_references t =
  List.dedup_and_sort
    (List.concat_map (Map.data t.runs) ~f:(fun r -> r.Record.sessions)
     @ List.concat_map (Map.data t.attempts) ~f:(fun a -> a.Attempt.sessions))
    ~compare:Session_id.compare
;;

let mutation_methods =
  [ "allocation.pool_put"
  ; "allocation.ticket_policy_put"
  ; "run.register"
  ; "run.transition"
  ; "run.observe"
  ; "run.link_session"
  ; "attempt.start"
  ; "attempt.checkpoint"
  ; "attempt.finish"
  ; "reservation.acquire"
  ; "reservation.renew"
  ; "reservation.release"
  ; "run.action_acknowledge"
  ]
;;

let query_methods =
  [ "allocation.pools"
  ; "allocation.ticket_policies"
  ; "run.get"
  ; "run.list"
  ; "attempt.get"
  ; "attempt.list"
  ; "reservation.get"
  ; "reservation.list"
  ; "run.actions"
  ]
;;

let encode = function
  | Command.Pool_put { name; expected_revision; limit } ->
    ( "allocation.pool_put"
    , Json.obj
        [ "name", Json.string name
        ; "expected_revision", Json.int expected_revision
        ; "limit", Json.int limit
        ] )
  | Ticket_policy_put { ticket; expected_revision; required_capabilities; pools } ->
    ( "allocation.ticket_policy_put"
    , Json.obj
        [ "ticket", Id.Ticket.jsonaf_of_t ticket
        ; "expected_revision", Json.int expected_revision
        ; "required_capabilities", `Array (List.map required_capabilities ~f:Json.string)
        ; "pools", `Array (List.map pools ~f:Json.string)
        ] )
  | Command.Register
      { id
      ; parent
      ; parent_stop_policy
      ; objective
      ; capabilities
      ; process_ref
      ; worktree_ref
      } ->
    ( "run.register"
    , Json.obj
        ([ "id", Id.Run.jsonaf_of_t id
         ; "parent_stop_policy", Parent_stop_policy.jsonaf_of_t parent_stop_policy
         ; "objective", Json.string objective
         ; "capabilities", `Array (List.map capabilities ~f:Json.string)
         ]
         @ Option.to_list
             (Option.map parent ~f:(fun id -> "parent", Id.Run.jsonaf_of_t id))
         @ Option.to_list
             (Option.map process_ref ~f:(fun s -> "process_ref", Json.string s))
         @ Option.to_list
             (Option.map worktree_ref ~f:(fun s -> "worktree_ref", Json.string s))) )
  | Transition { id; expected_revision; status; evidence } ->
    ( "run.transition"
    , Json.obj
        [ "id", Id.Run.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "status", Status.jsonaf_of_t status
        ; "evidence", Json.string evidence
        ] )
  | Observe { id; expected_revision; observed_unix_ms } ->
    ( "run.observe"
    , Json.obj
        [ "id", Id.Run.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "observed_unix_ms", Json.int64 observed_unix_ms
        ] )
  | Link_session { id; expected_revision; session } ->
    ( "run.link_session"
    , Json.obj
        [ "id", Id.Run.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "session", Session_id.jsonaf_of_t session
        ] )
  | Attempt_start { id; run; ticket; token; sessions } ->
    ( "attempt.start"
    , Json.obj
        [ "id", Attempt.Id.jsonaf_of_t id
        ; "run", Id.Run.jsonaf_of_t run
        ; "ticket", Id.Ticket.jsonaf_of_t ticket
        ; "token", Json.int token
        ; "sessions", `Array (List.map sessions ~f:Session_id.jsonaf_of_t)
        ] )
  | Attempt_checkpoint { id; expected_revision; checkpoint } ->
    ( "attempt.checkpoint"
    , Json.obj
        [ "id", Attempt.Id.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "checkpoint", Attempt.Checkpoint.jsonaf_of_t checkpoint
        ] )
  | Attempt_finish { id; expected_revision; state; evidence } ->
    ( "attempt.finish"
    , Json.obj
        [ "id", Attempt.Id.jsonaf_of_t id
        ; "expected_revision", Json.int expected_revision
        ; "state", Attempt.State.jsonaf_of_t state
        ; "evidence", Json.string evidence
        ] )
  | Reservation_acquire { run; requests } ->
    ( "reservation.acquire"
    , Json.obj
        [ "run", Id.Run.jsonaf_of_t run
        ; ( "requests"
          , `Array
              (List.map requests ~f:(fun request ->
                 Json.obj
                   [ "name", Reservation.Name.jsonaf_of_t request.Reservation.name
                   ; "mode", Reservation.Mode.jsonaf_of_t request.mode
                   ; ( "lease_duration_ms"
                     , Option.value_map
                         request.lease_duration_ms
                         ~default:`Null
                         ~f:Json.int64 )
                   ])) )
        ] )
  | Reservation_renew { run; name; token; expected_lease_revision } ->
    ( "reservation.renew"
    , Json.obj
        [ "run", Id.Run.jsonaf_of_t run
        ; "name", Reservation.Name.jsonaf_of_t name
        ; "token", Json.int token
        ; "expected_lease_revision", Json.int expected_lease_revision
        ] )
  | Reservation_release { run; name; token } ->
    ( "reservation.release"
    , Json.obj
        [ "run", Id.Run.jsonaf_of_t run
        ; "name", Reservation.Name.jsonaf_of_t name
        ; "token", Json.int token
        ] )
  | Action_acknowledge { child; evidence } ->
    ( "run.action_acknowledge"
    , Json.obj [ "child", Id.Run.jsonaf_of_t child; "evidence", Json.string evidence ] )
;;

let status_decode json =
  match Json.list json with
  | [ `String "Running" ] -> Status.Running
  | [ `String "Waiting" ] -> Waiting
  | [ `String "Completed" ] -> Completed
  | [ `String "Failed" ] -> Failed
  | [ `String "Cancelled" ] -> Cancelled
  | [] | _ :: _ -> Json.fail Invalid_argument "Unknown run status"
;;

let policy_decode json =
  match Json.list json with
  | [ `String "Continue" ] -> Parent_stop_policy.Continue
  | [ `String "Request_cancel" ] -> Request_cancel
  | [ `String "Request_wait" ] -> Request_wait
  | [] | _ :: _ -> Json.fail Invalid_argument "Unknown parent-stop policy"
;;

let mode_decode json =
  match Json.list json with
  | [ `String "Exclusive" ] -> Reservation.Mode.Exclusive
  | [ `String "Shared" ] -> Shared
  | [] | _ :: _ -> Json.fail Invalid_argument "Unknown reservation mode"
;;

let attempt_state_decode json =
  match status_decode json with
  | Running -> Attempt.State.Running
  | Waiting -> Waiting
  | Completed -> Completed
  | Failed -> Failed
  | Cancelled -> Cancelled
;;

let checkpoint_decode json =
  match Json.list json with
  | [ `String "Resource"; payload ] ->
    Json.fields payload ~allowed:[ "id"; "revision" ];
    Attempt.Checkpoint.Resource
      { id = Id.Resource.t_of_jsonaf (Json.field payload "id")
      ; revision = Json.integer (Json.field payload "revision")
      }
  | [ `String "Handoff"; payload ] ->
    Json.fields payload ~allowed:[ "ticket"; "revision" ];
    Handoff
      { ticket = Id.Ticket.t_of_jsonaf (Json.field payload "ticket")
      ; revision = Json.integer (Json.field payload "revision")
      }
  | [] | _ :: _ -> Json.fail Invalid_argument "Invalid checkpoint"
;;

let decode ~method_ ~params =
  Json.decode (fun () ->
    let field key = Json.field params key in
    let id () = Id.Run.t_of_jsonaf (field "id") in
    let aid () = Attempt.Id.t_of_jsonaf (field "id") in
    let rev () = Json.integer (field "expected_revision") in
    let text key = Json.bounded_text (field key) ~max_bytes:65536 in
    let optional key f = Option.map (Json.optional params key) ~f in
    let sessions () =
      Option.value_map (Json.optional params "sessions") ~default:[] ~f:(fun json ->
        List.map (Json.list json) ~f:Session_id.t_of_jsonaf)
    in
    match method_ with
    | "allocation.pool_put" ->
      Json.fields params ~allowed:[ "name"; "expected_revision"; "limit" ];
      Command.Pool_put
        { name = text "name"
        ; expected_revision = rev ()
        ; limit = Json.integer (field "limit")
        }
    | "allocation.ticket_policy_put" ->
      Json.fields
        params
        ~allowed:[ "ticket"; "expected_revision"; "required_capabilities"; "pools" ];
      Ticket_policy_put
        { ticket = Id.Ticket.t_of_jsonaf (field "ticket")
        ; expected_revision = rev ()
        ; required_capabilities =
            List.map (Json.list (field "required_capabilities")) ~f:Json.text
        ; pools = List.map (Json.list (field "pools")) ~f:Json.text
        }
    | "run.register" ->
      Json.fields
        params
        ~allowed:
          [ "id"
          ; "parent"
          ; "parent_stop_policy"
          ; "objective"
          ; "capabilities"
          ; "process_ref"
          ; "worktree_ref"
          ];
      Command.Register
        { id = id ()
        ; parent = optional "parent" Id.Run.t_of_jsonaf
        ; parent_stop_policy =
            Option.value_map
              (Json.optional params "parent_stop_policy")
              ~default:Parent_stop_policy.Continue
              ~f:policy_decode
        ; objective = text "objective"
        ; capabilities =
            Option.value_map
              (Json.optional params "capabilities")
              ~default:[]
              ~f:(fun j -> List.map (Json.list j) ~f:Json.text)
        ; process_ref = optional "process_ref" Json.text
        ; worktree_ref = optional "worktree_ref" Json.text
        }
    | "run.transition" ->
      Json.fields params ~allowed:[ "id"; "expected_revision"; "status"; "evidence" ];
      Transition
        { id = id ()
        ; expected_revision = rev ()
        ; status = status_decode (field "status")
        ; evidence = text "evidence"
        }
    | "run.observe" ->
      Json.fields params ~allowed:[ "id"; "expected_revision"; "observed_unix_ms" ];
      Observe
        { id = id ()
        ; expected_revision = rev ()
        ; observed_unix_ms = Json.integer64 (field "observed_unix_ms")
        }
    | "run.link_session" ->
      Json.fields params ~allowed:[ "id"; "expected_revision"; "session" ];
      Link_session
        { id = id ()
        ; expected_revision = rev ()
        ; session = Session_id.t_of_jsonaf (field "session")
        }
    | "attempt.start" ->
      Json.fields params ~allowed:[ "id"; "run"; "ticket"; "token"; "sessions" ];
      Attempt_start
        { id = aid ()
        ; run = Id.Run.t_of_jsonaf (field "run")
        ; ticket = Id.Ticket.t_of_jsonaf (field "ticket")
        ; token = Json.integer (field "token")
        ; sessions = sessions ()
        }
    | "attempt.checkpoint" ->
      Json.fields params ~allowed:[ "id"; "expected_revision"; "checkpoint" ];
      Attempt_checkpoint
        { id = aid ()
        ; expected_revision = rev ()
        ; checkpoint = checkpoint_decode (field "checkpoint")
        }
    | "attempt.finish" ->
      Json.fields params ~allowed:[ "id"; "expected_revision"; "state"; "evidence" ];
      Attempt_finish
        { id = aid ()
        ; expected_revision = rev ()
        ; state = attempt_state_decode (field "state")
        ; evidence = text "evidence"
        }
    | "reservation.acquire" ->
      Json.fields params ~allowed:[ "run"; "requests" ];
      Reservation_acquire
        { run = Id.Run.t_of_jsonaf (field "run")
        ; requests =
            List.map
              (Json.list (field "requests"))
              ~f:(fun request ->
                Json.fields request ~allowed:[ "name"; "mode"; "lease_duration_ms" ];
                { Reservation.name =
                    Reservation.Name.t_of_jsonaf (Json.field request "name")
                ; mode = mode_decode (Json.field request "mode")
                ; lease_duration_ms =
                    (match Json.optional request "lease_duration_ms" with
                     | None | Some `Null -> None
                     | Some j -> Some (Json.integer64 j))
                })
        }
    | "reservation.renew" ->
      Json.fields params ~allowed:[ "run"; "name"; "token"; "expected_lease_revision" ];
      Reservation_renew
        { run = Id.Run.t_of_jsonaf (field "run")
        ; name = Reservation.Name.t_of_jsonaf (field "name")
        ; token = Json.integer (field "token")
        ; expected_lease_revision = Json.integer (field "expected_lease_revision")
        }
    | "reservation.release" ->
      Json.fields params ~allowed:[ "run"; "name"; "token" ];
      Reservation_release
        { run = Id.Run.t_of_jsonaf (field "run")
        ; name = Reservation.Name.t_of_jsonaf (field "name")
        ; token = Json.integer (field "token")
        }
    | "run.action_acknowledge" ->
      Json.fields params ~allowed:[ "child"; "evidence" ];
      Action_acknowledge
        { child = Id.Run.t_of_jsonaf (field "child"); evidence = text "evidence" }
    | _ -> Json.fail Invalid_argument "Unknown run mutation method")
;;

let query t ~method_ ~params =
  Json.decode (fun () ->
    let get key = Json.field params key in
    let page values =
      let limit =
        Option.value_map (Json.optional params "limit") ~default:50 ~f:Json.integer
      in
      let max_bytes =
        Option.value_map (Json.optional params "max_bytes") ~default:65536 ~f:Json.integer
      in
      let offset =
        Option.value_map (Json.optional params "offset") ~default:0 ~f:Json.integer
      in
      require
        (limit > 0 && limit <= 100 && max_bytes >= 4096 && max_bytes <= 1048576)
        Invalid_argument
        "Run query bounds are invalid";
      if offset > 0 then expected t.revision (Json.integer (get "expected_revision"));
      let selected = List.take (List.drop values offset) limit in
      let rec fit reversed = function
        | [] -> List.rev reversed
        | x :: rest ->
          if
            String.length (Json.canonical (`Array (List.rev (x :: reversed)))) + 512
            > max_bytes
          then List.rev reversed
          else fit (x :: reversed) rest
      in
      let items = fit [] selected in
      let next = offset + List.length items in
      Json.obj
        [ "revision", Json.int t.revision
        ; "items", `Array items
        ; ("next_offset", if next < List.length values then Json.int next else `Null)
        ; "omitted", Json.int (Int.max 0 (List.length values - next))
        ]
    in
    match method_ with
    | "allocation.pools" ->
      Json.fields params ~allowed:[ "limit"; "max_bytes"; "offset"; "expected_revision" ];
      page (List.map (Map.data t.pools) ~f:Allocation.Definition.jsonaf_of_t)
    | "allocation.ticket_policies" ->
      Json.fields params ~allowed:[ "limit"; "max_bytes"; "offset"; "expected_revision" ];
      page (List.map (Map.data t.ticket_policies) ~f:Allocation.Ticket_policy.jsonaf_of_t)
    | "run.get" ->
      Json.fields params ~allowed:[ "id" ];
      Record.jsonaf_of_t (find t.runs (Id.Run.t_of_jsonaf (get "id")))
    | "attempt.get" ->
      Json.fields params ~allowed:[ "id" ];
      Attempt.jsonaf_of_t (find t.attempts (Attempt.Id.t_of_jsonaf (get "id")))
    | "reservation.get" ->
      Json.fields params ~allowed:[ "name" ];
      Reservation.jsonaf_of_t
        (find t.reservations (Reservation.Name.t_of_jsonaf (get "name")))
    | "run.list" ->
      Json.fields params ~allowed:[ "limit"; "max_bytes"; "offset"; "expected_revision" ];
      page (List.map (Map.data t.runs) ~f:Record.jsonaf_of_t)
    | "attempt.list" ->
      Json.fields
        params
        ~allowed:[ "ticket"; "run"; "limit"; "max_bytes"; "offset"; "expected_revision" ];
      let ticket = Option.map (Json.optional params "ticket") ~f:Id.Ticket.t_of_jsonaf in
      let run = Option.map (Json.optional params "run") ~f:Id.Run.t_of_jsonaf in
      page
        (List.filter_map (Map.data t.attempts) ~f:(fun a ->
           if
             Option.value_map ticket ~default:true ~f:(Id.Ticket.equal a.Attempt.ticket)
             && Option.value_map run ~default:true ~f:(Id.Run.equal a.run)
           then Some (Attempt.jsonaf_of_t a)
           else None))
    | "reservation.list" ->
      Json.fields params ~allowed:[ "limit"; "max_bytes"; "offset"; "expected_revision" ];
      page (List.map (Map.data t.reservations) ~f:Reservation.jsonaf_of_t)
    | "run.actions" ->
      Json.fields params ~allowed:[ "limit"; "max_bytes"; "offset"; "expected_revision" ];
      page (List.map t.actions ~f:Runner_action.jsonaf_of_t)
    | _ -> Json.fail Invalid_argument "Unknown run query method")
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
