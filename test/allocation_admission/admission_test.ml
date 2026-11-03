open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error p -> failwith p.Problem.message
;;

let actor = ok (Id.Actor.of_string "worker")
let run name = ok (Id.Run.of_string name)
let parse text = ok (Json.parse text)

let prepare ?(actor = actor) ?run t method_ params =
  Result.bind
    (Domain_command.decode ~method_ ~params:(parse params))
    ~f:(fun command ->
      State.prepare
        t
        command
        ~actor
        ?run
        ~now_unix_ms:100L
        ~timestamp:"2026-11-03T00:00:00Z")
;;

let step ?actor ?run t method_ params =
  State.candidate (ok (prepare ?actor ?run t method_ params))
;;

let report = function
  | Ok _ -> print_endline "ok"
  | Error p ->
    print_string (Problem.wire_name p.Problem.kind);
    (match p.details with
     | Some (Problem.Details.Allocation { reasons; omitted_reasons; _ }) ->
       List.iter reasons ~f:(fun reason ->
         print_string
           (" "
            ^ Json.text (Json.field (Allocation_admission_reason.to_json reason) "kind")));
       if omitted_reasons > 0 then printf " omitted=%d" omitted_reasons
     | _ -> ());
    print_endline ""
;;

let fixture ?(capability = true) ?(limit = 1) () =
  let t =
    ok
      (State.empty ~workspace:(ok (Id.Workspace.of_string "admission")) ~name:"Admission")
  in
  let t =
    step
      t
      "run.register"
      {|{"target_run_id":"good","objective":"work","capabilities":["ocaml"]}|}
  in
  let t = step t "run.register" {|{"target_run_id":"bad","objective":"work"}|} in
  let t =
    step
      t
      "allocation.pool_put"
      (sprintf {|{"name":"build","expected_revision":"0","limit":"%d"}|} limit)
  in
  List.fold [ "a"; "b"; "c" ] ~init:t ~f:(fun t id ->
    let t = step t "ticket.create" (sprintf {|{"ticket_id":"%s","title":"%s"}|} id id) in
    step
      t
      "allocation.ticket_policy_put"
      (sprintf
         {|{"ticket_id":"%s","expected_revision":"0","required_capabilities":%s,"pools":["build"]}|}
         id
         (if capability then {|["ocaml"]|} else "[]")))
;;

let same_replay t prepared =
  printf
    "replay=%b\n"
    (String.equal
       (Json.canonical (State.to_json (State.candidate prepared)))
       (Json.canonical (State.to_json (ok (State.replay t (State.events prepared))))))
;;

let rec replace_run = function
  | `Object fields ->
    `Object
      (List.map fields ~f:(fun (key, value) ->
         ( key
         , match value with
           | `String text when String.equal key "run_id" && String.equal text "good" ->
             `String "bad"
           | value -> replace_run value )))
  | `Array values -> `Array (List.map values ~f:replace_run)
  | value -> value
;;

let%expect_test "every direct claim/start shape enforces constrained run and capability" =
  let t = fixture () in
  List.iter
    [ "ticket.claim", {|{"ticket_id":"a"}|}
    ; "ticket.claim", {|{"ticket_id":"a","lease_duration_ms":"1000"}|}
    ; "ticket.start", {|{"ticket_id":"a"}|}
    ; "ticket.start", {|{"ticket_id":"a","attempt_id":"attempt"}|}
    ]
    ~f:(fun (method_, params) ->
      report (prepare t method_ params);
      report (prepare ~run:(run "unknown") t method_ params);
      report (prepare ~run:(run "bad") t method_ params);
      let accepted = ok (prepare ~run:(run "good") t method_ params) in
      same_replay t accepted);
  [%expect
    {|
    Blocked run_required
    Blocked unregistered_run
    Blocked missing_capability
    replay=true
    Blocked run_required
    Blocked unregistered_run
    Blocked missing_capability
    replay=true
    Blocked run_required
    Blocked unregistered_run
    Blocked missing_capability
    replay=true
    Blocked run_required
    Blocked unregistered_run
    Blocked missing_capability
    replay=true
    |}]
;;

