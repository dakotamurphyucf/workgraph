open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error error -> failwith error.Problem.message
;;

let json text = Json.parse text |> ok
let actor = Id.Actor.of_string "lead" |> ok

let prepare ?run ?now_unix_ms state method_ params =
  let command = Domain_command.decode ~method_ ~params:(json params) |> ok in
  State.prepare ?run ?now_unix_ms state command ~actor ~timestamp:"observed"
;;

let step ?run ?now_unix_ms state method_ params =
  let prepared = prepare ?run ?now_unix_ms state method_ params |> ok in
  let replayed = State.replay state (State.events prepared) |> ok in
  assert (
    String.equal
      (Json.canonical (State.to_json replayed))
      (Json.canonical (State.to_json (State.candidate prepared))));
  State.candidate prepared
;;

let query state method_ params =
  State.query state ~method_ ~params:(json params)
  |> ok
  |> fun response -> Option.value (Json.optional response "data") ~default:response
;;

let fixture () =
  State.empty ~workspace:(Id.Workspace.of_string "completion" |> ok) ~name:"Completion"
  |> ok
  |> fun state -> step state "project.create" {|{"project_id":"p","title":"Project"}|}
;;

let project state = query state "project.get" {|{"project_id":"p"}|}
let project_revision state = Json.field (project state) "revision" |> Json.text
let readiness state = query state "project.readiness" {|{"project_id":"p"}|}
let count data key = Json.field (Json.field data "counts") key |> Json.integer

let flag data key =
  match Json.field data key with
  | `True -> true
  | `False -> false
  | _ -> failwith "boolean required"
;;

let page_count data = Json.field data "items" |> Json.list |> List.length

let finish ?(handoff = {|{"summary":"Complete","next_steps":"Review"}|}) state =
  sprintf
    {|{"project_id":"p","expected_revision":"%s","evidence":"Tests passed","handoff":%s}|}
    (project_revision state)
    handoff
;;

let assert_kind kind = function
  | Error problem -> assert (Problem.equal_kind problem.Problem.kind kind)
  | Ok _ -> failwith "unexpected acceptance"
;;

let rec replace_field value key f =
  match value with
  | `Object fields ->
    Json.obj
      (List.map fields ~f:(fun (name, value) ->
         name, if String.equal name key then f value else replace_field value key f))
  | `Array values -> `Array (List.map values ~f:(fun value -> replace_field value key f))
  | `String _ | `Number _ | `True | `False | `Null -> value
;;

