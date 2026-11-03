open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let json text = Json.parse text |> ok
let actor = Id.Actor.of_string "worker" |> ok
let run = Id.Run.of_string "run" |> ok

let prepare state method_ params =
  State.prepare
    state
    ~run
    (Domain_command.decode ~method_ ~params:(json params) |> ok)
    ~actor
    ~timestamp:"fixture"
    ~now_unix_ms:100L
;;

let step state method_ params =
  let prepared = prepare state method_ params |> ok in
  let candidate = State.candidate prepared in
  let replayed = State.replay state (State.events prepared) |> ok in
  assert (
    String.equal
      (Json.canonical (State.to_json candidate))
      (Json.canonical (State.to_json replayed)));
  candidate
;;

let query state method_ params =
  State.query state ~method_ ~params:(json params) ~now_unix_ms:100L
  |> ok
  |> fun response -> Option.value (Json.optional response "data") ~default:response
;;

let fixture () =
  State.empty ~workspace:(Id.Workspace.of_string "hierarchy" |> ok) ~name:"Hierarchy"
  |> ok
  |> fun state -> step state "run.register" {|{"target_run_id":"run","objective":"Work"}|}
;;

let create ?parent state id =
  step
    state
    "ticket.create"
    (sprintf
       {|{"ticket_id":"%s","title":"%s"%s}|}
       id
       id
       (Option.value_map parent ~default:"" ~f:(sprintf {|,"parent_ticket_id":"%s"|})))
;;

let ticket state id =
  query state "ticket.context" (sprintf {|{"ticket_id":"%s"}|} id)
  |> fun data -> Json.field data "ticket"
;;

let revision state id = Json.field (ticket state id) "revision" |> Json.text
let claim state id = Json.field (ticket state id) "claim"

let dep state id prerequisite =
  step
    state
    "dependency.add"
    (sprintf {|{"ticket_id":"%s","prerequisite_id":"%s"}|} id prerequisite)
;;

let waive state id prerequisite =
  step
    state
    "dependency.waive"
    (sprintf
       {|{"ticket_id":"%s","prerequisite_id":"%s","expected_revision":"%s","reason":"Reviewed exception"}|}
       id
       prerequisite
       (revision state id))
;;

let policy
      ?(inheritance = "inherit")
      ?(children = "all_done")
      ?(reason = "Reviewed policy")
      state
      id
      rev
  =
  step
    state
    "ticket.hierarchy.put"
    (sprintf
       {|{"ticket_id":"%s","expected_revision":"%d","descendant_prerequisites":"%s","child_completion":"%s","reason":"%s"}|}
       id
       rev
       inheritance
       children
       reason)
;;

let complete state id =
  let state = step state "ticket.start" (sprintf {|{"ticket_id":"%s"}|} id) in
  let token = Json.field (claim state id) "token" |> Json.text in
  step
    state
    "ticket.finish"
    (sprintf {|{"ticket_id":"%s","token":"%s","evidence":"Checked"}|} id token)
;;

let cancel state id =
  step
    state
    "ticket.update"
    (sprintf
       {|{"ticket_id":"%s","expected_revision":"%s","status":"canceled"}|}
       id
       (revision state id))
;;

let readiness state id =
  query state "ticket.readiness" (sprintf {|{"ticket_id":"%s"}|} id)
;;

let reasons state id = Json.field (readiness state id) "reasons" |> Json.list

let kinds state id =
  List.map (reasons state id) ~f:(fun reason -> Json.field reason "kind" |> Json.text)
;;

let assert_kind kind = function
  | Error problem -> assert (Problem.equal_kind problem.Problem.kind kind)
  | Ok _ -> failwith "unexpected acceptance"
;;

