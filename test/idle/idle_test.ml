open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let json text = Json.parse text |> ok
let actor = Id.Actor.of_string "worker" |> ok
let run = Id.Run.of_string "run" |> ok
let timestamp = "2026-11-03T00:00:00Z"
let command method_ text = Domain_command.decode ~method_ ~params:(json text) |> ok

let prepare state command =
  State.prepare state ~run command ~actor ~timestamp ~now_unix_ms:100L
;;

let submit state command =
  State.prepare_submission state ~run command ~actor ~timestamp ~now_unix_ms:100L
;;

let step state method_ text =
  let prepared = prepare state (command method_ text) |> ok in
  let next = State.candidate prepared in
  let replayed = State.replay state (State.events prepared) |> ok in
  if
    not
      (String.equal
         (Json.canonical (State.to_json next))
         (Json.canonical (State.to_json replayed)))
  then failwith "prepared/replayed state differs";
  next
;;

let fixture () =
  State.empty ~workspace:(Id.Workspace.of_string "idle" |> ok) ~name:"Idle"
  |> ok
  |> fun state ->
  step
    state
    "run.register"
    {|{"target_run_id":"run","objective":"Work","capabilities":["ocaml"]}|}
;;

let claim = command "ticket.claim_next" {|{"target_run_id":"run","attempt_id":"attempt"}|}

let query state method_ text =
  State.query state ~method_ ~params:(json text) ~now_unix_ms:100L
  |> ok
  |> fun result -> Json.field result "data"
;;

let ids state method_ text =
  Json.list (Json.field (query state method_ text) "items")
  |> List.map ~f:(fun item -> Json.text (Json.field item "ticket_id"))
;;

let report = function
  | Ok _ -> print_endline "ok"
  | Error problem -> print_endline (Problem.wire_name problem.Problem.kind)
;;

let%expect_test
    "submission observes emptiness; deliberate transaction and preflight stay durable \
     candidates"
  =
  let state = fixture () in
  let bytes = Json.canonical (State.to_json state) in
  List.iter
    [ submit state claim; submit state claim ]
    ~f:(fun outcome ->
      match ok outcome with
      | State.Submission.Observed observation ->
        printf
          "observed=%d kind=%s unchanged=%b\n"
          (State.Observation.workspace_revision observation)
          (Json.text (Json.field (State.Observation.result observation) "kind"))
          (String.equal bytes (Json.canonical (State.to_json state)))
      | Prepared _ -> failwith "empty standalone created a durable candidate");
  List.iter [ claim; Domain_command.Batch [ claim ] ] ~f:(fun command ->
    let prepared = prepare state command |> ok in
    printf
      "transaction=%d changes=%d blobs=%d\n"
      (State.revision (State.candidate prepared))
      (List.length (Json.list (Json.field (State.events prepared) "changes")))
      (List.length (State.blobs prepared)));
  (match submit state (Domain_command.Batch [ claim ]) |> ok with
   | Prepared prepared ->
     printf "submitted batch=%d\n" (State.revision (State.candidate prepared))
   | Observed _ -> failwith "explicit batch became nondurable");
  [%expect
    {|
    observed=1 kind=empty unchanged=true
    observed=1 kind=empty unchanged=true
    transaction=2 changes=1 blobs=0
    transaction=2 changes=1 blobs=0
    submitted batch=2
  |}]
;;

let%expect_test
    "empty attempt identity is unused until selection; existing attempt is never adopted"
  =
  let state = fixture () in
  ignore (submit state claim |> ok : State.Submission.t);
  printf "attempts=%d\n" (List.length (Agent_run.attempts (State.agent_runs state)));
  let available = step state "ticket.create" {|{"ticket_id":"a","title":"A"}|} in
  (match submit available claim |> ok with
   | Observed _ -> failwith "new work was not reevaluated"
   | Prepared prepared ->
     let next = State.candidate prepared in
     let result = State.result prepared in
     printf
       "selected=%s attempts=%d replay=%b\n"
       (Json.text (Json.field (Json.field result "claim") "ticket_id"))
       (List.length (Agent_run.attempts (State.agent_runs next)))
       (String.equal
          (Json.canonical (State.to_json next))
          (Json.canonical
             (State.to_json (State.replay available (State.events prepared) |> ok))));
     report (submit next claim));
  [%expect
    {|
    attempts=0
    selected=a attempts=1 replay=true
    Conflict
  |}]
;;