let%expect_test "direct claims consume pool slots and own attempt is deduplicated" =
  let t = fixture () in
  let grant = ok (prepare ~run:(run "good") t "ticket.start" {|{"ticket_id":"a"}|}) in
  let claimed = State.candidate grant in
  report (prepare ~run:(run "good") claimed "ticket.start" {|{"ticket_id":"b"}|});
  let empty =
    ok
      (prepare
         ~run:(run "good")
         claimed
         "ticket.claim_next"
         {|{"target_run_id":"good","attempt_id":"choose"}|})
  in
  print_endline (Json.text (Json.field (State.result empty) "kind"));
  let attempt =
    ok
      (prepare
         ~run:(run "good")
         claimed
         "attempt.start"
         {|{"attempt_id":"attempt","target_run_id":"good","ticket_id":"a","token":"1"}|})
  in
  same_replay claimed attempt;
  report
    (prepare
       ~run:(run "good")
       (State.candidate attempt)
       "ticket.start"
       {|{"ticket_id":"b"}|});
  report
    (prepare
       claimed
       "allocation.ticket_policy_put"
       {|{"ticket_id":"a","expected_revision":"1","required_capabilities":[],"pools":[]}|});
  let released =
    step ~run:(run "good") claimed "ticket.release" {|{"ticket_id":"a","token":"1"}|}
  in
  report (prepare ~run:(run "good") released "ticket.start" {|{"ticket_id":"b"}|});
  [%expect
    {|
    Blocked pool_full
    empty
    replay=true
    Blocked pool_full
    Conflict
    ok
    |}]
;;

let%expect_test "pool shrink retains grants and reassignment rechecks target eligibility" =
  let t = fixture ~limit:2 () in
  let t = step ~run:(run "good") t "ticket.claim" {|{"ticket_id":"a"}|} in
  let t = step ~run:(run "good") t "ticket.claim" {|{"ticket_id":"b"}|} in
  let t =
    step t "allocation.pool_put" {|{"name":"build","expected_revision":"1","limit":"1"}|}
  in
  report (prepare ~run:(run "good") t "ticket.claim" {|{"ticket_id":"c"}|});
  let attempt =
    ok
      (prepare
         ~run:(run "good")
         t
         "attempt.start"
         {|{"attempt_id":"attempt","target_run_id":"good","ticket_id":"a","token":"1"}|})
  in
  same_replay t attempt;
  report
    (prepare
       t
       "ticket.reassign"
       {|{"ticket_id":"b","expected_revision":"2","claimant_id":"worker","claimant_run_id":"bad","reason":"handoff"}|});
  let reassigned =
    ok
      (prepare
         t
         "ticket.reassign"
         {|{"ticket_id":"b","expected_revision":"2","claimant_id":"worker","claimant_run_id":"good","reason":"handoff"}|})
  in
  same_replay t reassigned;
  [%expect
    {|
    Blocked pool_full
    replay=true
    Blocked missing_capability
    replay=true
    |}]
;;

let%expect_test "forged capability grants reject during replay and batches roll back" =
  let t = fixture () in
  let accepted = ok (prepare ~run:(run "good") t "ticket.claim" {|{"ticket_id":"a"}|}) in
  report (State.replay t (replace_run (State.events accepted)));
  let t =
    step
      t
      "ticket.paths.put"
      {|{"ticket_id":"a","expected_revision":"0","require_reservations":true,"declarations":[{"target":{"worktree_id":"tree","kind":"subtree","path":"src"},"mode":"exclusive"}]}|}
  in
  let before = Json.canonical (State.to_json t) in
  report
    (prepare
       ~run:(run "good")
       t
       "transaction.apply"
       {|{"operations":[{"method":"ticket.claim","params":{"ticket_id":"a"}},{"method":"ticket.claim","params":{"ticket_id":"b"}}]}|});
  printf "unchanged=%b\n" (String.equal before (Json.canonical (State.to_json t)));
  [%expect
    {|
    Blocked missing_capability
    Blocked pool_full
    unchanged=true
    |}]
;;

let%expect_test
    "pool-only policies still require invocation and attempt budgets remain attempts"
  =
  let t = fixture ~capability:false () in
  report (prepare t "ticket.start" {|{"ticket_id":"a"}|});
  let t =
    step
      t
      "run.budget_put"
      {|{"target_run_id":"good","expected_revision":"0","max_attempts":"1","max_active_attempts":"1","reported_token_limit":null,"reported_elapsed_ms_limit":null}|}
  in
  let t =
    step ~run:(run "good") t "ticket.start" {|{"ticket_id":"a","attempt_id":"attempt"}|}
  in
  let t =
    step
      ~run:(run "good")
      t
      "ticket.finish"
      {|{"ticket_id":"a","token":"1","evidence":"done"}|}
  in
  let grant = ok (prepare ~run:(run "good") t "ticket.start" {|{"ticket_id":"b"}|}) in
  same_replay t grant;
  report
    (prepare
       ~run:(run "good")
       (State.candidate grant)
       "attempt.start"
       {|{"attempt_id":"second","target_run_id":"good","ticket_id":"b","token":"1"}|});
  [%expect
    {|
    Blocked run_required
    replay=true
    Blocked budget_exhausted
    |}]
