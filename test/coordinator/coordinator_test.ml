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
  ; blockers =
      (let policy =
         ok
           (Acceptance_policy.Effective.resolve
              ~ticket_id:(ticket_id id)
              ~project_id:(Some project)
              ~membership_revision:1
              ~project:None
              ~ticket:None
              ~minimum_reopening_token:None
              ~ownership_token:None)
       in
       { Planning_ticket_wire.Readiness.ready
       ; reasons = (if ready then [] else [ Status Todo ])
       ; reason_count = (if ready then 0 else 1)
       ; reassessments = []
       ; completion =
           { can_complete = true
           ; checks =
               List.map
                 [ Planning_ticket_wire.Completion.Check.Hold
                 ; Prerequisites
                 ; Children
                 ; Configured_policy
                 ]
                 ~f:(fun kind ->
                   { Planning_ticket_wire.Completion.Check.kind; passed = true })
           ; policy
           ; blocked_prerequisite_count = 0
           ; unfinished_child_count = 0
           ; blocked_prerequisite_ids = []
           ; unfinished_child_ids = []
           ; problem = None
           }
       })
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
      [ "project_id", Id.Project.jsonaf_of_t project
      ; "run_id", Id.Run.jsonaf_of_t run
      ; "kinds", `Array [ Json.string "active_attempt" ]
      ]
  in
  print_s [%sexp (kinds (ok (read ~runs tickets params)) : string list)];
  [%expect
    {|
    (active_attempt dependency_bottleneck expired_ownership ready_work
     unobserved_run)
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
         ~f:(fun item -> Json.text (Json.field (Json.field item "source") "ticket_id"))
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
  let large = ticket "large" "large" in
  let reassessment : Planning_ticket_wire.Reassessment.t =
    { prerequisite_ticket_id = ticket_id "source"
    ; reopened_revision = 1
    ; reason = String.make 6000 'x'
    ; actor_id = actor
    ; timestamp = "now"
    }
  in
  let tickets =
    [ { large with blockers = { large.blockers with reassessments = [ reassessment ] } }
    ; ticket "next" "next"
    ]
  in
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
         ~f:(fun item -> Json.text (Json.field (Json.field item "source") "ticket_id"))
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
            ~ticket_context:(fun _ ->
              Some
                { Evidence.Ticket_context.project = None
                ; membership_revision = 1
                ; minimum_reopening_token = None
                ; current_token = Some 1
                ; ownership = Some { token = 1; actor; run = Some run }
                ; attempt = Some attempt
                })
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
         ; weakening_reason = None
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
      [ "project_id", Id.Project.jsonaf_of_t project
      ; "actor_id", Id.Actor.jsonaf_of_t actor
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
         ~f:(fun item -> Option.is_some (Json.optional (Json.field item "source") "kind"))
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
      [ "run_id", Id.Run.jsonaf_of_t run
      ; "actor_id", Id.Actor.jsonaf_of_t actor
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
             , Json.text (Json.field (Json.field item "source") "ticket_id")
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
  report (read tickets (Json.obj [ "run_id", Json.string "unknown" ]));
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

let%expect_test "public source metadata and oversized disclosure reject contradictions" =
  let row =
    Jsonaf.of_string
      {|{"kind":"stale_ownership","source":{"kind":"ticket","ticket_id":"work"},"metadata":{"kind":"ticket","token":"1","lease_status":"expired","lease":{"epoch":"1","revision":"1","duration_ms":"1","last_unix_ms":"0","deadline_unix_ms":"1"},"run_id":null}}|}
  in
  let report codec json =
    match Api_codec.decode codec json with
    | Ok _ -> print_endline "ok"
    | Error p -> print_s [%sexp (p.kind : Problem.kind)]
  in
  report Coordinator_wire.Item.codec row;
  let expired =
    match row with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           key, if String.equal key "kind" then Json.string "expired_ownership" else value))
    | _ -> assert false
  in
  report Coordinator_wire.Item.codec expired;
  let wrong_source =
    match expired with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if String.equal key "source"
             then Jsonaf.of_string {|{"kind":"reservation","name":"checkout"}|}
             else value )))
    | _ -> assert false
  in
  report Coordinator_wire.Item.codec wrong_source;
  let valid =
    ok
      (read
         [ ticket "a" "A" ]
         (Json.obj [ "kinds", `Array [ Json.string "ready_work" ] ]))
    |> Api_response.project Workspace_view
    |> Api_response.data
  in
  report Coordinator_wire.Response.codec valid;
  let contradiction =
    match valid with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           key, if String.equal key "needs_larger_budget" then `True else value))
    | _ -> assert false
  in
  report Coordinator_wire.Response.codec contradiction;
  let duplicate =
    match valid with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if String.equal key "items"
             then `Array (Json.list value @ Json.list value)
             else value )))
    | _ -> assert false
  in
  report Coordinator_wire.Response.codec duplicate;
  let wrong_clock =
    match valid with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if String.equal key "items"
             then `Array [ expired ]
             else if String.equal key "captured_now_unix_ms"
             then Json.int64 0L
             else value )))
    | _ -> assert false
  in
  report Coordinator_wire.Response.codec wrong_clock;
  let request = Coordinator_api.Request.codec in
  report request (Json.obj [ "run", Json.string "run" ]);
  report
    request
    (Json.obj [ "kinds", `Array [ Json.string "ready_work"; Json.string "ready_work" ] ]);
  [%expect
    {|
    Invalid_argument
    ok
    Invalid_argument
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "reported attention shares validated limit and saturation semantics" =
  let values =
    List.map
      [ 0L, 0L; 10L, 10L; Int64.max_value, 1L ]
      ~f:(fun (reported, limit) ->
        ok (Run_budget.Attention.create ~run ~kind:Reported_tokens ~reported ~limit))
  in
  List.iter values ~f:(fun value ->
    print_s [%sexp (value.reported_total_is_lower_bound : bool)]);
  let sample =
    Coordination_wire.encode_exn Run_budget.Attention.codec (List.last_exn values)
  in
  let bad =
    match sample with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           key, if String.equal key "reported_total_is_lower_bound" then `False else value))
    | _ -> assert false
  in
  List.iter
    [ Api_codec.decode Run_budget.Attention.codec bad
    ; Run_budget.Attention.create ~run ~kind:Reported_tokens ~reported:9L ~limit:10L
    ]
    ~f:(function
      | Ok _ -> print_endline "unexpected"
      | Error p -> print_s [%sexp (p.kind : Problem.kind)]);
  [%expect
    {|
    false
    false
    true
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "coordinator required bytes are the exact first whole public envelope" =
  let large = ticket "large" "Large" in
  let metadata : Planning_ticket_wire.Reassessment.t =
    { prerequisite_ticket_id = ticket_id "source"
    ; reopened_revision = 1
    ; reason = String.make 6000 'x'
    ; actor_id = actor
    ; timestamp = "now"
    }
  in
  let tickets =
    [ { large with blockers = { large.blockers with reassessments = [ metadata ] } }
    ; ticket "next" "Next"
    ]
  in
  let fields max_bytes extra =
    Json.obj
      ([ "max_bytes", Json.int max_bytes; "kinds", `Array [ Json.string "ready_work" ] ]
       @ extra)
  in
  let tiny = ok (read tickets (fields 4096 [])) in
  let required = Json.integer (Json.field tiny "required_bytes") in
  let cursor = "cursor", Json.field tiny "next_cursor" in
  let exact = ok (read tickets (fields required [ cursor ])) in
  let smaller = ok (read tickets (fields (required - 1) [ cursor ])) in
  let maximum = ok (read tickets (fields 1048576 [ cursor ])) in
  print_s
    [%sexp
      (( required > 4096
       , Api_response.encoded_size Workspace_view exact = required
       , List.length (Json.list (Json.field exact "items"))
       , List.length (Json.list (Json.field smaller "items"))
       , List.length (Json.list (Json.field maximum "items")) )
       : bool * bool * int * int * int)];
  let row = Json.field exact "items" |> Json.list |> List.hd_exn in
  let projected = Coordination_wire.decode_exn Coordinator_wire.Item.codec row in
  let full =
    match projected with
    | Coordinator_wire.Item.Ready_work { metadata; _ } ->
      List.hd_exn metadata.blockers.reassessments
      |> fun value -> String.length value.Planning_ticket_wire.Reassessment.reason
    | _ -> assert false
  in
  print_s [%sexp (full : int)];
  [%expect
    {|
    (true true 1 0 2)
    6000
    |}]
