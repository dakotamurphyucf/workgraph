open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let json text = Json.parse text |> ok
let actor = Id.Actor.of_string "worker" |> ok
let run = Id.Run.of_string "run" |> ok

let prepare ?run state method_ params =
  let command = Domain_command.decode ~method_ ~params:(json params) |> ok in
  State.prepare
    state
    ?run
    command
    ~actor
    ~timestamp:"2026-11-05T00:00:00Z"
    ~now_unix_ms:100L
;;

let step ?run state method_ params =
  let prepared = prepare ?run state method_ params |> ok in
  State.candidate prepared
;;

let fixture () =
  let state =
    State.empty ~workspace:(Id.Workspace.of_string "candidates" |> ok) ~name:"Candidates"
    |> ok
  in
  let state =
    step
      state
      "run.register"
      {|{"target_run_id":"run","objective":"Work","capabilities":["ocaml"]}|}
  in
  List.fold [ "a"; "b"; "c" ] ~init:state ~f:(fun state id ->
    step state "ticket.create" (sprintf {|{"ticket_id":"%s","title":"%s"}|} id id))
;;

let query state method_ params =
  State.query state ~method_ ~params:(json params) ~now_unix_ms:100L
  |> ok
  |> fun response -> Json.field response "data"
;;

let candidate = {|{"actor_id":"worker","capabilities":["ocaml"]}|}

let readiness ?(candidate = candidate) state ticket =
  query
    state
    "ticket.readiness"
    (sprintf {|{"ticket_id":"%s","candidate":%s}|} ticket candidate)
;;

let report data =
  printf
    "%s %s %s\n"
    (Json.canonical (Json.field data "ready"))
    (Json.canonical (Json.field data "assessment"))
    (Json.canonical (Json.field data "reasons"))
;;

let ids data =
  Json.field data "items"
  |> Json.list
  |> List.map ~f:(fun ticket -> Json.field ticket "ticket_id" |> Json.text)
;;

let%expect_test "candidate decoding canonicalizes without creating a run" =
  let codec = Readiness_selector.Candidate.codec in
  let decoded =
    Api_codec.decode codec (json {|{"actor_id":"new","capabilities":["z","a"]}|}) |> ok
  in
  print_endline (Json.canonical (Api_codec.encode codec decoded |> ok));
  List.iter
    [ {|{"actor_id":"new"}|}
    ; {|{"actor_id":"new","capabilities":["a","a"]}|}
    ; {|{"actor_id":"new","capabilities":[" "]}|}
    ; {|{"actor_id":"bad id","capabilities":[]}|}
    ; {|{"actor_id":"new","capabilities":[],"run_id":"fake"}|}
    ]
    ~f:(fun text -> printf "%b\n" (Result.is_error (Api_codec.decode codec (json text))));
  let state = fixture () in
  let before = Json.canonical (State.to_json state) in
  report
    (readiness ~candidate:{|{"actor_id":"unregistered","capabilities":[]}|} state "a");
  printf
    "unchanged=%b runs=%d\n"
    (String.equal before (Json.canonical (State.to_json state)))
    (List.length (Agent_run.runs (State.agent_runs state)));
  [%expect
    {|
    {"actor_id":"new","capabilities":["a","z"]}
    true
    true
    true
    true
    true
    true {"scope":"candidate","unknown_checks":["run_lifecycle","run_budget"]} []
    unchanged=true runs=1
  |}]
;;

let%expect_test "graph candidate and registered run checks remain distinct" =
  let state =
    step
      (fixture ())
      "allocation.ticket_policy_put"
      {|{"ticket_id":"a","expected_revision":"0","required_capabilities":["ocaml"],"pools":[],"allowed_actor_ids":["worker"]}|}
  in
  report (query state "ticket.readiness" {|{"ticket_id":"a"}|});
  report (readiness ~candidate:{|{"actor_id":"other","capabilities":[]}|} state "a");
  report (readiness state "a");
  report (query state "ticket.readiness" {|{"ticket_id":"a","target_run_id":"run"}|});
  let selected =
    query state "ticket.ready" {|{"candidate":{"actor_id":"other","capabilities":[]}}|}
  in
  print_s [%sexp (ids selected : string list)];
  [%expect
    {|
    true {"scope":"graph","unknown_checks":[]} []
    false {"scope":"candidate","unknown_checks":["run_lifecycle","run_budget"]} [{"kind":"allocation","reason":{"actor_id":"other","kind":"actor_not_allowed"}},{"capability":"ocaml","kind":"missing_candidate_capability"}]
    true {"scope":"candidate","unknown_checks":["run_lifecycle","run_budget"]} []
    true {"scope":"run","unknown_checks":[]} []
    (b c)
  |}]