let%expect_test
    "default isolation and opted ancestor contributions cross independent intermediates"
  =
  let state =
    fixture ()
    |> fun s ->
    create s "source"
    |> fun s ->
    create s "root"
    |> fun s ->
    create ~parent:"root" s "middle"
    |> fun s -> create ~parent:"middle" s "leaf" |> fun s -> dep s "root" "source"
  in
  assert (List.is_empty (reasons state "leaf"));
  let snapshot = query state "ticket.hierarchy.get" {|{"ticket_id":"root"}|} in
  (match Json.field snapshot "policy" with
   | `Null -> ()
   | _ -> failwith "stored policy should be absent");
  let state = policy state "root" 0 in
  print_endline (Json.canonical (`Array (reasons state "leaf")));
  assert_kind Blocked (prepare state "ticket.claim" {|{"ticket_id":"leaf"}|});
  assert_kind
    Blocked
    (prepare state "ticket.start" {|{"ticket_id":"leaf","attempt_id":"a"}|});
  let state = complete state "source" in
  (* Ancestor claim and unfinished children are local to that ancestor. *)
  let state = step state "ticket.claim" {|{"ticket_id":"root"}|} in
  assert (List.is_empty (reasons state "leaf"));
  ignore (step state "ticket.start" {|{"ticket_id":"leaf","attempt_id":"a"}|} : State.t);
  print_endline "ancestor ownership and unfinished children are not inherited";
  [%expect
    {|
    [{"ancestor_ticket_id":"root","kind":"inherited_prerequisite","prerequisite_ticket_id":"source"}]
    ancestor ownership and unfinished children are not inherited
  |}]
;;

let%expect_test
    "source-owned waivers and deterministic provenance keep canceled prerequisites strict"
  =
  let state =
    fixture ()
    |> fun s ->
    create s "source"
    |> fun s ->
    create s "root"
    |> fun s ->
    create ~parent:"root" s "middle"
    |> fun s ->
    create ~parent:"middle" s "leaf"
    |> fun s ->
    dep s "root" "source"
    |> fun s ->
    dep s "middle" "source"
    |> fun s ->
    dep s "leaf" "source" |> fun s -> policy s "root" 0 |> fun s -> policy s "middle" 0
  in
  assert (List.equal String.equal (kinds state "leaf") [ "prerequisite" ]);
  let state = waive state "leaf" "source" in
  let owner state =
    Json.field (List.hd_exn (reasons state "leaf")) "ancestor_ticket_id" |> Json.text
  in
  assert (String.equal (owner state) "middle");
  let state = waive state "middle" "source" in
  assert (String.equal (owner state) "root");
  let state =
    cancel state "source" |> fun s -> policy ~children:"done_or_canceled" s "root" 1
  in
  assert (String.equal (owner state) "root");
  let state = waive state "root" "source" in
  assert (List.is_empty (reasons state "leaf"));
  ignore (complete state "leaf" : State.t);
  print_endline
    "own direct, closest ancestor, farther ancestor, then no blocker; cancellation is \
     not a waiver";
  [%expect
    {|own direct, closest ancestor, farther ancestor, then no blocker; cancellation is not a waiver|}]
;;

let%expect_test
    "policy changes preserve existing claims but gate attempt, reassignment and finish"
  =
  let state =
    fixture ()
    |> fun s ->
    create s "source"
    |> fun s ->
    create s "parent"
    |> fun s ->
    create ~parent:"parent" s "leaf"
    |> fun s ->
    dep s "parent" "source" |> fun s -> step s "ticket.start" {|{"ticket_id":"leaf"}|}
  in
  let before_claim = Json.canonical (claim state "leaf") in
  let state = policy state "parent" 0 in
  assert (String.equal before_claim (Json.canonical (claim state "leaf")));
  assert_kind
    Blocked
    (prepare
       state
       "attempt.start"
       {|{"attempt_id":"late","target_run_id":"run","ticket_id":"leaf","token":"1"}|});
  assert_kind
    Blocked
    (prepare
       state
       "ticket.reassign"
       (sprintf
          {|{"ticket_id":"leaf","expected_revision":"%s","claimant_id":"worker","claimant_run_id":"run","reason":"Handoff"}|}
          (revision state "leaf")));
  assert_kind
    Blocked
    (prepare
       state
       "ticket.finish"
       {|{"ticket_id":"leaf","token":"1","evidence":"Checked"}|});
  let state =
    step state "ticket.release" {|{"ticket_id":"leaf","token":"1"}|}
    |> fun s -> complete s "source" |> fun s -> complete s "leaf"
  in
  assert (String.equal (Json.field (ticket state "leaf") "status" |> Json.text) "done");
  print_endline
    "current policy rechecked without rewriting claim; explicit release remains possible";
  [%expect
    {|current policy rechecked without rewriting claim; explicit release remains possible|}]
