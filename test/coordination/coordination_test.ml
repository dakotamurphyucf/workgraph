open Core
open Workgraph

let unwrap = function
  | Ok value -> value
  | Error error -> failwith (Sexp.to_string_hum (Problem.sexp_of_t error))
;;

let actor = Id.Actor.of_string "worker" |> unwrap
let run = Id.Run.of_string "runner" |> unwrap
let ticket id = Id.Ticket.of_string id |> unwrap
let timestamp = "2026-10-07T00:00:00Z"

let empty () =
  State.empty ~workspace:(Id.Workspace.of_string "test" |> unwrap) ~name:"Test" |> unwrap
;;

let prepare ?(actor = actor) ?run ?now state command =
  let method_, params = Wire_command.encode command |> unwrap in
  let decoded = Domain_command.decode ~method_ ~params |> unwrap in
  assert (Sexp.equal (Domain_command.sexp_of_t command) (Domain_command.sexp_of_t decoded));
  State.prepare state decoded ~actor ?run ?now_unix_ms:now ~timestamp
;;

let step ?actor ?run ?now state command =
  let p = prepare ?actor ?run ?now state command |> unwrap in
  let replayed = State.replay state (State.events p) |> unwrap in
  assert (
    String.equal
      (Json.canonical (State.to_json replayed))
      (Json.canonical (State.to_json (State.candidate p))));
  State.candidate p
;;

let outcome = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_s [%sexp (p.Problem.kind : Problem.kind)]
;;

let create id =
  Domain_command.Ticket_create
    { id = ticket id
    ; title = id
    ; description = ""
    ; project = None
    ; parent = None
    ; milestone = None
    }
;;

let claim id revision =
  Domain_command.Ticket_claim { id = ticket id; expected_revision = revision }
;;

let progress id token =
  Domain_command.Ticket_progress
    { ticket = ticket id; token; kind = Discussion.Kind.Progress; body = "working" }
;;

let register =
  Domain_command.Agent_run
    (Agent_run.Command.Register
       { id = run
       ; parent = None
       ; parent_stop_policy = Continue
       ; objective = "work"
       ; capabilities = [ "ocaml" ]
       ; process_ref = None
       ; worktree_ref = None
       })
;;

let%expect_test "claim leases fence protected writes and persist exact renewal" =
  let state = step (empty ()) (create "timed") in
  let command =
    Domain_command.Ticket_claim_with_lease
      { id = ticket "timed"; expected_revision = 1; lease_duration_ms = 100L }
  in
  outcome (prepare state command);
  let state = step ~now:1000L state command in
  outcome (prepare ~now:999L state (progress "timed" 1));
  outcome (prepare ~now:1100L state (progress "timed" 1));
  let renew revision =
    Domain_command.Ticket_renew_lease
      { id = ticket "timed"; token = 1; expected_lease_revision = revision }
  in
  let state = step ~now:1050L state (renew 1) in
  outcome (prepare ~now:1051L state (renew 1));
  outcome (prepare ~now:1100L state (progress "timed" 1));
  outcome (prepare ~now:1150L state (progress "timed" 1));
  let state = step ~now:1200L state (Ticket_release { id = ticket "timed"; token = 1 }) in
  let state = step state (claim "timed" 4) in
  outcome (prepare state (progress "timed" 1));
  outcome (prepare state (progress "timed" 2));
  [%expect
    {|
    Invalid_argument
    Stale_claim
    Stale_claim
    Conflict
    ok
    Stale_claim
    Stale_claim
    ok
    |}]
;;