let set value key item =
  match value with
  | `Object fields -> Json.obj (List.Assoc.add fields key item ~equal:String.equal)
  | _ -> failwith "object required"
;;

let%expect_test "archived unfinished members block both Done entry points" =
  let state =
    fixture ()
    |> fun state ->
    step state "ticket.create" {|{"ticket_id":"t","project_id":"p","title":"Task"}|}
    |> fun state ->
    step
      state
      "ticket.archive"
      {|{"ticket_id":"t","expected_revision":"1","archived":true}|}
    |> fun state ->
    step
      state
      "milestone.create"
      {|{"milestone_id":"m","project_id":"p","title":"Milestone"}|}
    |> fun state ->
    step
      state
      "milestone.archive"
      {|{"milestone_id":"m","expected_revision":"1","archived":true}|}
  in
  let report = readiness state in
  assert (count report "unfinished_tickets" = 1);
  assert (count report "archived_tickets" = 1);
  assert (count report "unfinished_milestones" = 1);
  assert (count report "archived_milestones" = 1);
  assert (page_count report = 2);
  assert (not (flag report "can_complete"));
  let before = Json.canonical (State.to_json state) in
  assert_kind Blocked (prepare state "project.finish" (finish state));
  assert_kind
    Blocked
    (prepare
       state
       "project.update"
       {|{"project_id":"p","expected_revision":"1","status":"done"}|});
  assert (String.equal before (Json.canonical (State.to_json state)));
  let state =
    step
      state
      "ticket.update"
      {|{"ticket_id":"t","expected_revision":"2","status":"canceled"}|}
    |> fun state ->
    step
      state
      "milestone.update"
      {|{"milestone_id":"m","expected_revision":"2","status":"canceled"}|}
  in
  let report = readiness state in
  assert (flag report "can_complete");
  assert (count report "done_tickets" = 0);
  assert (count report "canceled_tickets" = 1);
  let completed = step state "project.finish" (finish state) in
  assert (String.equal (Json.field (project completed) "status" |> Json.text) "done");
  print_endline "archival retains blockers; canceled members are terminal and distinct";
  [%expect {|archival retains blockers; canceled members are terminal and distinct|}]
;;

let%expect_test "expired ownership and active attempts are not inferred stopped" =
  let run = Id.Run.of_string "run" |> ok in
  let state =
    fixture ()
    |> fun state ->
    step state "run.register" {|{"target_run_id":"run","objective":"Work"}|}
    |> fun state ->
    step state "ticket.create" {|{"ticket_id":"t","project_id":"p","title":"Task"}|}
    |> fun state ->
    step
      ~run
      ~now_unix_ms:100L
      state
      "ticket.start"
      {|{"ticket_id":"t","attempt_id":"a","lease_duration_ms":"10"}|}
  in
  let report = readiness state in
  assert (count report "claimed_tickets" = 1);
  assert (count report "active_attempts" = 1);
  assert_kind Blocked (prepare ~now_unix_ms:1000L state "project.finish" (finish state));
  let attempt = query state "attempt.get" {|{"attempt_id":"a"}|} in
  assert (String.equal (Json.field attempt "state" |> Json.text) "running");
  print_endline "expired lease does not complete, release or stop member work";
  [%expect {|expired lease does not complete, release or stop member work|}]
;;

let%expect_test "current Done member gates block aggregate completion" =
  let state =
    fixture ()
    |> fun state ->
    step state "ticket.create" {|{"ticket_id":"t","project_id":"p","title":"Task"}|}
    |> fun state ->
    step state "ticket.claim" {|{"ticket_id":"t","expected_revision":"1"}|}
    |> fun state ->
    step state "ticket.finish" {|{"ticket_id":"t","token":"1","evidence":"Task checked"}|}
  in
  assert (flag (readiness state) "can_complete");
  let ticket =
    query state "ticket.context" {|{"ticket_id":"t"}|}
    |> fun data -> Json.field data "ticket"
  in
  let revision = Json.field ticket "revision" |> Json.text in
  assert_kind
    Blocked
    (prepare
       state
       "transaction.apply"
       (sprintf
          {|{"operations":[
            {"method":"project.finish","params":{"project_id":"p","expected_revision":"1","evidence":"Project checked","handoff":{"summary":"Done","next_steps":""}}},
            {"method":"ticket.hold","params":{"ticket_id":"t","expected_revision":"%s","reason":"Late gate"}}
          ]}|}
          revision));
  let state =
    step
      state
      "ticket.hold"
      (sprintf
         {|{"ticket_id":"t","expected_revision":"%s","reason":"Needs review"}|}
         revision)
  in
  let report = readiness state in
  assert (count report "done_tickets" = 1);
  assert (count report "gated_tickets" = 1);
  assert_kind Blocked (prepare state "project.finish" (finish state));
  assert_kind
    Blocked
    (prepare
       state
       "project.update"
       {|{"project_id":"p","expected_revision":"1","status":"done"}|});
  print_endline "terminal status does not hide a current failed completion gate";
  [%expect {|terminal status does not hide a current failed completion gate|}]
;;

let%expect_test "member completion then project finish is atomic and replayable" =
  let state =
    fixture ()
    |> fun state ->
    step state "ticket.create" {|{"ticket_id":"t","project_id":"p","title":"Task"}|}
    |> fun state ->
    step state "ticket.claim" {|{"ticket_id":"t","expected_revision":"1"}|}
  in
  let state =
    step
      state
      "transaction.apply"
      {|{"operations":[
        {"method":"ticket.finish","params":{"ticket_id":"t","token":"1","evidence":"Task checked"}},
        {"method":"project.finish","params":{"project_id":"p","expected_revision":"1","evidence":"Project checked","handoff":{"summary":"Complete","next_steps":"Review"}}}
      ]}|}
  in
  assert (flag (readiness state) "can_complete");
  assert (String.equal (Json.field (project state) "status" |> Json.text) "done");
  print_endline "ordered member and project completion share one valid durable capture";
  [%expect {|ordered member and project completion share one valid durable capture|}]
;;

let%expect_test "final capture rejects late work and explicit reopen permits it" =
  let state = fixture () in
  let late =
    {|{"operations":[
      {"method":"project.finish","params":{"project_id":"p","expected_revision":"1","evidence":"Checked","handoff":{"summary":"Complete","next_steps":"Review"}}},
      {"method":"ticket.create","params":{"ticket_id":"late","project_id":"p","title":"Late work"}}
    ]}|}
  in
  assert_kind Blocked (prepare state "transaction.apply" late);
  let completed = step state "project.finish" (finish state) in
  assert_kind
    Blocked
    (prepare
       completed
       "ticket.create"
       {|{"ticket_id":"late","project_id":"p","title":"Late work"}|});
  assert_kind
    Blocked
    (prepare
       completed
       "milestone.create"
       {|{"milestone_id":"late","project_id":"p","title":"Late milestone"}|});
  let state =
    step
      state
      "transaction.apply"
      {|{"operations":[
        {"method":"project.finish","params":{"project_id":"p","expected_revision":"1","evidence":"Checked","handoff":{"summary":"Complete","next_steps":"Review"}}},
        {"method":"project.update","params":{"project_id":"p","expected_revision":"2","status":"todo"}},
        {"method":"ticket.create","params":{"ticket_id":"late","project_id":"p","title":"Late work"}}
      ]}|}
  in
  assert (String.equal (Json.field (project state) "status" |> Json.text) "todo");
  assert (not (flag (readiness state) "can_complete"));
  print_endline "late work rejects unless project is explicitly reopened in the batch";
  [%expect {|late work rejects unless project is explicitly reopened in the batch|}]
;;

let%expect_test "independent replay rejects forged Done and invalid final member state" =
  let initial = fixture () in
  let unfinished =
    step initial "ticket.create" {|{"ticket_id":"t","project_id":"p","title":"Task"}|}
  in
  let ordinary =
    prepare
      unfinished
      "project.update"
      {|{"project_id":"p","expected_revision":"1","title":"Renamed"}|}
    |> ok
  in
  let forged =
    replace_field (State.events ordinary) "status" (fun _ -> Json.string "done")
  in
  assert_kind Blocked (State.replay unfinished forged);
  let finishing = prepare initial "project.finish" (finish initial) |> ok in
  let creating =
    prepare
      initial
      "ticket.create"
      {|{"ticket_id":"late","project_id":"p","title":"Late"}|}
    |> ok
  in
  ignore (State.replay initial (State.events finishing) |> ok : State.t);
  ignore (State.replay initial (State.events creating) |> ok : State.t);
  let changes prepared = Json.field (State.events prepared) "changes" |> Json.list in
  let forged =
    set (State.events finishing) "changes" (`Array (changes finishing @ changes creating))
  in
  assert_kind Blocked (State.replay initial forged);
  print_endline "replay independently rejects forged transition and late-work batch";
  [%expect {|replay independently rejects forged transition and late-work batch|}]