let%expect_test
    "run-aware ready and readiness share capability admission; unknown selectors reject"
  =
  let state =
    fixture ()
    |> fun s ->
    step s "ticket.create" {|{"ticket_id":"a","title":"A"}|}
    |> fun s ->
    step
      s
      "allocation.ticket_policy_put"
      {|{"ticket_id":"a","expected_revision":"0","required_capabilities":["ocaml"],"pools":[]}|}
    |> fun s -> step s "run.register" {|{"target_run_id":"bad","objective":"Other"}|}
  in
  print_s [%sexp (ids state "ticket.ready" "{}" : string list)];
  print_s [%sexp (ids state "ticket.ready" {|{"target_run_id":"bad"}|} : string list)];
  print_s [%sexp (ids state "ticket.ready" {|{"target_run_id":"run"}|} : string list)];
  let readiness =
    query state "ticket.readiness" {|{"ticket_id":"a","target_run_id":"bad"}|}
  in
  printf
    "ready=%b reason=%s\n"
    (match Json.field readiness "ready" with
     | `True -> true
     | `False -> false
     | _ -> failwith "boolean required")
    (Json.text
       (Json.field
          (Json.field (List.hd_exn (Json.list (Json.field readiness "reasons"))) "reason")
          "kind"));
  report
    (State.query
       state
       ~method_:"ticket.ready"
       ~params:(json {|{"target_run_id":"unknown"}|}));
  report
    (State.query
       state
       ~method_:"ticket.readiness"
       ~params:(json {|{"ticket_id":"a","target_run_id":"unknown"}|}));
  [%expect
    {|
    (a)
    ()
    (a)
    ready=false reason=missing_capability
    Not_found
    Not_found
  |}]
;;

let%expect_test "run attempt budget and terminal status exclude preview and selection" =
  let state =
    fixture () |> fun s -> step s "ticket.create" {|{"ticket_id":"a","title":"A"}|}
  in
  let selected =
    match submit state claim |> ok with
    | Prepared p -> p
    | Observed _ -> failwith "expected work"
  in
  let state =
    State.candidate selected
    |> fun s ->
    step s "ticket.finish" {|{"ticket_id":"a","token":"1","evidence":"Checked"}|}
    |> fun s ->
    step s "ticket.create" {|{"ticket_id":"b","title":"B"}|}
    |> fun s ->
    step
      s
      "run.budget_put"
      {|{"target_run_id":"run","expected_revision":"0","max_attempts":"1","max_active_attempts":null,"reported_token_limit":null,"reported_elapsed_ms_limit":null}|}
  in
  printf
    "budget ready=%d\n"
    (List.length (ids state "ticket.ready" {|{"target_run_id":"run"}|}));
  let next =
    command "ticket.claim_next" {|{"target_run_id":"run","attempt_id":"second"}|}
  in
  let show state =
    match submit state next |> ok with
    | Prepared _ -> failwith "ineligible selection"
    | Observed observation ->
      let e = Json.field (State.Observation.result observation) "explanation" in
      let kinds =
        Json.list (Json.field e "reasons")
        |> List.map ~f:(fun r -> Json.text (Json.field r "kind"))
      in
      print_s [%sexp (kinds : string list)]
  in
  show state;
  let state =
    step
      state
      "run.transition"
      {|{"target_run_id":"run","expected_revision":"1","status":"completed","evidence":"Stopped"}|}
  in
  printf
    "terminal ready=%d\n"
    (List.length (ids state "ticket.ready" {|{"target_run_id":"run"}|}));
  show state;
  [%expect
    {|
    budget ready=0
    (completed)
    terminal ready=0
    (completed run_terminal)
  |}]
;;

let%expect_test
    "leaf filter preserves unfiltered default; claimed and canceled diagnoses are \
     explicit"
  =
  let state =
    fixture ()
    |> fun s ->
    step s "ticket.create" {|{"ticket_id":"parent","title":"Parent"}|}
    |> fun s ->
    step
      s
      "ticket.create"
      {|{"ticket_id":"child","title":"Child","parent_ticket_id":"parent"}|}
    |> fun s ->
    step
      s
      "ticket.hold"
      {|{"ticket_id":"child","expected_revision":"1","reason":"Waiting"}|}
    |> fun s ->
    step s "ticket.create" {|{"ticket_id":"canceled","title":"Canceled"}|}
    |> fun s ->
    step
      s
      "ticket.update"
      {|{"ticket_id":"canceled","expected_revision":"1","status":"canceled"}|}
  in
  print_s [%sexp (ids state "ticket.ready" {|{"target_run_id":"run"}|} : string list)];
  print_s
    [%sexp
      (ids state "ticket.ready" {|{"target_run_id":"run","leaf_only":true}|}
       : string list)];
  let leaf =
    command
      "ticket.claim_next"
      {|{"target_run_id":"run","attempt_id":"leaf","leaf_only":true}|}
  in
  (match submit state leaf |> ok with
   | Prepared _ -> failwith "leaf selected held child/parent"
   | Observed o ->
     let e = Json.field (State.Observation.result o) "explanation" in
     print_s
       [%sexp
         (List.map
            (Json.list (Json.field e "reasons"))
            ~f:(fun r -> Json.text (Json.field r "kind"))
          : string list)]);
  [%expect
    {|
    (parent)
    ()
    (canceled blocked parent_filtered)
  |}]
