open Core
open Workgraph

let ok = function
  | Ok x -> x
  | Error e -> failwith e.Problem.message
;;

let actor = ok (Id.Actor.of_string "actor")
let run_id s = ok (Id.Run.of_string s)
let attempt_id s = ok (Attempt.Id.of_string s)
let ticket_id s = ok (Id.Ticket.of_string s)
let reservation_name s = ok (Reservation.Name.of_string s)

let prepare t command =
  Agent_run.prepare t command ~actor ~run:None ~timestamp:"2026-10-07" ~sequence:1
;;

let apply t command = Agent_run.candidate (ok (prepare t command))

let register ?parent ?(policy = Agent_run.Parent_stop_policy.Continue) id =
  Agent_run.Command.Register
    { id = run_id id
    ; parent
    ; parent_stop_policy = policy
    ; objective = "Implement task"
    ; capabilities = [ "ocaml" ]
    ; process_ref = Some "pid:123"
    ; worktree_ref = None
    }
;;

let report = function
  | Ok _ -> print_endline "ok"
  | Error e -> print_s [%sexp (e.Problem.kind : Problem.kind)]
;;

let start id ticket =
  Agent_run.Command.Attempt_start
    { id = attempt_id id
    ; run = run_id "worker"
    ; ticket = ticket_id ticket
    ; token = 1
    ; sessions = []
    }
;;