let%expect_test "claim next enforces durable pools and never overwrites an attempt" =
  let state =
    step (empty ()) register
    |> fun s -> step s (create "a") |> fun s -> step s (create "b")
  in
  let state =
    step state (Agent_run (Pool_put { name = "build"; expected_revision = 0; limit = 1 }))
  in
  let policy id =
    Domain_command.Agent_run
      (Ticket_policy_put
         { ticket = ticket id
         ; expected_revision = 0
         ; required_capabilities = [ "ocaml" ]
         ; pools = [ "build" ]
         })
  in
  let state = step state (policy "a") |> fun s -> step s (policy "b") in
  let next id =
    Domain_command.Claim_next
      { attempt = Attempt.Id.of_string id |> unwrap
      ; run
      ; project = None
      ; lease_duration_ms = None
      }
  in
  let p = prepare ~run state (next "first") |> unwrap in
  print_endline (Json.text (Json.field (State.result p) "kind"));
  let state = State.candidate p in
  outcome (prepare ~run state (next "first"));
  let p = prepare ~run state (next "second") |> unwrap in
  print_endline (Json.text (Json.field (State.result p) "kind"));
  let state = step ~run state (Ticket_release { id = ticket "a"; token = 1 }) in
  let first =
    Agent_run.get_attempt (State.agent_runs state) (Attempt.Id.of_string "first" |> unwrap)
    |> Option.value_exn
  in
  print_s [%sexp (first.state : Attempt.State.t)];
  let p = prepare ~run state (next "third") |> unwrap in
  print_endline (Json.text (Json.field (State.result p) "kind"));
  [%expect
    {|
    selected
    Conflict
    empty
    Cancelled
    selected
    |}]
;;

let%expect_test "raw completion and later batch changes respect review gates" =
  let state = step (empty ()) (create "reviewed") in
  let policy =
    Domain_command.Evidence
      (Policy_put
         { ticket = ticket "reviewed"
         ; expected_revision = 0
         ; enabled = true
         ; reviewers = [ Named_actor actor ]
         ; separate_actor = false
         ; validators = []
         })
  in
  let complete =
    Domain_command.Ticket_update
      { id = ticket "reviewed"
      ; expected_revision = 1
      ; title = None
      ; description = None
      ; status = Some Done
      }
  in
  outcome (prepare state (Batch [ complete; policy ]));
  let state = step state policy in
  outcome (prepare state complete);
  print_s [%sexp (State.revision state : int)];
  [%expect
    {|
    Blocked
    Blocked
    2
    |}]
;;

let%expect_test
    "thread reply creates and attaches one scoped immutable discussion comment"
  =
  let board = Communication_id.Board.of_string "board" |> unwrap in
  let thread = Communication_id.Thread.of_string "thread" |> unwrap in
  let comment = Id.Comment.of_string "reply" |> unwrap in
  let state =
    step
      (empty ())
      (Communication
         (Board_put
            { id = board; expected_revision = 0; scope = Workspace; title = "Board" }))
  in
  let state =
    step
      state
      (Communication
         (Thread_put
            { id = thread
            ; expected_revision = 0
            ; board
            ; title = "Thread"
            ; participants = []
            ; mentions = []
            ; links = []
            ; state = Open
            ; pinned = false
            }))
  in
  let state =
    step
      state
      (Thread_reply
         { id = thread
         ; expected_revision = 1
         ; comment_id = Some comment
         ; reply_to = None
         ; kind = Comment
         ; body = "hello"
         })
  in
  let thread_record =
    Communication.get_thread (State.communication state) thread |> Option.value_exn
  in
  print_s [%sexp (thread_record.messages : Id.Comment.t list)];
  outcome
    (prepare
       state
       (Thread_reply
          { id = thread
          ; expected_revision = 2
          ; comment_id = None
          ; reply_to = Some (Id.Comment.of_string "missing" |> unwrap)
          ; kind = Comment
          ; body = "bad"
          }));
  [%expect
    {|
    (reply)
    Conflict
    |}]
;;