;;

let%expect_test "policy attention uses the actual saturating reported accumulator" =
  let apply t command =
    Agent_run_policy.candidate (ok (Agent_run_policy.prepare t command))
  in
  let budget : Run_budget.t =
    { run
    ; revision = 1
    ; max_attempts = None
    ; max_active_attempts = None
    ; reported_token_limit = Some Int64.max_value
    ; reported_elapsed_ms_limit = None
    }
  in
  let policies = apply Agent_run_policy.empty (Budget_put budget) in
  let usage id tokens : Usage_record.t =
    { id = ok (Usage_record.Id.of_string id)
    ; scope = Run run
    ; actor
    ; tokens
    ; elapsed_ms = 0L
    ; provenance = "external"
    ; timestamp = "now"
    }
  in
  let policies =
    apply policies (Usage_report (usage "first" (Int64.pred Int64.max_value)))
  in
  print_s
    [%sexp (List.length (Agent_run_policy.attention policies ~runs:registered) : int)];
  let policies = apply policies (Usage_report (usage "overflow" 2L)) in
  let attention = Agent_run_policy.attention policies ~runs:registered |> List.hd_exn in
  print_s
    [%sexp
      (( Int64.equal attention.reported Int64.max_value
       , attention.reported_total_is_lower_bound )
       : bool * bool)];
  ignore (Coordination_wire.encode_exn Run_budget.Attention.codec attention : Jsonaf.t);
  [%expect
    {|
    0
    (true true)
    |}]