;;

let%expect_test "canceled child completion is an explicit local parent policy" =
  let state =
    fixture ()
    |> fun s ->
    create s "parent"
    |> fun s ->
    create ~parent:"parent" s "child"
    |> fun s ->
    create s "dependent"
    |> fun s ->
    dep s "dependent" "child"
    |> fun s ->
    cancel s "child" |> fun s -> step s "ticket.start" {|{"ticket_id":"parent"}|}
  in
  assert_kind
    Blocked
    (prepare
       state
       "ticket.finish"
       {|{"ticket_id":"parent","token":"1","evidence":"Checked"}|});
  let state =
    policy ~inheritance:"independent" ~children:"done_or_canceled" state "parent" 0
  in
  let state =
    step state "ticket.finish" {|{"ticket_id":"parent","token":"1","evidence":"Checked"}|}
  in
  assert (List.equal String.equal (kinds state "dependent") [ "prerequisite" ]);
  assert (
    String.equal (Json.field (ticket state "child") "status" |> Json.text) "canceled");
  print_endline
    "parent finishes with canceled child; sibling prerequisite remains blocked";
  [%expect {|parent finishes with canceled child; sibling prerequisite remains blocked|}]
;;

let%expect_test
    "effective cycles ignore completion and waivers and reject late reparenting"
  =
  let state =
    fixture ()
    |> fun s ->
    create s "parent"
    |> fun s ->
    create ~parent:"parent" s "child"
    |> fun s -> dep s "parent" "child" |> fun s -> waive s "parent" "child"
  in
  assert_kind
    Dependency_cycle
    (prepare
       state
       "ticket.hierarchy.put"
       {|{"ticket_id":"parent","expected_revision":"0","descendant_prerequisites":"inherit","child_completion":"all_done","reason":"Would inherit self"}|});
  let completed = complete state "child" in
  assert_kind
    Dependency_cycle
    (prepare
       completed
       "ticket.hierarchy.put"
       {|{"ticket_id":"parent","expected_revision":"0","descendant_prerequisites":"inherit","child_completion":"all_done","reason":"Still a cycle"}|});
  let state =
    fixture ()
    |> fun s ->
    create s "parent"
    |> fun s ->
    create s "unrelated"
    |> fun s -> dep s "parent" "unrelated" |> fun s -> policy s "parent" 0
  in
  assert_kind
    Dependency_cycle
    (prepare
       state
       "ticket.move"
       (sprintf
          {|{"ticket_id":"unrelated","expected_revision":"%s","project_id":null,"milestone_id":null,"parent_ticket_id":"parent"}|}
          (revision state "unrelated")));
  print_endline
    "parent-depends-on-descendant plus inheritance creates an effective self-cycle";
  [%expect
    {|parent-depends-on-descendant plus inheritance creates an effective self-cycle|}]
;;

let rec map_field value name f =
  match value with
  | `Object fields ->
    Json.obj
      (List.map fields ~f:(fun (key, value) ->
         key, if String.equal key name then f value else map_field value name f))
  | `Array values -> `Array (List.map values ~f:(fun value -> map_field value name f))
  | `String _ | `Number _ | `True | `False | `Null -> value
;;

