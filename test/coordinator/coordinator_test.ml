open Core
open Workgraph

let ok = function
  | Ok x -> x
  | Error e -> failwith e.Problem.message
;;

let actor = ok (Id.Actor.of_string "actor")
let run = ok (Id.Run.of_string "run")
let workspace = ok (Id.Workspace.of_string "workspace")
let project = ok (Id.Project.of_string "project")
let ticket_id s = ok (Id.Ticket.of_string s)

let prepare runs command =
  Agent_run.candidate
    (ok (Agent_run.prepare runs command ~actor ~run:None ~timestamp:"now" ~sequence:1))
;;

let registered =
  prepare
    Agent_run.empty
    (Register
       { id = run
       ; parent = None
       ; parent_stop_policy = Continue
       ; objective = "task"
       ; capabilities = []
       ; process_ref = None
       ; worktree_ref = None
       })
;;

let ticket ?claim ?(ready = true) ?(deps = []) id title =
  { Coordinator.Ticket.id = ticket_id id
  ; project = Some project
  ; title
  ; status = Domain_command.Status.Todo
  ; prerequisites = List.map deps ~f:ticket_id
  ; ready
  ; blockers = Json.obj []
  ; claim
  }
;;

let read
      ?(revision = 1)
      ?(head = Some "head")
      ?(now = 100L)
      ?(heartbeats = [])
      ?(runs = registered)
      ?(policies = Agent_run_policy.empty)
      ?(communication = Communication.empty)
      ?(evidence = Evidence.empty)
      tickets
      params
  =
  Coordinator.read
    ~workspace
    ~head
    ~revision
    ~tickets
    ~runs
    ~evidence
    ~communication
    ~policies
    ~heartbeats
    ~now_unix_ms:now
    ~params
;;

let kinds json =
  List.map
    (Json.list (Json.field json "items"))
    ~f:(fun item -> Json.text (Json.field item "kind"))
;;

let report = function
  | Ok _ -> print_endline "ok"
  | Error e -> print_s [%sexp (e.Problem.kind : Problem.kind)]
;;

let%expect_test
    "source rows include active attempts, ready work, deadlines and dependency blockers"
  =
  let lease =
    ok (Allocation_lease.create ~epoch:1 ~now_unix_ms:0L ~policy:(Duration_ms 100L) ())
  in
  let claim = { Coordinator.Claim.actor; run = Some run; token = 1; lease } in
  let tickets =
    [ ticket "ready" "ready"
    ; ticket ~claim ~ready:false "work" "work"
    ; ticket ~ready:false ~deps:[ "work" ] "blocked" "blocked"
    ]
  in
  let attempt = ok (Attempt.Id.of_string "attempt") in
  let runs =
    prepare
      registered
      (Attempt_start
         { id = attempt; run; ticket = ticket_id "work"; token = 1; sessions = [] })
  in
  let result = ok (read ~runs tickets (Json.obj [])) in
  print_s [%sexp (kinds result : string list)];
  print_s
    [%sexp
      (List.for_all
         (Json.list (Json.field result "items"))
         ~f:(fun item -> Option.is_some (Json.optional item "source"))
       : bool)];
  print_endline (Json.text (Json.field result "critical_path_reason"));
  let params =
    Json.obj
      [ "project", Id.Project.jsonaf_of_t project
      ; "run", Id.Run.jsonaf_of_t run
      ; "kinds", `Array [ Json.string "active_attempt" ]
      ]
  in
  print_s [%sexp (kinds (ok (read ~runs tickets params)) : string list)];
  [%expect
    {|
    (active_attempt dependency_bottleneck expired_ownership ready_work stale_run)
    true
    Task duration estimates are unavailable
    (active_attempt)
    |}]
;;

let%expect_test
    "captured paging keeps original clock and rejects revision, filter and heartbeat \
     changes"
  =
  let tickets = [ ticket "a" "a"; ticket "b" "b"; ticket "c" "c" ] in
  let params =
    Json.obj [ "limit", Json.int 1; "kinds", `Array [ Json.string "ready_work" ] ]
  in
  let first = ok (read tickets params) in
  let cursor = Json.field first "next_cursor" in
  let page =
    Json.obj
      [ "limit", Json.int 1
      ; "kinds", `Array [ Json.string "ready_work" ]
      ; "cursor", cursor
      ]
  in
  let second = ok (read ~now:1000L tickets page) in
  print_s
    [%sexp
      (List.map
         (Json.list (Json.field second "items"))
         ~f:(fun item -> Json.text (Json.field (Json.field item "source") "id"))
       : string list)];
  print_endline (Json.text (Json.field second "captured_now_unix_ms"));
  report (read ~revision:2 tickets page);
  report (read ~head:(Some "different-head") tickets page);
  report (read ~now:99L tickets page);
  report (read ~heartbeats:[ run, 100L ] tickets page);
  report
    (read
       tickets
       (Json.obj
          [ "limit", Json.int 1
          ; "kinds", `Array [ Json.string "stale_run" ]
          ; "cursor", cursor
          ]));
  report (read tickets (Json.obj [ "cursor", Json.string "bad-cursor" ]));
  [%expect
    {|
    (b)
    100
    Conflict
    Conflict
    Conflict
    Conflict
    Conflict
    Invalid_argument
    |}]