let%expect_test "template expansion is atomic, deterministic and budgets block allocation"
  =
  let resource = Id.Resource.of_string "workflow" |> unwrap in
  let spec =
    { Workflow_template.Spec.parameters = [ "name" ]
    ; nodes =
        [ { Workflow_template.Node.alias = "code"
          ; title = "Build {{name}}"
          ; description = ""
          ; depends_on = []
          ; parent = None
          ; capabilities = [ "ocaml" ]
          ; reviewers = []
          ; separate_actor = false
          }
        ]
    }
  in
  let template =
    Workflow_template.create ~resource ~resource_revision:1 ~spec |> unwrap
  in
  let state =
    step
      (empty ())
      (Resource_put
         { id = resource
         ; expected_revision = 0
         ; title = "Workflow"
         ; text = Json.canonical (Workflow_template.Spec.to_json spec)
         ; filename = None
         ; mime_type = None
         })
  in
  let state = step state (Policy (Template_register template)) in
  let command =
    Domain_command.Template_instantiate
      { template = resource
      ; template_revision = 1
      ; id = Workflow_template.Instance_id.of_string "instance" |> unwrap
      ; parameters = [ "name", "demo" ]
      }
  in
  let state = step state command in
  let state = step state command in
  let instance =
    Agent_run_policy.get_instance
      (State.policies state)
      (Workflow_template.Instance_id.of_string "instance" |> unwrap)
    |> Option.value_exn
  in
  print_s [%sexp (List.length instance.tickets : int)];
  let state = step state register in
  let state =
    step
      state
      (Policy
         (Budget_put
            { run
            ; revision = 1
            ; max_attempts = Some 1
            ; max_active_attempts = Some 1
            ; reported_token_limit = None
            ; reported_elapsed_ms_limit = None
            }))
  in
  let next id =
    Domain_command.Claim_next
      { attempt = Attempt.Id.of_string id |> unwrap
      ; run
      ; project = None
      ; lease_duration_ms = None
      }
  in
  let state = step ~run state (next "first") in
  outcome (prepare ~run state (next "second"));
  [%expect
    {|
    1
    Blocked
    |}]
;;