;;

let%expect_test "replay rejects incremental occupancy beyond pool capacity" =
  let claim_a t = step ~run:(run "good") t "ticket.claim" {|{"ticket_id":"a"}|} in
  let full = claim_a (fixture ~limit:1 ()) in
  let roomy = claim_a (fixture ~limit:2 ()) in
  let second =
    ok (prepare ~run:(run "good") roomy "ticket.claim" {|{"ticket_id":"b"}|})
  in
  report (State.replay full (State.events second));
  same_replay roomy second;
  [%expect
    {|
    Blocked pool_full
    replay=true
    |}]
;;

let%expect_test "registered actor and terminal run are checked on retained claims" =
  let t = fixture () in
  let other = ok (Id.Actor.of_string "other") in
  let t =
    step
      ~actor:other
      t
      "run.register"
      {|{"target_run_id":"other","objective":"work","capabilities":["ocaml"]}|}
  in
  report (prepare ~run:(run "other") t "ticket.start" {|{"ticket_id":"a"}|});
  let t = step ~run:(run "good") t "ticket.claim" {|{"ticket_id":"a"}|} in
  let t =
    step
      ~run:(run "good")
      t
      "run.transition"
      {|{"target_run_id":"good","expected_revision":"1","status":"completed","evidence":"isolated work; claim retained"}|}
  in
  report
    (prepare
       ~run:(run "good")
       t
       "attempt.start"
       {|{"attempt_id":"attempt","target_run_id":"good","ticket_id":"a","token":"1"}|});
  report (prepare ~run:(run "bad") t "ticket.claim" {|{"ticket_id":"b"}|});
  let plain = step t "ticket.create" {|{"ticket_id":"plain","title":"plain"}|} in
  report (prepare plain "ticket.claim" {|{"ticket_id":"plain"}|});
  report (prepare ~run:(run "opaque") plain "ticket.claim" {|{"ticket_id":"plain"}|});
  [%expect
    {|
    Conflict run_actor_mismatch
    Conflict terminal_run
    Blocked missing_capability pool_full
    ok
    ok
    |}]
;;