;;

let%expect_test "oversized rows keep their position until the budget increases" =
  let tickets = [ ticket "large" (String.make 6000 'x'); ticket "next" "next" ] in
  let params =
    Json.obj [ "max_bytes", Json.int 4096; "kinds", `Array [ Json.string "ready_work" ] ]
  in
  let first = ok (read tickets params) in
  print_s [%sexp (List.length (Json.list (Json.field first "items")) : int)];
  print_s [%sexp (String.length (Json.canonical first) <= 4096 : bool)];
  print_s [%sexp (Json.field first "needs_larger_budget" : Jsonaf.t)];
  let second =
    ok
      (read
         tickets
         (Json.obj
            [ "max_bytes", Json.int 16384
            ; "kinds", `Array [ Json.string "ready_work" ]
            ; "cursor", Json.field first "next_cursor"
            ]))
  in
  print_s
    [%sexp
      (List.map
         (Json.list (Json.field second "items"))
         ~f:(fun item -> Json.text (Json.field (Json.field item "source") "id"))
       : string list)];
  [%expect
    {|
    0
    true
    True
    (large next)
    |}]
;;

let%expect_test "heartbeats are advisory freshness and never extend an expired claim" =
  let lease =
    ok (Allocation_lease.create ~epoch:1 ~now_unix_ms:0L ~policy:(Duration_ms 100L) ())
  in
  let claim = { Coordinator.Claim.actor; run = Some run; token = 1; lease } in
  let tickets = [ ticket ~claim ~ready:false "work" "work" ] in
  let result = ok (read ~heartbeats:[ run, 100L ] tickets (Json.obj [])) in
  print_s [%sexp (kinds result : string list)];
  [%expect {| (expired_ownership) |}]
;;