let%expect_test "resolved replay and strict command/event codecs" =
  let command = register "worker" in
  let method_, params = Agent_run.encode command in
  let decoded = ok (Agent_run.decode ~method_ ~params) in
  print_s
    [%sexp
      (Sexp.equal
         (Agent_run.Command.sexp_of_t command)
         (Agent_run.Command.sexp_of_t decoded)
       : bool)];
  let prepared = ok (prepare Agent_run.empty command) in
  let events = Agent_run.changes prepared in
  let restored =
    List.fold events ~init:Agent_run.empty ~f:(fun t event ->
      let encoded = Agent_run.Change.jsonaf_of_t event in
      print_endline (Json.text (Json.field encoded "revision"));
      let decoded = Agent_run.Change.t_of_jsonaf encoded in
      ok (Agent_run.apply t decoded))
  in
  print_s
    [%sexp
      (String.equal
         (Json.canonical (Agent_run.to_json restored))
         (Json.canonical (Agent_run.to_json (Agent_run.candidate prepared)))
       : bool)];
  report
    (Agent_run.decode
       ~method_:"run.register"
       ~params:
         (Json.obj
            [ "id", Json.string "worker"; "objective", Json.string "x"; "unknown", `Null ]));
  let event = List.hd_exn events in
  report
    (Json.decode (fun () ->
       Agent_run.Change.t_of_jsonaf
         (Json.obj
            (("unknown", `Null)
             ::
             (match Agent_run.Change.jsonaf_of_t event with
              | `Object fields -> fields
              | _ -> [])))));
  report (Agent_run.apply restored event);
  [%expect
    {|
    true
    1
    true
    Invalid_argument
    Invalid_argument
    Conflict
    |}]
;;

let%expect_test "attempt history preserves failed evidence and exact checkpoints" =
  let t = apply Agent_run.empty (register "worker") in
  let t = apply t (start "first" "ticket") in
  let resource = ok (Id.Resource.of_string "proof") in
  let checkpoint = Attempt.Checkpoint.Resource { id = resource; revision = 3 } in
  let method_, params =
    Agent_run.encode
      (Agent_run.Command.Attempt_checkpoint
         { id = attempt_id "first"; expected_revision = 1; checkpoint })
  in
  let t = apply t (ok (Agent_run.decode ~method_ ~params)) in
  let t =
    apply
      t
      (Attempt_finish
         { id = attempt_id "first"
         ; expected_revision = 2
         ; state = Failed
         ; evidence = "compiler error"
         })
  in
  report
    (prepare
       t
       (Attempt_checkpoint { id = attempt_id "first"; expected_revision = 3; checkpoint }));
  let t = apply t (start "replacement" "ticket") in
  let t = apply t (start "second-ticket" "other") in
  print_s
    [%sexp (List.length (Agent_run.attempts_for_ticket t (ticket_id "ticket")) : int)];
  print_s
    [%sexp
      ((Option.value_exn (Agent_run.get_attempt t (attempt_id "first"))).evidence
       : string)];
  report
    (prepare
       t
       (Transition
          { id = run_id "worker"
          ; expected_revision = 1
          ; status = Completed
          ; evidence = "done"
          }));
  report
    (Agent_run.validate_references
       t
       ~ticket_exists:(Fn.const true)
       ~session_exists:(Fn.const true)
       ~resource_version_exists:(fun _ ~revision -> revision = 3)
       ~handoff_exists:(fun _ ~revision:_ -> false));
  report
    (Agent_run.validate_references
       t
       ~ticket_exists:(Fn.const true)
       ~session_exists:(Fn.const true)
       ~resource_version_exists:(fun _ ~revision:_ -> false)
       ~handoff_exists:(fun _ ~revision:_ -> false));
  report
    (Agent_run.validate_attempt_owner
       t
       (attempt_id "replacement")
       ~actor
       ~run:(run_id "worker")
       ~ticket:(ticket_id "ticket")
       ~token:2);
  [%expect
    {|
    Conflict
    2
    "compiler error"
    Conflict
    ok
    Not_found
    Stale_claim
    |}]
;;

let%expect_test
    "parent cancellation requests runner action without inventing process state"
  =
  let t = apply Agent_run.empty (register "parent") in
  let t = apply t (register "child" ~parent:(run_id "parent") ~policy:Request_cancel) in
  let t =
    apply
      t
      (Transition
         { id = run_id "parent"
         ; expected_revision = 1
         ; status = Cancelled
         ; evidence = "user cancelled"
         })
  in
  print_s [%sexp (Agent_run.pending_actions t : Agent_run.Runner_action.t list)];
  print_s
    [%sexp
      ((Option.value_exn (Agent_run.get_run t (run_id "child"))).status
       : Agent_run.Status.t)];
  let p =
    ok
      (prepare
         t
         (Action_acknowledge
            { child = run_id "child"; evidence = "runner accepted cancellation request" }))
  in
  let replayed =
    List.fold (Agent_run.changes p) ~init:t ~f:(fun t event ->
      ok
        (Agent_run.apply
           t
           (Agent_run.Change.t_of_jsonaf (Agent_run.Change.jsonaf_of_t event))))
  in
  print_s [%sexp (List.length (Agent_run.pending_actions replayed) : int)];
  report
    (prepare
       replayed
       (Observe { id = run_id "parent"; expected_revision = 2; observed_unix_ms = 1L }));
  [%expect
    {|
    (((parent parent) (child child) (policy Request_cancel)))
    Running
    0
    Conflict
    |}]
;;

let%expect_test "reservation batches are atomic and fencing survives release" =
  let t = apply Agent_run.empty (register "worker") in
  let t = apply t (register "other") in
  let acquire run names =
    Agent_run.Command.Reservation_acquire
      { run = run_id run
      ; requests =
          List.map names ~f:(fun name ->
            { Reservation.name = reservation_name name
            ; mode = Exclusive
            ; lease_duration_ms = None
            })
      }
  in
  let t = apply t (acquire "worker" [ "busy" ]) in
  report (prepare t (acquire "other" [ "free"; "busy" ]));
  print_s
    [%sexp
      (Option.is_none (Agent_run.get_reservation t (reservation_name "free")) : bool)];
  let t =
    apply
      t
      (Reservation_release
         { run = run_id "worker"; name = reservation_name "busy"; token = 1 })
  in
  let t = apply t (acquire "other" [ "busy" ]) in
  report
    (Agent_run.validate_reservation_owner
       t
       (reservation_name "busy")
       ~run:(run_id "worker")
       ~token:1);
  report
    (Agent_run.validate_reservation_owner
       t
       (reservation_name "busy")
       ~run:(run_id "other")
       ~token:2);
  let shared name run =
    Agent_run.Command.Reservation_acquire
      { run = run_id run
      ; requests =
          [ { Reservation.name = reservation_name name
            ; mode = Shared
            ; lease_duration_ms = None
            }
          ]
      }
  in
  let t = apply t (shared "shared" "worker") in
  let t = apply t (shared "shared" "other") in
  report
    (Agent_run.validate_reservation_owner
       t
       (reservation_name "shared")
       ~run:(run_id "worker")
       ~token:1);
  report (prepare t (acquire "worker" [ "shared" ]));
  [%expect
    {|
    Already_claimed
    true
    Stale_claim
    ok
    ok
    Already_claimed
    |}]
;;

let%expect_test "allocation explains exclusion and deterministically breaks ties" =
  let candidate ticket priority sequence =
    { Allocation.Candidate.ticket = ticket_id ticket
    ; priority
    ; creation_sequence = sequence
    ; ready = true
    ; available = true
    ; required_capabilities = [ "ocaml" ]
    ; pools = []
    }
  in
  let blocked = { (candidate "blocked" 1 0) with ready = false } in
  let busy =
    { (candidate "busy" 1 0) with
      pools = [ { Allocation.Pool.name = "build"; limit = 1; active = 1 } ]
    }
  in
  print_s
    [%sexp (Allocation.eligibility blocked ~capabilities:[] : Allocation.Reason.t list)];
  print_s
    [%sexp
      (Allocation.eligibility busy ~capabilities:[ "ocaml" ] : Allocation.Reason.t list)];
  (match
     ok
       (Allocation.choose
          [ candidate "z" 2 1
          ; candidate "a" 2 1
          ; blocked
          ; busy
          ; candidate "unspecified" 0 0
          ]
          ~capabilities:[ "ocaml" ])
   with
   | Selected c -> print_endline (Id.Ticket.to_string c.ticket)
   | Empty -> print_endline "empty");
  print_s
    [%sexp
      (ok (Allocation.choose [ blocked; busy ] ~capabilities:[ "ocaml" ]) : Allocation.t)];
  [%expect
    {|
    (Not_ready (Missing_capability ocaml))
    ((Pool_full build))
    a
    Empty
    |}]
;;

let%expect_test "silence is derived with conservative clock regression" =
  let t = apply Agent_run.empty (register "worker") in
  let t =
    apply
      t
      (Observe { id = run_id "worker"; expected_revision = 1; observed_unix_ms = 100L })
  in
  let r = Option.value_exn (Agent_run.get_run t (run_id "worker")) in
  print_s [%sexp (Agent_run.stale r ~now_unix_ms:150L ~after_ms:100L : bool)];
  print_s [%sexp (Agent_run.stale r ~now_unix_ms:200L ~after_ms:100L : bool)];
  print_s [%sexp (Agent_run.stale r ~now_unix_ms:50L ~after_ms:100L : bool)];
  report
    (prepare
       t
       (Observe { id = run_id "worker"; expected_revision = 2; observed_unix_ms = 50L }));
  [%expect
    {|
    false
    true
    true
    Conflict
    |}]
;;

let%expect_test
    "optional leases reject expiry, renewal races and backwards clocks across restart"
  =
  let indefinite = ok (Allocation_lease.create ~epoch:1 ~now_unix_ms:100L ()) in
  report (Allocation_lease.validate_owner indefinite ~epoch:1 ~now_unix_ms:999999L);
  let timed =
    ok (Allocation_lease.create ~epoch:2 ~now_unix_ms:100L ~policy:(Duration_ms 100L) ())
  in
  let timed =
    ok (Allocation_lease.renew timed ~expected_revision:1 ~epoch:2 ~now_unix_ms:150L)
  in
  report (Allocation_lease.renew timed ~expected_revision:1 ~epoch:2 ~now_unix_ms:150L);
  let restored = ok (Allocation_lease.of_json (Allocation_lease.to_json timed)) in
  print_s
    [%sexp
      (Allocation_lease.status restored ~now_unix_ms:149L : Allocation_lease.Status.t)];
  print_s
    [%sexp
      (Allocation_lease.status restored ~now_unix_ms:249L : Allocation_lease.Status.t)];
  print_s
    [%sexp
      (Allocation_lease.status restored ~now_unix_ms:250L : Allocation_lease.Status.t)];
  report (Allocation_lease.validate_owner restored ~epoch:1 ~now_unix_ms:200L);
  report (Allocation_lease.renew restored ~expected_revision:2 ~epoch:2 ~now_unix_ms:250L);
  print_s
    [%sexp
      (Allocation_lease.heartbeat_due
         ~last_unix_ms:(Some 100L)
         ~now_unix_ms:101L
         ~interval_ms:1000L
       : bool)];
  [%expect
    {|
    ok
    Conflict
    Clock_regressed
    Valid
    Expired
    Stale_claim
    Stale_claim
    false
    |}]
;;

let%expect_test "durable ticket capabilities and shared pools enforce explicit starts" =
  let t = apply Agent_run.empty (register "worker") in
  let t = apply t (Pool_put { name = "compile"; expected_revision = 0; limit = 1 }) in
  let policy ticket capabilities =
    Agent_run.Command.Ticket_policy_put
      { ticket = ticket_id ticket
      ; expected_revision = 0
      ; required_capabilities = capabilities
      ; pools = [ "compile" ]
      }
  in
  let t = apply t (policy "a" [ "ocaml" ]) in
  let t = apply t (policy "b" [ "ocaml" ]) in
  let t = apply t (policy "c" [ "rust" ]) in
  report (prepare t (start "unsupported" "c"));
  let t = apply t (start "first" "a") in
  report (prepare t (start "second" "b"));
  let candidate =
    Agent_run.allocation_candidate
      t
      ~ticket:(ticket_id "b")
      ~priority:1
      ~creation_sequence:0
      ~ready:true
      ~available:true
  in
  print_s
    [%sexp
      (Allocation.eligibility candidate ~capabilities:[ "ocaml" ]
       : Allocation.Reason.t list)];
  let t =
    apply
      t
      (Attempt_finish
         { id = attempt_id "first"
         ; expected_revision = 1
         ; state = Completed
         ; evidence = "done"
         })
  in
  report (prepare t (start "second" "b"));
  [%expect
    {|
    Blocked
    Blocked
    ((Pool_full compile))
    ok
    |}]
;;

let%expect_test
    "workflow plans pin exact resources, validate cycles and deduplicate instances"
  =
  let node alias deps =
    { Workflow_template.Node.alias
    ; title = "Work on {{subject}}"
    ; description = "Implement"
    ; depends_on = deps
    ; parent = None
    ; capabilities = []
    ; reviewers = []
    ; separate_actor = false
    }
  in
  let spec =
    { Workflow_template.Spec.parameters = [ "subject" ]
    ; nodes = [ node "second" [ "first" ]; node "first" [] ]
    }
  in
  let resource = ok (Id.Resource.of_string "template") in
  let template = ok (Workflow_template.create ~resource ~resource_revision:3 ~spec) in
  let id = ok (Workflow_template.Instance_id.of_string "workflow") in
  let instance =
    ok (Workflow_template.instantiate template ~id ~parameters:[ "subject", "parser" ])
  in
  print_s
    [%sexp
      (List.map instance.tickets ~f:(fun t ->
         t.Workflow_template.Planned_ticket.alias, t.title)
       : (string * string) list)];
  print_s
    [%sexp
      (Workflow_template.Instance.equal
         instance
         (ok
            (Workflow_template.instantiate
               template
               ~id
               ~parameters:[ "subject", "parser" ]))
       : bool)];
  report (Workflow_template.instantiate template ~id ~parameters:[]);
  report
    (Workflow_template.Spec.validate
       { spec with nodes = [ node "first" [ "second" ]; node "second" [ "first" ] ] });
  let initial =
    Agent_run_policy.candidate
      (ok (Agent_run_policy.prepare Agent_run_policy.empty (Template_register template)))
  in
  let p = ok (Agent_run_policy.prepare initial (Instance_register instance)) in
  let state = Agent_run_policy.candidate p in
  let duplicate = ok (Agent_run_policy.prepare state (Instance_register instance)) in
  print_s [%sexp (List.length (Agent_run_policy.changes duplicate) : int)];
  let replay =
    List.fold (Agent_run_policy.changes p) ~init:initial ~f:(fun t e ->
      ok
        (Agent_run_policy.apply
           t
           (ok (Agent_run_policy.Change.of_json (Agent_run_policy.Change.to_json e)))))
  in
  print_s [%sexp (Option.is_some (Agent_run_policy.get_instance replay id) : bool)];
  report
    (Agent_run_policy.validate_references
       state
       ~resource_version:(fun _ ~revision ->
         if revision = 3 then Some template.digest else None)
       ~run_exists:(Fn.const true)
       ~attempt_exists:(Fn.const true)
       ~ticket_exists:(Fn.const true));
  report
    (Agent_run_policy.validate_references
       state
       ~resource_version:(fun _ ~revision:_ -> Some "wrong")
       ~run_exists:(Fn.const true)
       ~attempt_exists:(Fn.const true)
       ~ticket_exists:(Fn.const true));
  [%expect
    {|
    ((first "Work on parser") (second "Work on parser"))
    true
    Invalid_argument
    Dependency_cycle
    0
    true
    ok
    Not_found
    |}]
;;

let%expect_test
    "attempt budgets enforce concurrency and usage reports preserve provenance"
  =
  let runs = apply Agent_run.empty (register "worker") in
  let budget =
    { Agent_run_policy.Budget.run = run_id "worker"
    ; revision = 1
    ; max_attempts = Some 2
    ; max_active_attempts = Some 1
    ; reported_token_limit = Some 10L
    ; reported_elapsed_ms_limit = None
    }
  in
  let state =
    Agent_run_policy.candidate
      (ok (Agent_run_policy.prepare Agent_run_policy.empty (Budget_put budget)))
  in
  report (Agent_run_policy.validate_allocation state (run_id "worker") ~runs);
  let runs = apply runs (start "first" "a") in
  report (Agent_run_policy.validate_allocation state (run_id "worker") ~runs);
  let usage =
    { Usage_record.id = ok (Usage_record.Id.of_string "usage")
    ; scope = Attempt (attempt_id "first")
    ; actor
    ; tokens = 10L
    ; elapsed_ms = 100L
    ; provenance = "runner estimate"
    ; timestamp = "2026-10-07"
    }
  in
  let prepared = ok (Agent_run_policy.prepare state (Usage_report usage)) in
  let state = Agent_run_policy.candidate prepared in
  print_s [%sexp (List.length (Agent_run_policy.attention state ~runs) : int)];
  print_s
    [%sexp
      (List.length
         (Agent_run_policy.changes
            (ok (Agent_run_policy.prepare state (Usage_report usage))))
       : int)];
  report (Agent_run_policy.prepare state (Usage_report { usage with tokens = 11L }));
  let restored = ok (Usage_record.of_json (Usage_record.to_json usage)) in
  print_s [%sexp (Usage_record.equal usage restored : bool)];
  let runs =
    apply
      runs
      (Attempt_finish
         { id = attempt_id "first"
         ; expected_revision = 1
         ; state = Failed
         ; evidence = "failed"
         })
  in
  report (Agent_run_policy.validate_allocation state (run_id "worker") ~runs);
  let runs = apply runs (start "replacement" "a") in
  let runs =
    apply
      runs
      (Attempt_finish
         { id = attempt_id "replacement"
         ; expected_revision = 1
         ; state = Completed
         ; evidence = "done"
         })
  in
  report (Agent_run_policy.validate_allocation state (run_id "worker") ~runs);
  [%expect
    {|
    ok
    Blocked
    1
    0
    Idempotency_conflict
    true
    ok
    Blocked
    |}]
;;

let%expect_test "timed reservation ownership expires and lease renewal replays exactly" =
  let t = apply Agent_run.empty (register "worker") in
  let command =
    Agent_run.Command.Reservation_acquire
      { run = run_id "worker"
      ; requests =
          [ { Reservation.name = reservation_name "worktree"
            ; mode = Exclusive
            ; lease_duration_ms = Some 100L
            }
          ]
      }
  in
  report (prepare t command);
  let p =
    ok
      (Agent_run.prepare
         t
         ~now_unix_ms:100L
         command
         ~actor
         ~run:None
         ~timestamp:"now"
         ~sequence:1)
  in
  let t = Agent_run.candidate p in
  report
    (Agent_run.validate_reservation_owner
       t
       ~now_unix_ms:199L
       (reservation_name "worktree")
       ~run:(run_id "worker")
       ~token:1);
  report
    (Agent_run.validate_reservation_owner
       t
       ~now_unix_ms:200L
       (reservation_name "worktree")
       ~run:(run_id "worker")
       ~token:1);
  let renewal =
    Agent_run.Command.Reservation_renew
      { run = run_id "worker"
      ; name = reservation_name "worktree"
      ; token = 1
      ; expected_lease_revision = 1
      }
  in
  let p =
    ok
      (Agent_run.prepare
         t
         ~now_unix_ms:150L
         renewal
         ~actor
         ~run:None
         ~timestamp:"renew"
         ~sequence:2)
  in
  let replay =
    List.fold (Agent_run.changes p) ~init:t ~f:(fun state e ->
      ok
        (Agent_run.apply
           state
           (Agent_run.Change.t_of_jsonaf (Agent_run.Change.jsonaf_of_t e))))
  in
  report
    (Agent_run.validate_reservation_owner
       replay
       ~now_unix_ms:249L
       (reservation_name "worktree")
       ~run:(run_id "worker")
       ~token:1);
  report
    (Agent_run.validate_reservation_owner
       replay
       ~now_unix_ms:250L
       (reservation_name "worktree")
       ~run:(run_id "worker")
       ~token:1);
  report
    (Agent_run.prepare
       replay
       ~now_unix_ms:160L
       renewal
       ~actor
       ~run:None
       ~timestamp:"racing"
       ~sequence:3);
  let reservation =
    Option.value_exn (Agent_run.get_reservation replay (reservation_name "worktree"))
  in
  print_s
    [%sexp
      (Reservation.equal
         reservation
         (Reservation.t_of_jsonaf (Reservation.jsonaf_of_t reservation))
       : bool)];
  let lease = (List.hd_exn reservation.holders).lease in
  print_s
    [%sexp
      (Allocation_lease.equal
         lease
         (Allocation_lease.t_of_sexp (Allocation_lease.sexp_of_t lease))
       : bool)];
  [%expect
    {|
    Invalid_argument
    ok
    Stale_claim
    ok
    Stale_claim
    Conflict
    true
    true
    |}]
;;

let%expect_test "workflow substitutions are literal and independent of parameter order" =
  let node title =
    { Workflow_template.Node.alias = "node"
    ; title
    ; description = ""
    ; depends_on = []
    ; parent = None
    ; capabilities = []
    ; reviewers = []
    ; separate_actor = false
    }
  in
  let template title =
    ok
      (Workflow_template.create
         ~resource:(ok (Id.Resource.of_string "template"))
         ~resource_revision:1
         ~spec:{ parameters = [ "a"; "b" ]; nodes = [ node title ] })
  in
  let id = ok (Workflow_template.Instance_id.of_string "instance") in
  let instantiate template parameters =
    Workflow_template.instantiate template ~id ~parameters
  in
  let parameters = [ "a", "{{b}}"; "b", "literal }} text" ] in
  let forward = ok (instantiate (template "{{a}} / {{b}}") parameters) in
  let reverse = ok (instantiate (template "{{a}} / {{b}}") (List.rev parameters)) in
  print_s [%sexp (Workflow_template.Instance.equal forward reverse : bool)];
  print_endline (List.hd_exn forward.tickets).title;
  let policies =
    Agent_run_policy.candidate
      (ok
         (Agent_run_policy.prepare
            Agent_run_policy.empty
            (Template_register (template "{{a}} / {{b}}"))))
  in
  report (Agent_run_policy.prepare policies (Instance_register forward));
  List.iter [ "{{unknown}}"; "{{a"; "stray }}"; "{{{{a}}" ] ~f:(fun title ->
    report (instantiate (template title) parameters));
  report (instantiate (template "{{a}}") [ "a", String.make 513 'x'; "b", "unused" ]);
  [%expect
    {|
    true
    {{b}} / literal }} text
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "run record JSON decoding validates domain invariants" =
  let runs = apply Agent_run.empty (register "worker") in
  let record = Option.value_exn (Agent_run.get_run runs (run_id "worker")) in
  let decode record =
    Json.decode (fun () ->
      Agent_run.Record.t_of_jsonaf (Agent_run.Record.jsonaf_of_t record))
  in
  report (decode record);
  List.iter
    [ { record with revision = 0 }
    ; { record with objective = " " }
    ; { record with capabilities = [ "ocaml"; "ocaml" ] }
    ; { record with process_ref = Some (String.make 1025 'x') }
    ; { record with status = Completed; evidence = "" }
    ]
    ~f:(fun record -> report (decode record));
  [%expect
    {|
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;