let%expect_test "typed diagnostics validate counts, units and bounded transport" =
  let parse_problem text = Problem_wire.of_json (parse text) in
  List.iter
    [ {|{"kind":"Blocked","message":"prose","details":{"type":"allocation","ticket_id":"a","reasons":[],"omitted_reasons":"0"}}|}
    ; {|{"kind":"Blocked","message":"prose","details":{"type":"allocation","ticket_id":"a","reasons":[{"kind":"pool_full","pool":"db","unit":"attempts","used":"1","limit":"1","attempted":"2"}],"omitted_reasons":"0"}}|}
    ; {|{"kind":"Blocked","message":"prose","details":{"type":"allocation","ticket_id":"a","reasons":[{"kind":"pool_full","pool":"db","unit":"allocated_tickets","used":"1","limit":"1","attempted":"1"}],"omitted_reasons":"0"}}|}
    ; {|{"kind":"Blocked","message":"prose","details":{"type":"allocation","ticket_id":"a","reasons":[{"kind":"run_actor_mismatch","run_id":"run","expected_actor":"worker","actual_actor":"worker"}],"omitted_reasons":"0"}}|}
    ]
    ~f:(fun text -> report (parse_problem text));
  let reasons =
    List.init 100 ~f:(fun i ->
      Allocation_admission_reason.Missing_capability
        { run_id = "run"; capability = "cap" ^ Int.to_string i })
  in
  let problem =
    Problem.with_details
      (Problem.create Blocked "prose can change")
      (Allocation { ticket_id = "a"; reasons; omitted_reasons = 0 })
  in
  report (Problem_wire.of_json (Problem.to_json problem));
  let request =
    ok (Protocol.Request.create ~id:"x" ~method_:"daemon.health" ~params:(`Object []))
  in
  (match
     ok
       (Protocol.decode_response
          request
          (Protocol.response_json request (Failure problem)))
   with
   | Failure { details = Some (Allocation { reasons; omitted_reasons; _ }); _ } ->
     printf "listed=%d omitted=%d\n" (List.length reasons) omitted_reasons
   | _ -> failwith "lost typed allocation diagnostic");
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    listed=16 omitted=84
    |}]
;;

let%expect_test "multiple pool demands are independent semaphores" =
  let t = fixture () in
  let t =
    step t "allocation.pool_put" {|{"name":"db","expected_revision":"0","limit":"1"}|}
  in
  let t =
    step
      t
      "allocation.ticket_policy_put"
      {|{"ticket_id":"a","expected_revision":"1","required_capabilities":[],"pools":["build","db"]}|}
  in
  let t =
    step
      t
      "allocation.ticket_policy_put"
      {|{"ticket_id":"c","expected_revision":"1","required_capabilities":[],"pools":["db"]}|}
  in
  let t = step ~run:(run "good") t "ticket.claim" {|{"ticket_id":"a"}|} in
  List.iter [ "b"; "c" ] ~f:(fun id ->
    match
      prepare ~run:(run "good") t "ticket.claim" (sprintf {|{"ticket_id":"%s"}|} id)
    with
    | Error
        { details =
            Some
              (Allocation { reasons = [ Pool_full { pool; used; limit; attempted } ]; _ })
        ; _
        } -> printf "%s used=%d limit=%d attempted=%d\n" pool used limit attempted
    | _ -> failwith "pool admission did not name exact demand");
  [%expect
    {|
    build used=1 limit=1 attempted=2
    db used=1 limit=1 attempted=2
    |}]
;;

let%expect_test "new attempt replay enforces budgets on already occupied tickets" =
  let fixture budget =
    let t = fixture ~capability:false () in
    let t =
      step
        t
        "run.budget_put"
        (sprintf
           {|{"target_run_id":"good","expected_revision":"0","max_attempts":"%d","max_active_attempts":"1","reported_token_limit":null,"reported_elapsed_ms_limit":null}|}
           budget)
    in
    let t =
      step ~run:(run "good") t "ticket.start" {|{"ticket_id":"a","attempt_id":"first"}|}
    in
    let t =
      step
        ~run:(run "good")
        t
        "ticket.finish"
        {|{"ticket_id":"a","token":"1","evidence":"done"}|}
    in
    step ~run:(run "good") t "ticket.claim" {|{"ticket_id":"b"}|}
  in
  let limited, roomy = fixture 1, fixture 2 in
  let attempt =
    ok
      (prepare
         ~run:(run "good")
         roomy
         "attempt.start"
         {|{"attempt_id":"second","target_run_id":"good","ticket_id":"b","token":"1"}|})
  in
  report (State.replay limited (State.events attempt));
  same_replay roomy attempt;
  [%expect
    {|
    Blocked budget_exhausted
    replay=true
    |}]
;;

let%expect_test "reassignment cannot use retained capacity to bypass run identity" =
  let t = fixture () in
  let t = step ~run:(run "good") t "ticket.claim" {|{"ticket_id":"a"}|} in
  List.iter
    [ {|{"ticket_id":"a","expected_revision":"2","claimant_id":"worker","reason":"handoff"}|}
    ; {|{"ticket_id":"a","expected_revision":"2","claimant_id":"worker","claimant_run_id":"unknown","reason":"handoff"}|}
    ; {|{"ticket_id":"a","expected_revision":"2","claimant_id":"other","claimant_run_id":"good","reason":"handoff"}|}
    ]
    ~f:(fun params -> report (prepare t "ticket.reassign" params));
  let other = ok (Id.Actor.of_string "other") in
  let t =
    step
      ~actor:other
      t
      "run.register"
      {|{"target_run_id":"other","objective":"work","capabilities":["ocaml"]}|}
  in
  let reassigned =
    ok
      (prepare
         t
         "ticket.reassign"
         {|{"ticket_id":"a","expected_revision":"2","claimant_id":"other","claimant_run_id":"other","reason":"handoff"}|})
  in
  same_replay t reassigned;
  [%expect
    {|
    Blocked run_required
    Blocked unregistered_run
    Conflict run_actor_mismatch
    replay=true
    |}]
;;