let%expect_test
    "review routing and published inputs share the immutable domain transaction"
  =
  let attempt = Attempt.Id.of_string "attempt" |> unwrap in
  let reviewer = Id.Actor.of_string "reviewer" |> unwrap in
  let resource id = Id.Resource.of_string id |> unwrap in
  let state =
    step (empty ()) register
    |> fun s -> step s (create "evidence") |> fun s -> step ~run s (claim "evidence" 1)
  in
  let state =
    step
      ~run
      state
      (Agent_run
         (Attempt_start
            { id = attempt; run; ticket = ticket "evidence"; token = 1; sessions = [] }))
  in
  let put id revision text =
    Domain_command.Resource_put
      { id = resource id
      ; expected_revision = revision
      ; title = id
      ; text
      ; filename = None
      ; mime_type = None
      }
  in
  let state =
    step state (put "schema" 0 "schema")
    |> fun s ->
    step s (put "input" 0 "source") |> fun s -> step s (put "output" 0 "result")
  in
  let pin id =
    let v = State.resource_version state (resource id) ~revision:None |> unwrap in
    { Evidence.Resource_pin.id = resource id; revision = v.revision; digest = v.digest }
  in
  let contract = Evidence_id.Contract.of_string "contract" |> unwrap in
  let manifest = Evidence_id.Manifest.of_string "manifest" |> unwrap in
  let cref = { Evidence.Contract_ref.id = contract; revision = 1 } in
  let mref = { Evidence.Manifest_ref.id = manifest; revision = 1 } in
  let state =
    step
      state
      (Evidence
         (Contract_put
            { id = contract
            ; expected_revision = 0
            ; schema_version = 1
            ; schema = pin "schema"
            ; required_inputs = [ "source" ]
            ; required_outputs = [ "result" ]
            }))
  in
  let state =
    step
      ~run
      state
      (Evidence
         (Manifest_publish
            { id = manifest
            ; expected_revision = 0
            ; schema_version = 1
            ; attempt
            ; ticket = ticket "evidence"
            ; contract = cref
            ; inputs = [ { name = "source"; pin = Resource (pin "input") } ]
            ; outputs = [ { name = "result"; pin = Resource (pin "output") } ]
            }))
  in
  let state =
    step
      state
      (Evidence
         (Policy_put
            { ticket = ticket "evidence"
            ; expected_revision = 0
            ; enabled = true
            ; reviewers = [ Role { name = "quality"; members = [ reviewer ] } ]
            ; separate_actor = true
            ; validators = []
            }))
  in
  let state =
    step
      ~run
      state
      (Evidence
         (Submit
            { ticket = ticket "evidence"
            ; expected_revision = 0
            ; manifest = mref
            ; review_request = None
            }))
  in
  let submission =
    Evidence.get_submission (State.evidence state) (ticket "evidence") |> Option.value_exn
  in
  let request =
    Communication.get_request
      (State.communication state)
      (Option.value_exn submission.review_request)
    |> Option.value_exn
  in
  print_s
    [%sexp
      (List.map request.deliveries ~f:(fun d -> d.recipient)
       : Communication.Recipient.t list)];
  let rejection = String.make 65_536 'x' in
  let state =
    step
      ~actor:reviewer
      state
      (Evidence
         (Review
            { id = Evidence_id.Review.of_string "reject" |> unwrap
            ; ticket = ticket "evidence"
            ; generation = 1
            ; verdict = Request_changes
            ; evidence = rejection
            ; comment = None
            }))
  in
  print_s [%sexp (List.length (Communication.requests (State.communication state)) : int)];
  let change_request =
    Communication.requests (State.communication state)
    |> List.find_exn ~f:(fun request ->
      Communication.Request.Kind.equal request.kind Blocker_resolution)
  in
  let comment =
    State.query
      state
      ~method_:"comment.get"
      ~params:
        (Json.obj
           [ "comment_id", Id.Comment.jsonaf_of_t change_request.message
           ; "max_bytes", Json.int (1024 * 1024)
           ])
    |> unwrap
  in
  let body = Json.text (Json.field (Json.field comment "data") "body") in
  print_s [%sexp (String.length body : int), (String.equal body rejection : bool)];
  outcome
    (prepare
       ~run
       state
       (Ticket_complete { id = ticket "evidence"; token = 1; evidence = "done" }));
  let state =
    step
      ~run
      state
      (Evidence
         (Submit
            { ticket = ticket "evidence"
            ; expected_revision = 2
            ; manifest = mref
            ; review_request = None
            }))
  in
  let state =
    step
      ~actor:reviewer
      state
      (Evidence
         (Review
            { id = Evidence_id.Review.of_string "approve" |> unwrap
            ; ticket = ticket "evidence"
            ; generation = 2
            ; verdict = Approve
            ; evidence = "accepted exact output"
            ; comment = None
            }))
  in
  let state =
    step
      ~run
      state
      (Evidence (Accept { ticket = ticket "evidence"; expected_revision = 3 }))
  in
  let submission =
    Evidence.get_submission (State.evidence state) (ticket "evidence") |> Option.value_exn
  in
  let resolved =
    Communication.get_request
      (State.communication state)
      (Option.value_exn submission.review_request)
    |> Option.value_exn
  in
  print_s
    [%sexp
      ((match resolved.status with
        | Resolved _ -> true
        | Open | Cancelled _ -> false)
       : bool)];
  let reconcile disposition =
    Domain_command.Evidence (Reconcile { serial = 1; expected_revision = 1; disposition })
  in
  let unrelated_run = Id.Run.of_string "unrelated-run" |> unwrap in
  let live_changed = step state (put "input" 1 "live source update") in
  outcome (prepare ~actor:reviewer ~run live_changed (reconcile Acknowledge));
  outcome (prepare live_changed (reconcile Acknowledge));
  outcome (prepare ~run:unrelated_run live_changed (reconcile Acknowledge));
  outcome
    (prepare
       ~run
       live_changed
       (reconcile (Continue "Keep the reviewed historical input")));
  let state =
    step
      ~run
      state
      (Ticket_complete { id = ticket "evidence"; token = 1; evidence = "accepted" })
  in
  let publication = prepare state (put "input" 1 "updated source") |> unwrap in
  let corrupt =
    match State.events publication with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if String.equal key "changes"
             then `Array (List.take (Json.list value) 1)
             else value )))
    | _ -> assert false
  in
  outcome (State.replay state corrupt);
  let state = State.candidate publication in
  let completed =
    List.find_exn (State.coordination_tickets state) ~f:(fun t ->
      Id.Ticket.equal t.Coordinator.Ticket.id (ticket "evidence"))
  in
  print_s [%sexp (completed.status : Domain_command.Status.t)];
  print_s
    [%sexp
      (List.length
         (Evidence.pending_reconciliations (State.evidence state) ~attempt:(Some attempt))
       : int)];
  let original = Evidence.get_manifest (State.evidence state) mref |> Option.value_exn in
  print_s
    [%sexp
      ((match (List.hd_exn original.inputs).pin with
        | Resource p -> p.revision
        | _ -> 0)
       : int)];
  outcome (prepare ~actor:reviewer ~run state (reconcile Acknowledge));
  outcome (prepare state (reconcile Acknowledge));
  outcome (prepare ~run:unrelated_run state (reconcile Acknowledge));
  outcome (prepare ~run state (reconcile (Revised mref)));
  outcome (prepare ~run state (reconcile Acknowledge));
  let replacement_run = Id.Run.of_string "replacement-run" |> unwrap in
  let replacement_attempt = Attempt.Id.of_string "replacement-attempt" |> unwrap in
  let state =
    step
      state
      (Agent_run
         (Register
            { id = replacement_run
            ; parent = None
            ; parent_stop_policy = Continue
            ; objective = "replacement"
            ; capabilities = []
            ; process_ref = None
            ; worktree_ref = None
            }))
    |> fun state ->
    step
      state
      (Ticket_update
         { id = ticket "evidence"
         ; expected_revision = 3
         ; title = None
         ; description = None
         ; status = Some Todo
         })
    |> fun state ->
    step
      ~run:replacement_run
      state
      (Claim_next
         { attempt = replacement_attempt
         ; run = replacement_run
         ; project = None
         ; lease_duration_ms = None
         })
  in
  let claim state =
    List.find_exn (State.coordination_tickets state) ~f:(fun item ->
      Id.Ticket.equal item.id (ticket "evidence"))
    |> fun item -> Option.value_exn item.Coordinator.Ticket.claim
  in
  let previous_claim = claim state in
  let state =
    step ~run state (reconcile (Continue "Preserve the completed historical result"))
  in
  let current_claim = claim state in
  print_s
    [%sexp
      (List.length
         (Evidence.pending_reconciliations (State.evidence state) ~attempt:(Some attempt))
       : int)
    , (Int.equal previous_claim.token current_claim.token
       && Option.equal Id.Run.equal previous_claim.run current_claim.run
       && Id.Actor.equal previous_claim.actor current_claim.actor
       : bool)];
  [%expect
    {|
    ((Actor reviewer))
    2
    (65536 true)
    Blocked
    true
    Conflict
    Stale_claim
    Stale_claim
    ok
    Corrupt_store
    Done
    1
    1
    Stale_claim
    Stale_claim
    Stale_claim
    Stale_claim
    ok
    (0 true)
    |}]
;;

let%expect_test "batch aliases preserve typed nested references and ordinary prose" =
  let params =
    Json.parse
      {|
    {"operations":[
      {"method":"board.put","as":"board","params":{"board_id":"b","expected_revision":"0","scope":{"kind":"workspace"},"title":"$board"}},
      {"method":"ticket.create","as":"task","params":{"ticket_id":"t","title":"$board"}},
      {"method":"thread.put","as":"thread","params":{"thread_id":"h","expected_revision":"0","board_id":"$board","title":"$task","participants":[],"mentions":[],"links":[{"kind":"ticket","id":"$task"}],"state":"open","pinned":false}},
      {"method":"thread.reply","as":"message","params":{"thread_id":"$thread","expected_revision":"1","comment_id":"c","body":"$task"}},
      {"method":"request.create","params":{"request_id":"q","thread_id":"$thread","kind":"review","comment_id":"$message","recipients":[{"kind":"actor","id":"worker"}],"teams":[],"resolver_id":"worker"}}
    ]}
  |}
    |> unwrap
  in
  let command = Domain_command.decode ~method_:"transaction.apply" ~params |> unwrap in
  let state = step (empty ()) command in
  let thread =
    Communication.get_thread
      (State.communication state)
      (Communication_id.Thread.of_string "h" |> unwrap)
    |> Option.value_exn
  in
  print_s [%sexp (thread.title : string), (thread.links : Entity_ref.t list)];
  let params =
    Json.parse
      {|
    {"operations":[
      {"method":"resource.put_text","as":"schema","params":{"resource_id":"r","expected_revision":"0","title":"R","text":"schema"}},
      {"method":"contract.put","params":{"id":"k","expected_revision":"0","schema_version":"1","schema":{"id":"$schema","revision":"1","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"required_inputs":[],"required_outputs":[]}}
    ]}
  |}
    |> unwrap
  in
  outcome (Domain_command.decode ~method_:"transaction.apply" ~params);
  [%expect
    {|
    ($task ((Ticket t)))
    ok
    |}]
;;

let%expect_test "registered attempts cannot complete without pinned provenance" =
  let state = step (empty ()) register |> fun s -> step s (create "provenance") in
  let attempt = Attempt.Id.of_string "provenance-attempt" |> unwrap in
  let state =
    step
      ~run
      state
      (Claim_next { attempt; run; project = None; lease_duration_ms = None })
  in
  outcome
    (prepare
       ~run
       state
       (Agent_run
          (Attempt_finish
             { id = attempt; expected_revision = 1; state = Completed; evidence = "done" })));
  outcome
    (prepare
       ~run
       state
       (Ticket_complete { id = ticket "provenance"; token = 1; evidence = "done" }));
  let plain = step (empty ()) (create "plain") |> fun s -> step s (claim "plain" 1) in
  outcome
    (prepare
       plain
       (Ticket_complete { id = ticket "plain"; token = 1; evidence = "done" }));
  [%expect
    {|
    Blocked
    Blocked
    ok
  |}]
;;

let%expect_test "tagged evidence pins and revised manifests resolve creation aliases" =
  let params =
    Json.parse
      {|
    {"operations":[
      {"method":"resource.put_text","as":"source","params":{"resource_id":"source-resource","expected_revision":"0","title":"Source","text":"source"}},
      {"method":"contract.put","as":"contract","params":{"id":"contract-id","expected_revision":"0","schema_version":"1","schema":{"id":"$source","revision":"1","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"required_inputs":[],"required_outputs":[]}},
      {"method":"decision.put","params":{"id":"decision","expected_revision":"0","scope":{"kind":"workspace"},"title":"Decision","rationale":["Resource",{"id":"$source","revision":"1","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"evidence":[["Contract",{"id":"$contract","revision":"1"}]],"affected":[],"supersedes":[]}},
      {"method":"input.changed","params":{"previous":["Resource",{"id":"$source","revision":"1","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"current":["Resource",{"id":"$source","revision":"2","digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}},
      {"method":"manifest.publish","as":"manifest","params":{"id":"manifest-id","expected_revision":"0","schema_version":"1","attempt":"attempt","ticket":"ticket","contract":{"id":"$contract","revision":"1"},"inputs":[],"outputs":[]}},
      {"method":"reconciliation.record","params":{"serial":"1","expected_revision":"1","disposition":["Revised",{"id":"$manifest","revision":"1"}]}}
    ]}
  |}
    |> unwrap
  in
  let command = Domain_command.decode ~method_:"transaction.apply" ~params |> unwrap in
  let _, params = Wire_command.encode command |> unwrap in
  let operations = Json.list (Json.field params "operations") in
  let params index = Json.field (List.nth_exn operations index) "params" in
  let pin_id value =
    match Json.list value with
    | [ _; record ] -> Json.text (Json.field record "id")
    | _ -> failwith "expected tagged pin"
  in
  print_s
    [%sexp
      (pin_id (Json.field (params 2) "rationale") : string)
    , (pin_id (List.hd_exn (Json.list (Json.field (params 2) "evidence"))) : string)
    , (pin_id (Json.field (params 3) "previous") : string)
    , (pin_id (Json.field (params 3) "current") : string)
    , (pin_id (Json.field (params 5) "disposition") : string)];
  [%expect
    {| (source-resource contract-id source-resource source-resource manifest-id) |}]
;;

let%expect_test "subscription activity retains both replaced scope and thread links" =
  let project name = Id.Project.of_string name |> unwrap in
  let board name = Communication_id.Board.of_string name |> unwrap in
  let thread name = Communication_id.Thread.of_string name |> unwrap in
  let subscription = Communication_id.Subscription.of_string "subscription" |> unwrap in
  let state = step (empty ()) (create "old-linked") in
  let state = step state (create "new-linked") in
  let state =
    List.fold [ "old"; "new" ] ~init:state ~f:(fun state name ->
      let state =
        step state (Project_create { id = project name; title = name; description = "" })
      in
      let state =
        step
          state
          (Communication
             (Board_put
                { id = board name
                ; expected_revision = 0
                ; scope = Project (project name)
                ; title = name
                }))
      in
      step
        state
        (Communication
           (Thread_put
              { id = thread name
              ; expected_revision = 0
              ; board = board name
              ; title = name
              ; participants = []
              ; mentions = []
              ; links = [ Ticket (ticket (name ^ "-linked")) ]
              ; state = Open
              ; pinned = false
              })))
  in
  let put name revision =
    Domain_command.Communication
      (Subscription_put
         { id = subscription
         ; expected_revision = revision
         ; recipient = Actor actor
         ; filter =
             { scope = Some (Project (project name))
             ; thread = Some (thread name)
             ; kinds = []
             }
         ; active = true
         })
  in
  let state = step state (put "old" 0) in
  let after = State.revision state in
  let state = step state (put "new" 1) in
  List.iter
    [ Entity_ref.Project (project "old")
    ; Project (project "new")
    ; Ticket (ticket "old-linked")
    ; Ticket (ticket "new-linked")
    ]
    ~f:(fun target ->
      let result =
        State.query
          state
          ~method_:"activity.since"
          ~params:
            (Json.obj
               [ "target", Entity_ref.jsonaf_of_t target; "after", Json.int after ])
        |> unwrap
      in
      print_s
        [%sexp
          (target : Entity_ref.t)
        , (List.length (Json.list (Json.field (Json.field result "data") "items")) : int)]);
  [%expect
    {|
    ((Project old) 1)
    ((Project new) 1)
    ((Ticket old-linked) 1)
    ((Ticket new-linked) 1)
  |}]
;;

let%expect_test
    "new claims validate known run ownership and retain full reassignment reasons"
  =
  let other = Id.Actor.of_string "other" |> unwrap in
  let other_run = Id.Run.of_string "other-run" |> unwrap in
  let state =
    step (empty ()) (create "owned") |> fun state -> step state (claim "owned" 1)
  in
  let state = step state register in
  let state =
    step
      ~actor:other
      state
      (Agent_run
         (Register
            { id = other_run
            ; parent = None
            ; parent_stop_policy = Continue
            ; objective = "other"
            ; capabilities = []
            ; process_ref = None
            ; worktree_ref = None
            }))
  in
  let reassign claimant_run reason =
    Domain_command.Ticket_reassign
      { id = ticket "owned"
      ; expected_revision = 2
      ; claimant = Some actor
      ; claimant_run = Some claimant_run
      ; reason
      }
  in
  outcome (prepare state (reassign other_run "wrong actor"));
  let unclaimed = step state (create "direct-claim") in
  outcome (prepare ~run:other_run unclaimed (claim "direct-claim" 1));
  let terminal =
    step
      state
      (Agent_run
         (Transition
            { id = run; expected_revision = 1; status = Completed; evidence = "finished" }))
  in
  outcome (prepare terminal (reassign run "terminal"));
  let unclaimed = step terminal (create "direct-claim") in
  outcome (prepare ~run unclaimed (claim "direct-claim" 1));
  let reason = String.make 65_536 'x' in
  let prepared = prepare state (reassign run reason) |> unwrap in
  let corrupt =
    match State.events prepared with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           if String.equal key "changes"
           then
             ( key
             , `Array
                 (List.map (Json.list value) ~f:(function
                    | `Array [ `String "Ticket_put"; `Object fields ] ->
                      `Array
                        [ Json.string "Ticket_put"
                        ; Json.obj
                            (List.map fields ~f:(fun (key, value) ->
                               if String.equal key "claim"
                               then
                                 ( key
                                 , Json.obj
                                     (match value with
                                      | `Object fields ->
                                        List.Assoc.add
                                          fields
                                          ~equal:String.equal
                                          "run_id"
                                          (Id.Run.jsonaf_of_t other_run)
                                      | _ -> failwith "expected claim") )
                               else key, value))
                        ]
                    | value -> value)) )
           else key, value))
    | _ -> failwith "expected event object"
  in
  outcome (State.replay state corrupt);
  let result =
    State.query
      (State.candidate prepared)
      ~method_:"comment.list"
      ~params:
        (Json.obj
           [ "ticket_id", Id.Ticket.jsonaf_of_t (ticket "owned")
           ; "max_bytes", Json.int (1024 * 1024)
           ])
    |> unwrap
  in
  let body =
    Json.list (Json.field (Json.field result "data") "items")
    |> List.hd_exn
    |> fun comment -> Json.text (Json.field comment "body")
  in
  print_s [%sexp (String.length body : int), (String.equal body reason : bool)];
  [%expect
    {|
    Conflict
    Conflict
    Conflict
    Conflict
    Conflict
    (65536 true)
  |}]
;;

let%expect_test "typed tombstones reject supplied text before wire encoding" =
  let comment = Id.Comment.of_string "tombstone" |> unwrap in
  let state =
    step
      (empty ())
      (Comment_add
         { id = Some comment
         ; target = Workspace
         ; reply_to = None
         ; kind = Comment
         ; body = "original"
         })
  in
  let command =
    Domain_command.Comment_edit
      { id = comment; expected_revision = 1; body = "discarded"; tombstone = true }
  in
  outcome (Wire_command.encode command);
  outcome (State.prepare state command ~actor ~timestamp);
  outcome
    (Wire_command.encode
       (Comment_edit { id = comment; expected_revision = 1; body = ""; tombstone = true }));
  [%expect
    {|
    Invalid_argument
    Corrupt_store
    ok
  |}]
;;

let%expect_test "attempt replay checks allocation budgets before each new attempt" =
  let first = Attempt.Id.of_string "budget-first" |> unwrap in
  let second = Attempt.Id.of_string "budget-second" |> unwrap in
  let state =
    step (empty ()) register
    |> fun state ->
    step state (create "budget-a")
    |> fun state ->
    step state (create "budget-b")
    |> fun state ->
    step
      ~run
      state
      (Claim_next { attempt = first; run; project = None; lease_duration_ms = None })
    |> fun state -> step ~run state (claim "budget-b" 1)
  in
  let budget max_attempts max_active_attempts =
    Domain_command.Policy
      (Budget_put
         { run
         ; revision = 1
         ; max_attempts = Some max_attempts
         ; max_active_attempts = Some max_active_attempts
         ; reported_token_limit = None
         ; reported_elapsed_ms_limit = None
         })
  in
  let start =
    Domain_command.Agent_run
      (Attempt_start
         { id = second; run; ticket = ticket "budget-b"; token = 1; sessions = [] })
  in
  let permitted = step state (budget 2 2) in
  let prepared = prepare ~run permitted start |> unwrap in
  List.iter
    [ 1, 2; 2, 1 ]
    ~f:(fun (max_attempts, max_active_attempts) ->
      let exhausted = step state (budget max_attempts max_active_attempts) in
      outcome (prepare ~run exhausted start);
      outcome (State.replay exhausted (State.events prepared)));
  outcome
    (prepare
       ~run
       (State.candidate prepared)
       (Agent_run
          (Attempt_finish
             { id = second
             ; expected_revision = 1
             ; state = Cancelled
             ; evidence = "stopped"
             })));
  [%expect
    {|
    Blocked
    Blocked
    Blocked
    Blocked
    ok
  |}]
;;

let%expect_test "workflow capabilities remain valid in any declared order" =
  let resource = Id.Resource.of_string "unordered-template" |> unwrap in
  let spec =
    { Workflow_template.Spec.parameters = []
    ; nodes =
        [ { Workflow_template.Node.alias = "node"
          ; title = "Work"
          ; description = ""
          ; depends_on = []
          ; parent = None
          ; capabilities = [ "z"; "a" ]
          ; reviewers = []
          ; separate_actor = false
          }
        ]
    }
  in
  let template =
    Workflow_template.create ~resource ~resource_revision:1 ~spec |> unwrap
  in
  let state =
    step
      (empty ())
      (Resource_put
         { id = resource
         ; expected_revision = 0
         ; title = "Template"
         ; text = Json.canonical (Workflow_template.Spec.to_json spec)
         ; filename = None
         ; mime_type = None
         })
    |> fun state -> step state (Policy (Template_register template))
  in
  let id = Workflow_template.Instance_id.of_string "unordered-instance" |> unwrap in
  let command =
    Domain_command.Template_instantiate
      { template = resource; template_revision = 1; id; parameters = [] }
  in
  let state = step state command |> fun state -> step state command in
  let instance =
    Agent_run_policy.get_instance (State.policies state) id |> Option.value_exn
  in
  let planned = List.hd_exn instance.tickets in
  let policy =
    Agent_run.get_ticket_policy (State.agent_runs state) planned.ticket
    |> Option.value_exn
  in
  print_s [%sexp (policy.required_capabilities : string list)];
  [%expect {| (z a) |}]
;;