let%expect_test
    "replay validates policy revisions, effective graph and completion independently"
  =
  let state =
    fixture ()
    |> fun s ->
    create s "parent"
    |> fun s -> create ~parent:"parent" s "child" |> fun s -> dep s "parent" "child"
  in
  let prepared =
    prepare
      state
      "ticket.hierarchy.put"
      {|{"ticket_id":"parent","expected_revision":"0","descendant_prerequisites":"independent","child_completion":"all_done","reason":"Audit"}|}
    |> ok
  in
  let forged =
    map_field (State.events prepared) "descendant_prerequisites" (fun _ ->
      Json.string "inherit")
  in
  assert (Result.is_error (State.replay state forged));
  let forged = map_field (State.events prepared) "revision" (fun _ -> Json.int 99) in
  assert (Result.is_error (State.replay state forged));
  let base =
    fixture ()
    |> fun s ->
    create s "parent"
    |> fun s -> create ~parent:"parent" s "child" |> fun s -> cancel s "child"
  in
  let branch children =
    policy ~inheritance:"independent" ~children base "parent" 0
    |> fun s -> step s "ticket.start" {|{"ticket_id":"parent"}|}
  in
  let permitted = branch "done_or_canceled" in
  let stricter = branch "all_done" in
  let finished =
    prepare
      permitted
      "ticket.finish"
      {|{"ticket_id":"parent","token":"1","evidence":"Checked"}|}
    |> ok
  in
  assert_kind Blocked (State.replay stricter (State.events finished));
  print_endline "forged inherited cycle, policy revision and stale completion rejected";
  [%expect {|forged inherited cycle, policy revision and stale completion rejected|}]
;;

let%expect_test "batch validates final hierarchy graph and rolls back a late rejection" =
  let state =
    fixture ()
    |> fun s ->
    create s "source"
    |> fun s ->
    create s "parent"
    |> fun s -> create ~parent:"parent" s "child" |> fun s -> dep s "parent" "source"
  in
  let before = Json.canonical (State.to_json state) in
  assert_kind
    Blocked
    (prepare
       state
       "transaction.apply"
       {|{"operations":[{"method":"ticket.hierarchy.put","params":{"ticket_id":"parent","expected_revision":"0","descendant_prerequisites":"inherit","child_completion":"all_done","reason":"Tighten"}},{"method":"ticket.start","params":{"ticket_id":"child"}}]}|});
  assert (String.equal before (Json.canonical (State.to_json state)));
  ignore
    (step
       state
       "transaction.apply"
       {|{"operations":[{"method":"ticket.hierarchy.put","params":{"ticket_id":"parent","expected_revision":"0","descendant_prerequisites":"inherit","child_completion":"all_done","reason":"Temporary"}},{"method":"ticket.hierarchy.put","params":{"ticket_id":"parent","expected_revision":"1","descendant_prerequisites":"independent","child_completion":"all_done","reason":"Final"}},{"method":"ticket.start","params":{"ticket_id":"child"}},{"method":"ticket.finish","params":{"ticket_id":"child","token":"1","evidence":"Checked"}}]}|}
     : State.t);
  print_endline
    "late failure leaves capture unchanged; ordered policy updates and start-finish \
     compose";
  [%expect
    {|late failure leaves capture unchanged; ordered policy updates and start-finish compose|}]
;;

let%expect_test
    "replay rechecks inherited conditions for claims, attempts and reassignment"
  =
  let base =
    fixture ()
    |> fun s ->
    create s "source"
    |> fun s ->
    create s "parent"
    |> fun s -> create ~parent:"parent" s "child" |> fun s -> dep s "parent" "source"
  in
  let open_ = policy ~inheritance:"independent" base "parent" 0 in
  let blocked = policy base "parent" 0 in
  let grant = prepare open_ "ticket.claim" {|{"ticket_id":"child"}|} |> ok in
  assert_kind Blocked (State.replay blocked (State.events grant));
  let base = step base "ticket.claim" {|{"ticket_id":"child"}|} in
  let open_ = policy ~inheritance:"independent" base "parent" 0 in
  let blocked = policy base "parent" 0 in
  let attempt =
    prepare
      open_
      "attempt.start"
      {|{"attempt_id":"a","target_run_id":"run","ticket_id":"child","token":"1"}|}
    |> ok
  in
  assert_kind Blocked (State.replay blocked (State.events attempt));
  let reassign =
    prepare
      open_
      "ticket.reassign"
      (sprintf
         {|{"ticket_id":"child","expected_revision":"%s","claimant_id":"worker","claimant_run_id":"run","reason":"Handoff"}|}
         (revision open_ "child"))
    |> ok
  in
  assert_kind Blocked (State.replay blocked (State.events reassign));
  print_endline
    "resolved claim, attempt and reassign payloads cannot bypass current inherited \
     prerequisites";
  [%expect
    {|resolved claim, attempt and reassign payloads cannot bypass current inherited prerequisites|}]