;;

let%expect_test
    "handoff binds attribution and observed coverage and preserves rich context"
  =
  let run = Id.Run.of_string "run" |> ok in
  let state =
    fixture ()
    |> fun state ->
    step state "run.register" {|{"target_run_id":"run","objective":"Complete project"}|}
    |> fun state ->
    step
      state
      "resource.put_text"
      {|{"resource_id":"proof","expected_revision":"0","title":"Proof","text":"Evidence"}|}
  in
  let observed = State.revision state in
  let rich =
    sprintf
      {|{"summary":"Complete","next_steps":"Review","objective":"Deliver","completed":"All work","decisions":"Kept design","blockers":"","resource_ids":["proof"],"covers_through":"%d"}|}
      observed
  in
  let prepared = prepare ~run state "project.finish" (finish ~handoff:rich state) |> ok in
  let completed = State.replay state (State.events prepared) |> ok in
  let handoff = Json.field (project completed) "handoff" in
  assert (String.equal (Json.field handoff "actor_id" |> Json.text) "lead");
  assert (String.equal (Json.field handoff "run_id" |> Json.text) "run");
  assert (String.equal (Json.field handoff "timestamp" |> Json.text) "observed");
  assert (Json.integer (Json.field handoff "workspace_revision") = observed);
  assert (Json.integer (Json.field handoff "project_revision") = 2);
  let ordinary =
    prepare
      completed
      "project.update"
      {|{"project_id":"p","expected_revision":"2","title":"Renamed"}|}
    |> ok
  in
  assert_kind
    Corrupt_store
    (State.replay
       completed
       (replace_field (State.events ordinary) "handoff" (fun _ -> `Null)));
  let tamper f = replace_field (State.events prepared) "handoff" f in
  assert_kind
    Corrupt_store
    (State.replay state (tamper (fun h -> set h "actor_id" (Json.string "other"))));
  assert (
    Result.is_error
      (State.replay
         state
         (tamper (fun h -> set h "workspace_revision" (Json.int (observed + 1))))));
  assert (
    Result.is_error
      (State.replay
         state
         (tamper (fun h ->
            replace_field h "resource_ids" (fun _ -> `Array [ Json.string "missing" ])))));
  let state =
    step
      completed
      "project.update"
      {|{"project_id":"p","expected_revision":"2","status":"todo","title":"Next round"}|}
  in
  assert (
    String.equal
      (Json.canonical handoff)
      (Json.canonical (Json.field (project state) "handoff")));
  let state = step ~run state "project.finish" (finish state) in
  let retained = Json.field (Json.field (project state) "handoff") "content" in
  assert (String.equal (Json.field retained "objective" |> Json.text) "Deliver");
  assert (List.length (Json.field retained "resource_ids" |> Json.list) = 1);
  let state =
    step
      state
      "project.update"
      {|{"project_id":"p","expected_revision":"4","status":"todo"}|}
  in
  let state =
    step
      state
      "project.finish"
      (finish
         ~handoff:{|{"summary":"Again","next_steps":"","objective":"","resource_ids":[]}|}
         state)
  in
  let retained = Json.field (Json.field (project state) "handoff") "content" in
  assert (String.is_empty (Json.field retained "objective" |> Json.text));
  assert (List.is_empty (Json.field retained "resource_ids" |> Json.list));
  print_endline "attribution, observed coverage, replay pins and patch semantics retained";
  [%expect {|attribution, observed coverage, replay pins and patch semantics retained|}]