;;

let%expect_test "candidate does not inherit a real run budget or path ownership" =
  let state =
    step
      (fixture ())
      "run.budget_put"
      {|{"target_run_id":"run","expected_revision":"0","max_attempts":"1","max_active_attempts":"1","reported_token_limit":null,"reported_elapsed_ms_limit":null}|}
  in
  let state = step ~run state "ticket.start" {|{"ticket_id":"b","attempt_id":"first"}|} in
  let state =
    step
      state
      "ticket.paths.put"
      {|{"ticket_id":"a","expected_revision":"0","require_reservations":true,"declarations":[{"target":{"worktree_id":"tree","kind":"subtree","path":"src"},"mode":"exclusive"}]}|}
  in
  report (readiness state "a");
  let run_readiness =
    query state "ticket.readiness" {|{"ticket_id":"a","target_run_id":"run"}|}
  in
  printf
    "run_ready=%s budget_reasons=%d\n"
    (Json.canonical (Json.field run_readiness "ready"))
    (Json.field run_readiness "reasons"
     |> Json.list
     |> List.count ~f:(fun reason ->
       match Json.optional reason "reason" with
       | Some value ->
         String.equal (Json.text (Json.field value "kind")) "budget_exhausted"
       | None -> false));
  (match
     prepare ~run state "ticket.start" {|{"ticket_id":"a","attempt_id":"second"}|}
   with
   | Ok _ -> failwith "exhausted real run accepted"
   | Error problem -> print_endline (Problem.wire_name problem.kind));
  let page =
    query
      state
      "ticket.ready"
      {|{"candidate":{"actor_id":"worker","capabilities":["ocaml"]},"limit":"1"}|}
  in
  print_s [%sexp (ids page : string list)];
  print_endline (Json.canonical (Json.field page "assessment"));
  [%expect
    {|
    true {"scope":"candidate","unknown_checks":["run_lifecycle","run_budget","required_path_ownership"]} []
    run_ready=false budget_reasons=2
    Blocked
    (a)
    {"scope":"candidate","unknown_checks":["run_lifecycle","run_budget","required_path_ownership"]}
  |}]
;;

let%expect_test "candidate pool hold and prerequisite failures remain known" =
  let state =
    step
      (fixture ())
      "allocation.pool_put"
      {|{"name":"build","expected_revision":"0","limit":"1"}|}
  in
  let state =
    List.fold [ "a"; "b" ] ~init:state ~f:(fun state ticket ->
      step
        state
        "allocation.ticket_policy_put"
        (sprintf
           {|{"ticket_id":"%s","expected_revision":"0","required_capabilities":[],"pools":["build"]}|}
           ticket))
  in
  let state = step ~run state "ticket.claim" {|{"ticket_id":"b"}|} in
  report (readiness state "a");
  let state =
    step
      state
      "ticket.hold"
      {|{"ticket_id":"c","expected_revision":"1","reason":"operator"}|}
  in
  let result = readiness state "c" in
  printf
    "held=%s reasons=%s\n"
    (Json.canonical (Json.field result "ready"))
    (Json.canonical (Json.field result "reason_count"));
  let state = step state "dependency.add" {|{"ticket_id":"a","prerequisite_id":"c"}|} in
  let result = readiness state "a" in
  printf
    "prerequisite=%s reasons=%s\n"
    (Json.canonical (Json.field result "ready"))
    (Json.canonical (Json.field result "reason_count"));
  [%expect
    {|
    false {"scope":"candidate","unknown_checks":["run_lifecycle","run_budget"]} [{"kind":"allocation","reason":{"attempted":"2","kind":"pool_full","limit":"1","pool":"build","unit":"allocated_tickets","used":"1"}}]
    held=false reasons="1"
    prerequisite=false reasons="2"
  |}]
;;