let%expect_test
    "requests, reviews, changed inputs, reservations and usage retain navigable sources"
  =
  let attempt = ok (Attempt.Id.of_string "attempt") in
  let runs =
    prepare
      registered
      (Attempt_start
         { id = attempt; run; ticket = ticket_id "work"; token = 1; sessions = [] })
  in
  let name = ok (Reservation.Name.of_string "worktree") in
  let runs =
    prepare
      runs
      (Reservation_acquire
         { run
         ; requests = [ { Reservation.name; mode = Exclusive; lease_duration_ms = None } ]
         })
  in
  let comm_step t command =
    Communication.candidate
      (ok
         (Communication.prepare
            t
            command
            ~actor
            ~run:(Some run)
            ~timestamp:"now"
            ~sequence:1))
  in
  let board = ok (Communication_id.Board.of_string "board") in
  let thread = ok (Communication_id.Thread.of_string "thread") in
  let request = ok (Communication_id.Request.of_string "request") in
  let communication =
    comm_step
      Communication.empty
      (Board_put { id = board; expected_revision = 0; scope = Workspace; title = "Board" })
  in
  let communication =
    comm_step
      communication
      (Thread_put
         { id = thread
         ; expected_revision = 0
         ; board
         ; title = "Thread"
         ; participants = [ actor ]
         ; mentions = []
         ; links = [ Entity_ref.Ticket (ticket_id "work") ]
         ; state = Open
         ; pinned = false
         })
  in
  let communication =
    comm_step
      communication
      (Thread_attach
         { id = thread
         ; expected_revision = 1
         ; message = ok (Id.Comment.of_string "message")
         })
  in
  let communication =
    comm_step
      communication
      (Request_create
         { id = request
         ; thread
         ; kind = Review
         ; message = ok (Id.Comment.of_string "message")
         ; recipients = [ Actor actor ]
         ; teams = []
         ; resolver = actor
         ; correlation_id = None
         ; reply_to = None
         ; deadline_unix_ms = None
         })
  in
  let contract = ok (Evidence_id.Contract.of_string "contract") in
  let manifest = ok (Evidence_id.Manifest.of_string "manifest") in
  let pin id digest =
    { Evidence.Resource_pin.id = ok (Id.Resource.of_string id)
    ; revision = 1
    ; digest = String.make 64 digest
    }
  in
  let source_pin = pin "input" 'a' in
  let evidence_step t command =
    Evidence.candidate
      (ok
         (Evidence.prepare
            t
            command
            ~actor
            ~run:(Some run)
            ~timestamp:"now"
            ~sequence:(Evidence.revision t + 1)))
  in
  let evidence =
    evidence_step
      Evidence.empty
      (Contract_put
         { id = contract
         ; expected_revision = 0
         ; schema_version = 1
         ; schema = pin "schema" 'd'
         ; required_inputs = [ "source" ]
         ; required_outputs = [ "output" ]
         })
  in
  let evidence =
    evidence_step
      evidence
      (Manifest_publish
         { id = manifest
         ; expected_revision = 0
         ; schema_version = 1
         ; attempt
         ; ticket = ticket_id "work"
         ; contract = { Evidence.Contract_ref.id = contract; revision = 1 }
         ; inputs = [ { Evidence.Artifact.name = "source"; pin = Resource source_pin } ]
         ; outputs =
             [ { Evidence.Artifact.name = "output"; pin = Resource (pin "output" 'b') } ]
         })
  in
  let evidence =
    evidence_step
      evidence
      (Policy_put
         { ticket = ticket_id "work"
         ; expected_revision = 0
         ; enabled = true
         ; reviewers = [ Named_actor actor ]
         ; separate_actor = false
         ; validators = []
         })
  in
  let evidence =
    evidence_step
      evidence
      (Submit
         { ticket = ticket_id "work"
         ; expected_revision = 0
         ; manifest = { Evidence.Manifest_ref.id = manifest; revision = 1 }
         ; review_request = None
         })
  in
  let evidence =
    evidence_step
      evidence
      (Input_changed
         { previous = Resource source_pin
         ; current =
             Resource { source_pin with revision = 2; digest = String.make 64 'c' }
         })
  in
  let policy_step t command =
    Agent_run_policy.candidate (ok (Agent_run_policy.prepare t command))
  in
  let policies =
    policy_step
      Agent_run_policy.empty
      (Budget_put
         { run
         ; revision = 1
         ; max_attempts = None
         ; max_active_attempts = None
         ; reported_token_limit = Some 1L
         ; reported_elapsed_ms_limit = None
         })
  in
  let policies =
    policy_step
      policies
      (Usage_report
         { id = ok (Usage_record.Id.of_string "usage")
         ; scope = Attempt attempt
         ; actor
         ; tokens = 1L
         ; elapsed_ms = 1L
         ; provenance = "runner estimate"
         ; timestamp = "now"
         })
  in
  let selected =
    [ "budget_limit"
    ; "changed_input"
    ; "pending_review"
    ; "reported_usage"
    ; "reservation"
    ; "unanswered_request"
    ]
  in
  let params =
    Json.obj
      [ "project", Id.Project.jsonaf_of_t project
      ; "actor", Id.Actor.jsonaf_of_t actor
      ; "kinds", `Array (List.map selected ~f:Json.string)
      ]
  in
  let result =
    ok (read ~runs ~evidence ~communication ~policies [ ticket "work" "work" ] params)
  in
  print_s [%sexp (kinds result : string list)];
  print_s
    [%sexp
      (List.for_all
         (Json.list (Json.field result "items"))
         ~f:(fun item -> Option.is_some (Json.optional (Json.field item "source") "type"))
       : bool)];
  [%expect
    {|
    (budget_limit changed_input pending_review reported_usage reservation
     unanswered_request)
    true
    |}]
;;

let%expect_test "run readiness uses capabilities, active pool counts and attempt budgets" =
  let runs =
    prepare registered (Pool_put { name = "serial"; expected_revision = 0; limit = 1 })
  in
  let policy runs id capabilities pools =
    prepare
      runs
      (Ticket_policy_put
         { ticket = ticket_id id
         ; expected_revision = 0
         ; required_capabilities = capabilities
         ; pools
         })
  in
  let runs = policy runs "capability" [ "rust" ] [] in
  let runs = policy runs "pool" [] [ "serial" ] in
  let runs = policy runs "holder" [] [ "serial" ] in
  let runs =
    prepare
      runs
      (Attempt_start
         { id = ok (Attempt.Id.of_string "holder-attempt")
         ; run
         ; ticket = ticket_id "holder"
         ; token = 1
         ; sessions = []
         })
  in
  let tickets =
    [ ticket "capability" "capability"; ticket "pool" "pool"; ticket "free" "free" ]
  in
  let params =
    Json.obj
      [ "run", Id.Run.jsonaf_of_t run
      ; "actor", Id.Actor.jsonaf_of_t actor
      ; "kinds", `Array [ Json.string "ready_work"; Json.string "allocation_blocked" ]
      ]
  in
  let show result =
    List.iter
      (Json.list (Json.field result "items"))
      ~f:(fun item ->
        print_s
          [%sexp
            (( Json.text (Json.field item "kind")
             , Json.text (Json.field (Json.field item "source") "id")
             , List.map
                 (Json.list
                    (Json.field (Json.field item "metadata") "allocation_reasons"))
                 ~f:(fun reason -> Json.text (Json.field reason "kind")) )
             : string * string * string list)])
  in
  show (ok (read ~runs tickets params));
  print_s
    [%sexp
      (kinds
         (ok
            (read
               ~runs
               tickets
               (Json.obj [ "kinds", `Array [ Json.string "ready_work" ] ])))
       : string list)];
  let policies =
    Agent_run_policy.candidate
      (ok
         (Agent_run_policy.prepare
            Agent_run_policy.empty
            (Budget_put
               { run
               ; revision = 1
               ; max_attempts = None
               ; max_active_attempts = Some 1
               ; reported_token_limit = None
               ; reported_elapsed_ms_limit = None
               })))
  in
  show (ok (read ~runs ~policies [ ticket "free" "free" ] params));
  let runs =
    prepare
      runs
      (Attempt_finish
         { id = ok (Attempt.Id.of_string "holder-attempt")
         ; expected_revision = 1
         ; state = Completed
         ; evidence = "done"
         })
  in
  let runs =
    prepare
      runs
      (Transition
         { id = run; expected_revision = 1; status = Completed; evidence = "done" })
  in
  show (ok (read ~runs [ ticket "free" "free" ] params));
  report (read tickets (Json.obj [ "run", Json.string "unknown" ]));
  [%expect
    {|
    (allocation_blocked capability (missing_capability))
    (allocation_blocked pool (pool_full))
    (ready_work free ())
    (ready_work ready_work ready_work)
    (allocation_blocked free (run_budget))
    (allocation_blocked free (run_terminal))
    Not_found
    |}]
;;