;;

let%expect_test "only exact standalone empty acknowledgement may omit durable publication"
  =
  let explanation =
    Allocation.Explanation.create ~captured_workspace_revision:7 ~candidates:[] ~limits:[]
    |> ok
    |> Allocation.Explanation.to_json
  in
  let empty = Json.obj [ "kind", Json.string "empty"; "explanation", explanation ] in
  let envelope data meta =
    Api_response.of_json (Json.obj [ "data", data; "meta", json meta ]) |> ok
  in
  let show method_ response =
    match Mutation_acknowledgement.of_response response ~method_ with
    | Ok (Observed_empty _) -> print_endline "observed"
    | Ok (Committed _) -> print_endline "committed"
    | Error p -> print_endline (Problem.wire_name p.kind)
  in
  show "ticket.claim_next" (envelope empty {|{"workspace_revision":"7","durable":false}|});
  show "ticket.claim_next" (envelope empty {|{"workspace_revision":"8","durable":false}|});
  show "ticket.claim_next" (envelope empty {|{"workspace_revision":"7","durable":true}|});
  show
    "ticket.claim_next"
    (envelope
       empty
       {|{"workspace_revision":"7","durable":false,"query_scope":"runs","query_revision":"1"}|});
  show "ticket.claim_next" (envelope empty {|{"workspace_revision":"7"}|});
  show "ticket.start" (envelope empty {|{"workspace_revision":"7","durable":false}|});
  show
    "transaction.apply"
    (envelope (Json.obj []) {|{"workspace_revision":"7","durable":true}|});
  show
    "ticket.claim_next"
    (envelope
       (Json.obj
          [ "kind", Json.string "empty"; "explanation", explanation; "extra", `True ])
       {|{"workspace_revision":"7","durable":false}|});
  show
    "ticket.claim_next"
    (envelope
       (json
          {|{"kind":"selected","claim":{"ticket_id":"a","token":"1"},"attempt":{"attempt_id":"a","revision":"1","state":"running"}}|})
       {|{"workspace_revision":"7","durable":false}|});
  [%expect
    {|
    observed
    Outcome_unknown
    Outcome_unknown
    Outcome_unknown
    Outcome_unknown
    Outcome_unknown
    committed
    Outcome_unknown
    Outcome_unknown
  |}]
;;

let%expect_test "empty observation bypasses exhausted planning commit admission" =
  let initial = fixture () in
  let event = State.events (prepare initial (Domain_command.Batch [ claim ]) |> ok) in
  let state =
    List.range 2 100001
    |> List.fold ~init:initial ~f:(fun state revision ->
      let event =
        match event with
        | `Object fields ->
          Json.obj
            (List.Assoc.add fields ~equal:String.equal "revision" (Json.int revision))
        | _ -> failwith "event object required"
      in
      State.replay state event |> ok)
  in
  printf "capture=%d\n" (State.revision state);
  report (prepare state (Domain_command.Batch [ claim ]));
  (match submit state claim |> ok with
   | Observed observation ->
     printf "observed=%d\n" (State.Observation.workspace_revision observation)
   | Prepared _ -> failwith "exhausted empty became a durable candidate");
  [%expect
    {|
    capture=100000
    Invalid_argument
    observed=100000
  |}]
;;

let%expect_test
    "allocation diagnoses reject noncanonical examples and duplicate input tickets"
  =
  let malformed =
    [ {|{"captured_workspace_revision":"1","candidate_count":"2","reasons":[{"kind":"completed","count":"2","example_ticket_ids":["z","a"],"omitted_examples":"0"}],"run_limits":[]}|}
    ; {|{"captured_workspace_revision":"1","candidate_count":"1","reasons":[{"kind":"completed","count":"1","example_ticket_ids":["a"],"omitted_examples":"1"}],"run_limits":[]}|}
    ; {|{"captured_workspace_revision":"1","candidate_count":"1","reasons":[{"kind":"not_ready","count":"1","example_ticket_ids":["a"],"omitted_examples":"0"}],"run_limits":[]}|}
    ]
  in
  List.iter malformed ~f:(fun bytes ->
    report (Api_codec.decode Allocation.Explanation.codec (json bytes)));
  let candidate =
    { Allocation.Explanation.Candidate.ticket = Id.Ticket.of_string "a" |> ok
    ; exclusions = [ Completed ]
    }
  in
  report
    (Allocation.Explanation.create
       ~captured_workspace_revision:1
       ~candidates:[ candidate; candidate ]
       ~limits:[]);
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
  |}]
;;