;;

let%expect_test "finish and continuation guard different captured revisions" =
  let state =
    fixture ()
    |> fun state ->
    step
      state
      "fact.put"
      {|{"scope":{"kind":"workspace"},"key":"unrelated","expected_revision":"0","value":true}|}
  in
  assert_kind
    Conflict
    (prepare
       state
       "project.finish"
       {|{"project_id":"p","expected_revision":"2","evidence":"Checked","handoff":{"summary":"Done","next_steps":""}}|});
  assert_kind
    Conflict
    (State.query
       state
       ~method_:"project.readiness"
       ~params:(json {|{"project_id":"p","at_revision":"1"}|}));
  let state = step state "project.finish" (finish state) in
  assert (String.equal (Json.field (project state) "status" |> Json.text) "done");
  print_endline "entity guard is independent of workspace continuation capture";
  [%expect {|entity guard is independent of workspace continuation capture|}]
;;

let%expect_test "readiness continuation uses a frozen current workspace capture" =
  let state =
    List.fold [ "a"; "b"; "c" ] ~init:(fixture ()) ~f:(fun state id ->
      step
        state
        "ticket.create"
        (sprintf {|{"ticket_id":"%s","project_id":"p","title":"Task"}|} id))
  in
  let first = query state "project.readiness" {|{"project_id":"p","limit":"1"}|} in
  assert (page_count first = 1);
  assert (Json.integer (Json.field first "next_offset") = 1);
  let params =
    sprintf
      {|{"project_id":"p","offset":"1","limit":"2","at_revision":"%d"}|}
      (State.revision state)
  in
  let second = query state "project.readiness" params in
  assert (page_count second = 2);
  (match Json.field second "next_offset" with
   | `Null -> ()
   | _ -> assert false);
  assert_kind
    Invalid_argument
    (State.query
       state
       ~method_:"project.readiness"
       ~params:(json {|{"project_id":"p","offset":"1"}|}));
  let changed =
    step
      state
      "fact.put"
      {|{"scope":{"kind":"workspace"},"key":"capture","expected_revision":"0","value":true}|}
  in
  assert_kind
    Conflict
    (State.query changed ~method_:"project.readiness" ~params:(json params));
  assert (
    List.mem
      (Query_pagination.supported_methods ())
      "project.readiness"
      ~equal:String.equal);
  print_endline "stable pages retain exact offsets; changed captures reject";
  [%expect {|stable pages retain exact offsets; changed captures reject|}]
;;

let%expect_test "unfinished cross-project transfers require destination reopening" =
  let state =
    fixture ()
    |> fun state ->
    step state "project.create" {|{"project_id":"other","title":"Other project"}|}
    |> fun state ->
    step
      state
      "ticket.create"
      {|{"ticket_id":"incoming","project_id":"other","title":"Incoming"}|}
  in
  let completed = step state "project.finish" (finish state) in
  let moving =
    {|{"ticket_id":"incoming","expected_revision":"1","project_id":"p","milestone_id":null,"parent_ticket_id":null}|}
  in
  assert_kind Blocked (prepare completed "ticket.move" moving);
  let reopened =
    step
      completed
      "transaction.apply"
      {|{"operations":[
        {"method":"project.update","params":{"project_id":"p","expected_revision":"2","status":"todo"}},
        {"method":"ticket.move","params":{"ticket_id":"incoming","expected_revision":"1","project_id":"p","milestone_id":null,"parent_ticket_id":null}}
      ]}|}
  in
  assert (count (readiness reopened) "unfinished_tickets" = 1);
  let other = query reopened "project.readiness" {|{"project_id":"other"}|} in
  assert (count other "tickets" = 0);
  print_endline "moves validate both captures and respect explicit destination reopen";
  [%expect {|moves validate both captures and respect explicit destination reopen|}]
;;