;;

let%expect_test "selected run readiness and allocation share required path context" =
  let apply state method_ json =
    let command = ok (Domain_command.decode ~method_ ~params:(Jsonaf.of_string json)) in
    State.candidate
      (ok (State.prepare state command ~actor ~now_unix_ms:100L ~timestamp:"now"))
  in
  let state = ok (State.empty ~workspace ~name:"Paths") in
  let state = apply state "run.register" {|{"target_run_id":"run","objective":"Work"}|} in
  let state = apply state "ticket.create" {|{"ticket_id":"work","title":"Work"}|} in
  let state =
    apply
      state
      "ticket.paths.put"
      {|{"ticket_id":"work","expected_revision":"0","require_reservations":true,"declarations":[{"target":{"worktree_id":"tree","kind":"subtree","path":"src"},"mode":"exclusive"}]}|}
  in
  let inspect selected =
    let params =
      Json.obj
        (Option.to_list
           (Option.map selected ~f:(fun run -> "run_id", Id.Run.jsonaf_of_t run)))
    in
    let tickets = State.coordination_tickets ?run:selected ~now_unix_ms:100L state in
    let response = ok (read ~runs:(State.agent_runs state) tickets params) in
    let public =
      Coordination_wire.decode_exn
        Coordinator_wire.Response.codec
        (Api_response.data (Api_response.project Workspace_view response))
    in
    let row =
      List.find_exn public.items ~f:(function
        | Ready_work _ | Allocation_blocked _ -> true
        | _ -> false)
    in
    match row with
    | Ready_work { metadata; _ } | Allocation_blocked { metadata; _ } ->
      print_s
        [%sexp
          (( Coordinator_wire.Kind.to_string (Coordinator_wire.Item.kind row)
           , metadata.blockers.ready
           , metadata.blockers.reason_count
           , List.length metadata.allocation_reasons )
           : string * bool * int * int)]
    | _ -> assert false
  in
  inspect None;
  inspect (Some run);
  [%expect
    {|
    (allocation_blocked false 1 1)
    (ready_work true 0 0)
    |}]
;;

let%expect_test "stale ownership and runner actions retain actual typed source records" =
  let lease = ok (Allocation_lease.create ~epoch:1 ~now_unix_ms:0L ()) in
  let claim = { Coordinator.Claim.actor; run = Some run; token = 1; lease } in
  let observed =
    prepare
      registered
      (Observe { id = run; expected_revision = 1; observed_unix_ms = 0L })
  in
  let stale =
    ok
      (read
         ~runs:observed
         ~now:300000L
         [ ticket ~claim ~ready:false "work" "Work" ]
         (Json.obj [ "kinds", `Array [ Json.string "stale_ownership" ] ]))
  in
  let child = ok (Id.Run.of_string "child") in
  let runs =
    prepare
      registered
      (Register
         { id = child
         ; parent = Some run
         ; parent_stop_policy = Request_cancel
         ; objective = "Child"
         ; capabilities = []
         ; process_ref = None
         ; worktree_ref = None
         })
  in
  let runs =
    prepare
      runs
      (Transition
         { id = run
         ; expected_revision = 1
         ; status = Cancelled
         ; evidence = "Cancelled by harness"
         })
  in
  let action =
    ok (read ~runs [] (Json.obj [ "kinds", `Array [ Json.string "runner_action" ] ]))
  in
  List.iter [ stale; action ] ~f:(fun response ->
    let decoded =
      Coordination_wire.decode_exn
        Coordinator_wire.Response.codec
        (Api_response.data (Api_response.project Workspace_view response))
    in
    print_s
      [%sexp
        (List.map decoded.items ~f:(fun row ->
           Coordinator_wire.Kind.to_string (Coordinator_wire.Item.kind row))
         : string list)]);
  [%expect
    {|
    (stale_ownership)
    (runner_action)
    |}]
;;