let%expect_test "selectors reject conflicts nulls and fabricated assessment scope" =
  let state = fixture () in
  List.iter [ "ticket.ready"; "ticket.readiness" ] ~f:(fun method_ ->
    List.iter
      [ {|{"candidate":{"actor_id":"worker","capabilities":[]},"target_run_id":"run"}|}
      ; {|{"candidate":null}|}
      ; {|{"target_run_id":null}|}
      ]
      ~f:(fun fields ->
        let params =
          match json fields with
          | `Object fields when String.equal method_ "ticket.readiness" ->
            Json.obj (("ticket_id", Json.string "a") :: fields)
          | value -> value
        in
        printf "%b\n" (Result.is_error (State.query state ~method_ ~params))));
  List.iter
    [ {|{"scope":"candidate","unknown_checks":[]}|}
    ; {|{"scope":"graph","unknown_checks":["run_budget"]}|}
    ; {|{"scope":"candidate","unknown_checks":["run_budget","run_lifecycle"]}|}
    ]
    ~f:(fun text ->
      printf
        "assessment_invalid=%b\n"
        (Result.is_error
           (Api_codec.decode Readiness_selector.Assessment.codec (json text))));
  [%expect
    {|
    true
    true
    true
    true
    true
    true
    assessment_invalid=true
    assessment_invalid=true
    assessment_invalid=true
  |}]
;;

let%expect_test "candidate external conditions stay known and wire scope cannot be forged"
  =
  let state =
    step
      (fixture ())
      "condition.put"
      (sprintf
         {|{"condition_id":"external","expected_revision":"0","ticket_id":"a","operation_id":"operation","artifact":{"kind":"checksum","source":"build","digest":"%s"},"label":"Build"}|}
         (String.make 64 'a'))
  in
  let result = readiness state "a" in
  printf
    "ready=%s kind=%s\n"
    (Json.canonical (Json.field result "ready"))
    (Json.field result "reasons"
     |> Json.list
     |> List.hd_exn
     |> fun reason -> Json.field reason "kind" |> Json.text);
  let missing =
    readiness
      ~candidate:{|{"actor_id":"worker","capabilities":[]}|}
      (step
         (fixture ())
         "allocation.ticket_policy_put"
         {|{"ticket_id":"a","expected_revision":"0","required_capabilities":["ocaml"],"pools":[]}|})
      "a"
  in
  let forged =
    match missing with
    | `Object fields ->
      Json.obj
        (List.Assoc.add
           fields
           "assessment"
           (json {|{"scope":"graph","unknown_checks":[]}|})
           ~equal:String.equal)
    | _ -> assert false
  in
  printf
    "forged_scope_rejected=%b\n"
    (Result.is_error (Api_codec.decode Planning_ticket_wire.Readiness.codec forged));
  List.iter [ 100; 101 ] ~f:(fun count ->
    let capabilities = List.init count ~f:(fun index -> Int.to_string index) in
    printf
      "capabilities_%d=%b\n"
      count
      (Result.is_ok (Readiness_selector.Candidate.create ~actor ~capabilities)));
  [%expect
    {|
    ready=false kind=external_condition
    forged_scope_rejected=true
    capabilities_100=true
    capabilities_101=false
  |}]
;;

let%expect_test "candidate paging preserves selector and planning capture guards" =
  let state =
    step
      (fixture ())
      "allocation.ticket_policy_put"
      {|{"ticket_id":"b","expected_revision":"0","required_capabilities":[],"pools":[],"allowed_actor_ids":["other"]}|}
  in
  let params offset capture =
    sprintf
      {|{"candidate":{"actor_id":"worker","capabilities":["ocaml"]},"limit":"1","offset":"%d"%s}|}
      offset
      capture
  in
  let first = query state "ticket.ready" (params 0 "") in
  let second =
    query
      state
      "ticket.ready"
      (params 1 (sprintf {|,"at_revision":"%d"|} (State.revision state)))
  in
  print_s [%sexp (ids first : string list), (ids second : string list)];
  printf
    "assessment_equal=%b\n"
    (String.equal
       (Json.canonical (Json.field first "assessment"))
       (Json.canonical (Json.field second "assessment")));
  let missing = State.query state ~method_:"ticket.ready" ~params:(json (params 1 "")) in
  printf "missing_capture_rejected=%b\n" (Result.is_error missing);
  let changed =
    step state "ticket.hold" {|{"ticket_id":"c","expected_revision":"1","reason":"stop"}|}
  in
  let stale =
    State.query
      changed
      ~method_:"ticket.ready"
      ~params:(json (params 1 (sprintf {|,"at_revision":"%d"|} (State.revision state))))
  in
  (match stale with
   | Ok _ -> failwith "stale candidate page accepted"
   | Error problem -> print_endline (Problem.wire_name problem.kind));
  [%expect
    {|
    ((a) (c))
    assessment_equal=true
    missing_capture_rejected=true
    Conflict
  |}]
;;