;;

let attention state after tickets kinds =
  let params =
    Json.obj
      [ ( "filter"
        , Json.obj
            [ "ticket_ids", `Array (List.map tickets ~f:Json.string)
            ; "kinds", `Array (List.map kinds ~f:Json.string)
            ] )
      ; "after", Json.int after
      ]
  in
  let response =
    State.query state ~method_:"attention.read" ~params ~now_unix_ms:100L
    |> ok
    |> fun response -> Json.field response "data"
  in
  ignore (Api_codec.decode Attention_api.response_codec response |> ok : Jsonaf.t);
  Json.field response "items" |> Json.list
;;

let%expect_test
    "attention distinguishes policy audit, inherited conditions and local child policy"
  =
  let state =
    fixture ()
    |> fun s ->
    create s "source"
    |> fun s ->
    create s "parent"
    |> fun s ->
    create ~parent:"parent" s "middle"
    |> fun s ->
    create ~parent:"middle" s "leaf"
    |> fun s -> create s "unrelated" |> fun s -> dep s "parent" "source"
  in
  let before = State.revision state in
  let state = policy state "parent" 0 in
  assert (List.length (attention state before [ "leaf" ] [ "readiness" ]) = 1);
  assert (List.is_empty (attention state before [ "unrelated" ] [ "readiness" ]));
  assert (List.is_empty (attention state before [ "parent" ] [ "readiness" ]));
  assert (List.length (attention state before [ "parent" ] [ "ticket" ]) = 1);
  let before = State.revision state in
  let state = policy ~reason:"Reason-only review" state "parent" 1 in
  assert (List.is_empty (attention state before [ "leaf" ] [ "readiness" ]));
  assert (List.length (attention state before [ "parent" ] [ "ticket" ]) = 1);
  let before = State.revision state in
  let state = policy ~children:"done_or_canceled" state "parent" 2 in
  assert (List.length (attention state before [ "parent" ] [ "readiness" ]) = 1);
  assert (List.is_empty (attention state before [ "leaf" ] [ "readiness" ]));
  let before = State.revision state in
  let state = waive state "parent" "source" in
  assert (List.length (attention state before [ "leaf" ] [ "readiness" ]) >= 1);
  print_endline
    "descendant inheritance, source waiver and local child policy wake only relevant \
     readiness; reason edits audit only";
  [%expect
    {|descendant inheritance, source waiver and local child policy wake only relevant readiness; reason edits audit only|}]
;;

let%expect_test
    "attention uses both sides of parent moves without inheriting ancestor status"
  =
  let state =
    fixture ()
    |> fun s ->
    create s "source"
    |> fun s ->
    create s "old"
    |> fun s ->
    create s "new"
    |> fun s ->
    create ~parent:"old" s "middle"
    |> fun s ->
    create ~parent:"middle" s "leaf"
    |> fun s -> dep s "old" "source" |> fun s -> policy s "old" 0
  in
  let before = State.revision state in
  let state =
    step
      state
      "ticket.move"
      (sprintf
         {|{"ticket_id":"middle","expected_revision":"%s","project_id":null,"milestone_id":null,"parent_ticket_id":"new"}|}
         (revision state "middle"))
  in
  assert (List.length (attention state before [ "leaf" ] [ "readiness" ]) >= 1);
  assert (List.is_empty (reasons state "leaf"));
  let before = State.revision state in
  let state =
    step
      state
      "ticket.update"
      (sprintf
         {|{"ticket_id":"new","expected_revision":"%s","status":"backlog"}|}
         (revision state "new"))
  in
  assert (List.is_empty (attention state before [ "leaf" ] [ "readiness" ]));
  assert (List.is_empty (reasons state "leaf"));
  let before = State.revision state in
  let state =
    step
      state
      "ticket.update"
      (sprintf
         {|{"ticket_id":"middle","expected_revision":"%s","title":"Edited display title"}|}
         (revision state "middle"))
  in
  assert (List.is_empty (attention state before [ "leaf" ] [ "readiness" ]));
  print_endline
    "move removes inherited condition and wakes descendant; ancestor status neither \
     blocks nor wakes it";
  [%expect
    {|move removes inherited condition and wakes descendant; ancestor status neither blocks nor wakes it|}]
;;

let%expect_test
    "current hierarchy gates compose with aggregate project completion without reopening"
  =
  let base =
    fixture ()
    |> fun s ->
    step s "project.create" {|{"project_id":"p","title":"Project"}|}
    |> fun s ->
    step s "ticket.create" {|{"ticket_id":"parent","title":"Parent","project_id":"p"}|}
    |> fun s ->
    step
      s
      "ticket.create"
      {|{"ticket_id":"child","title":"Child","project_id":"p","parent_ticket_id":"parent"}|}
    |> fun s ->
    cancel s "child"
    |> fun s ->
    policy ~inheritance:"independent" ~children:"done_or_canceled" s "parent" 0
    |> fun s -> complete s "parent"
  in
  let finish =
    {|{"project_id":"p","expected_revision":"1","evidence":"Reviewed","handoff":{"summary":"Done","next_steps":""}}|}
  in
  ignore (prepare base "project.finish" finish |> ok : State.prepared);
  let stricter = policy ~inheritance:"independent" base "parent" 1 in
  assert (
    String.equal (Json.field (ticket stricter "parent") "status" |> Json.text) "done");
  assert_kind Blocked (prepare stricter "project.finish" finish);
  assert_kind
    Blocked
    (prepare
       base
       "transaction.apply"
       {|{"operations":[{"method":"project.finish","params":{"project_id":"p","expected_revision":"1","evidence":"Reviewed","handoff":{"summary":"Done","next_steps":""}}},{"method":"ticket.hierarchy.put","params":{"ticket_id":"parent","expected_revision":"1","descendant_prerequisites":"independent","child_completion":"all_done","reason":"Late stricter gate"}}]}|});
  print_endline
    "Done member stays Done; current and final-transaction hierarchy gates still block \
     project finish";
  [%expect
    {|Done member stays Done; current and final-transaction hierarchy gates still block project finish|}]
;;

let%expect_test
    "only the final structural graph is validated for an atomic policy transaction"
  =
  let state =
    fixture ()
    |> fun s ->
    create s "parent"
    |> fun s -> create ~parent:"parent" s "child" |> fun s -> dep s "parent" "child"
  in
  let state =
    step
      state
      "transaction.apply"
      {|{"operations":[{"method":"ticket.hierarchy.put","params":{"ticket_id":"parent","expected_revision":"0","descendant_prerequisites":"inherit","child_completion":"all_done","reason":"Replace graph atomically"}},{"method":"dependency.remove","params":{"ticket_id":"parent","prerequisite_id":"child"}}]}|}
  in
  assert (List.is_empty (reasons state "child"));
  let stored = query state "ticket.hierarchy.get" {|{"ticket_id":"parent"}|} in
  ignore
    (Api_codec.decode Hierarchy_api.Snapshot.codec stored |> ok
     : Hierarchy_api.Snapshot.t);
  assert_kind
    Conflict
    (prepare
       state
       "ticket.hierarchy.put"
       {|{"ticket_id":"parent","expected_revision":"0","descendant_prerequisites":"inherit","child_completion":"all_done","reason":"Stale policy revision"}|});
  assert_kind
    Not_found
    (prepare
       state
       "ticket.hierarchy.put"
       {|{"ticket_id":"missing","expected_revision":"0","descendant_prerequisites":"inherit","child_completion":"all_done","reason":"Missing owner"}|});
  print_endline
    "temporary cycle removed within batch; stored policy and independent revision remain \
     explicit";
  [%expect
    {|temporary cycle removed within batch; stored policy and independent revision remain explicit|}]
;;
