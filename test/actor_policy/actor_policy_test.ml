open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let actor name = Id.Actor.of_string name |> ok
let json text = Json.parse text |> ok

let%expect_test
    "allowlist membership is explicit, canonical and independent of input order"
  =
  let first = Actor_eligibility.allowed [ actor "bob"; actor "alice" ] |> ok in
  let second = Actor_eligibility.allowed [ actor "alice"; actor "bob" ] |> ok in
  printf
    "equal=%b alice=%b other=%b unrestricted=%b\n"
    (Actor_eligibility.equal first second)
    (Actor_eligibility.permits first ~actor:(actor "alice"))
    (Actor_eligibility.permits first ~actor:(actor "other"))
    (Actor_eligibility.permits Actor_eligibility.unrestricted ~actor:(actor "other"));
  print_endline (Json.canonical (Actor_eligibility.jsonaf_of_t first));
  print_endline
    (Json.canonical (Actor_eligibility.jsonaf_of_t Actor_eligibility.unrestricted));
  [%expect
    {|
    equal=true alice=true other=false unrestricted=true
    ["alice","bob"]
    null
  |}]
;;

let%expect_test
    "public and stored allowlists reject empty duplicate malformed and oversized values"
  =
  List.iter
    [ "[]"; {|["alice","alice"]|}; {|["bad id"]|}; "[1]"; "{}"; {|"alice"|} ]
    ~f:(fun bytes ->
      printf
        "%b "
        (Result.is_error (Api_codec.decode Actor_eligibility.codec (json bytes))));
  print_endline "";
  List.iter [ 100; 101 ] ~f:(fun length ->
    let actors = List.init length ~f:(fun i -> actor ("a" ^ Int.to_string i)) in
    printf "%d=%b\n" length (Result.is_ok (Actor_eligibility.allowed actors)));
  List.iter [ "(Allowed ())"; "(Allowed (alice alice))" ] ~f:(fun text ->
    printf
      "sexp=%b\n"
      (Result.is_error
         (Or_error.try_with (fun () -> Actor_eligibility.t_of_sexp (Sexp.of_string text)))));
  let value = Actor_eligibility.t_of_jsonaf (json {|["bob","alice"]|}) in
  print_endline (Json.canonical (Actor_eligibility.jsonaf_of_t value));
  [%expect
    {|
    true true true true true true
    100=true
    101=false
    sexp=true
    sexp=true
    ["alice","bob"]
  |}]
;;

let%expect_test "an omitted actor patch differs from explicit unrestricted and allowlist" =
  let patch =
    Api_codec.object_
      (Api_codec.Fields.optional "allowed_actor_ids" Actor_eligibility.codec)
  in
  List.iter
    [ "{}"; {|{"allowed_actor_ids":null}|}; {|{"allowed_actor_ids":["alice"]}|} ]
    ~f:(fun bytes ->
      match Api_codec.decode patch (json bytes) |> ok with
      | None -> print_endline "preserve"
      | Some value -> print_endline (Json.canonical (Actor_eligibility.jsonaf_of_t value)));
  [%expect
    {|
    preserve
    null
    ["alice"]
  |}]
;;

let run = Id.Run.of_string "run" |> ok
let worker = actor "worker"

let prepare ?(run = run) state method_ text =
  let command = Domain_command.decode ~method_ ~params:(json text) |> ok in
  State.prepare state ~run command ~actor:worker ~timestamp:"fixture" ~now_unix_ms:100L
;;

let step ?run state method_ text =
  let prepared = prepare ?run state method_ text |> ok in
  let next = State.candidate prepared in
  if
    not
      (String.equal
         (Json.canonical (State.to_json next))
         (Json.canonical
            (State.to_json (State.replay state (State.events prepared) |> ok))))
  then failwith "prepared and replayed admission differ";
  next
;;

let fixture () =
  State.empty ~workspace:(Id.Workspace.of_string "actors" |> ok) ~name:"Actors"
  |> ok
  |> fun s ->
  step s "run.register" {|{"target_run_id":"run","objective":"Work"}|}
  |> fun s ->
  step s "run.register" {|{"target_run_id":"other","objective":"Other work"}|}
  |> fun s ->
  List.fold [ "a"; "b"; "c" ] ~init:s ~f:(fun s id ->
    step s "ticket.create" (sprintf {|{"ticket_id":"%s","title":"%s"}|} id id))
;;

let budget =
  {|{"target_run_id":"run","expected_revision":"0","max_attempts":null,"max_active_attempts":"1","reported_token_limit":null,"reported_elapsed_ms_limit":null}|}
;;

let%expect_test
    "existing concurrency bound counts attempts, keeps direct claims distinct and is per \
     run"
  =
  let state =
    fixture ()
    |> fun s ->
    step s "run.budget_put" budget |> fun s -> step s "ticket.start" {|{"ticket_id":"a"}|}
  in
  printf
    "direct claims attempts=%d\n"
    (List.length (Agent_run.attempts (State.agent_runs state)));
  let state = step state "ticket.start" {|{"ticket_id":"b","attempt_id":"one"}|} in
  (match
     prepare
       state
       "attempt.start"
       {|{"attempt_id":"two","target_run_id":"run","ticket_id":"a","token":"1"}|}
   with
   | Ok _ -> failwith "concurrency bound bypassed"
   | Error problem -> print_endline (Problem.wire_name problem.kind));
  let other = Id.Run.of_string "other" |> ok in
  let state =
    step ~run:other state "ticket.start" {|{"ticket_id":"c","attempt_id":"other"}|}
  in
  printf
    "total=%d run=%d other=%d\n"
    (List.length (Agent_run.attempts (State.agent_runs state)))
    (List.length (Agent_run.attempts_for_run (State.agent_runs state) run))
    (List.length (Agent_run.attempts_for_run (State.agent_runs state) other));
  let state =
    step state "ticket.finish" {|{"ticket_id":"b","token":"1","evidence":"Checked"}|}
    |> fun s ->
    step
      s
      "attempt.start"
      {|{"attempt_id":"two","target_run_id":"run","ticket_id":"a","token":"1"}|}
  in
  printf
    "after terminal run attempts=%d\n"
    (List.length (Agent_run.attempts_for_run (State.agent_runs state) run));
  [%expect
    {|
    direct claims attempts=0
    Blocked
    total=2 run=1 other=1
    after terminal run attempts=2
  |}]
;;

let outsider = actor "outsider"
let outsider_run = Id.Run.of_string "outsider-run" |> ok

let prepare_as ?run ~actor state method_ text =
  State.prepare
    state
    ?run
    (Domain_command.decode ~method_ ~params:(json text) |> ok)
    ~actor
    ~timestamp:"fixture"
    ~now_unix_ms:100L
;;

let step_as ?run ~actor state method_ text =
  let prepared = prepare_as ?run ~actor state method_ text |> ok in
  let next = State.candidate prepared in
  assert (
    String.equal
      (Json.canonical (State.to_json next))
      (Json.canonical (State.to_json (State.replay state (State.events prepared) |> ok))));
  next
;;

let actor_fixture () =
  State.empty ~workspace:(Id.Workspace.of_string "actors" |> ok) ~name:"Actors"
  |> ok
  |> fun s ->
  step_as ~actor:worker s "run.register" {|{"target_run_id":"run","objective":"Work"}|}
  |> fun s ->
  step_as
    ~actor:outsider
    s
    "run.register"
    {|{"target_run_id":"outsider-run","objective":"Other work"}|}
  |> fun s ->
  step_as ~actor:worker s "ticket.create" {|{"ticket_id":"a","title":"A"}|}
  |> fun s ->
  step_as
    ~actor:worker
    s
    "allocation.ticket_policy_put"
    {|{"ticket_id":"a","expected_revision":"0","required_capabilities":[],"pools":[],"allowed_actor_ids":["worker"]}|}
;;

let report = function
  | Ok _ -> print_endline "ok"
  | Error problem ->
    print_string (Problem.wire_name problem.Problem.kind);
    (match problem.details with
     | Some (Problem.Details.Allocation { reasons; _ }) ->
       List.iter reasons ~f:(fun reason ->
         print_string
           (" "
            ^ Json.text (Json.field (Allocation_admission_reason.to_json reason) "kind")))
     | _ -> ());
    print_endline ""
;;

let query state method_ text =
  State.query state ~method_ ~params:(json text) ~now_unix_ms:100L
  |> ok
  |> fun result -> Json.field result "data"
;;

let%expect_test
    "registered run actor gates every direct acquisition shape independently of \
     invocation actor"
  =
  let state = actor_fixture () in
  List.iter
    [ "ticket.claim", {|{"ticket_id":"a"}|}
    ; "ticket.claim", {|{"ticket_id":"a","lease_duration_ms":"1000"}|}
    ; "ticket.start", {|{"ticket_id":"a"}|}
    ; "ticket.start", {|{"ticket_id":"a","attempt_id":"attempt"}|}
    ]
    ~f:(fun (method_, params) ->
      report (prepare_as ~actor:worker state method_ params);
      report (prepare_as ~actor:outsider ~run:outsider_run state method_ params);
      report (prepare_as ~actor:outsider ~run state method_ params);
      ignore (step_as ~actor:worker ~run state method_ params : State.t));
  [%expect
    {|
    Blocked run_required
    Blocked actor_not_allowed
    Conflict run_actor_mismatch
    Blocked run_required
    Blocked actor_not_allowed
    Conflict run_actor_mismatch
    Blocked run_required
    Blocked actor_not_allowed
    Conflict run_actor_mismatch
    Blocked run_required
    Blocked actor_not_allowed
    Conflict run_actor_mismatch
  |}]
;;

let%expect_test "actor policy patches preserve clear and freeze under existing claims" =
  let state = actor_fixture () in
  let state =
    step_as
      ~actor:worker
      state
      "allocation.ticket_policy_put"
      {|{"ticket_id":"a","expected_revision":"1","required_capabilities":[],"pools":[]}|}
  in
  let policy state =
    Agent_run.get_ticket_policy (State.agent_runs state) (Id.Ticket.of_string "a" |> ok)
    |> Option.value_exn
  in
  print_endline
    (Json.canonical (Actor_eligibility.jsonaf_of_t (policy state).allowed_actor_ids));
  let claimed = step_as ~actor:worker ~run state "ticket.claim" {|{"ticket_id":"a"}|} in
  report
    (prepare_as
       ~actor:worker
       claimed
       "allocation.ticket_policy_put"
       {|{"ticket_id":"a","expected_revision":"2","required_capabilities":[],"pools":[],"allowed_actor_ids":null}|});
  let released =
    step_as ~actor:worker ~run claimed "ticket.release" {|{"ticket_id":"a","token":"1"}|}
  in
  let cleared =
    step_as
      ~actor:worker
      released
      "allocation.ticket_policy_put"
      {|{"ticket_id":"a","expected_revision":"2","required_capabilities":[],"pools":[],"allowed_actor_ids":null}|}
  in
  print_endline
    (Json.canonical (Actor_eligibility.jsonaf_of_t (policy cleared).allowed_actor_ids));
  ignore
    (step_as
       ~actor:outsider
       ~run:outsider_run
       cleared
       "ticket.claim"
       {|{"ticket_id":"a"}|}
     : State.t);
  let retained = Allocation.Ticket_policy.jsonaf_of_t (policy state) in
  printf
    "stored-policy=%b\n"
    (String.is_substring (Json.canonical retained) ~substring:"allowed_actor_ids");
  [%expect
    {|
    ["worker"]
    Conflict
    null
    stored-policy=true
  |}]
;;

let%expect_test
    "claim_next and current ready/readiness/coordinator views agree on actor rejection"
  =
  let state = actor_fixture () in
  let claim_next =
    Domain_command.decode
      ~method_:"ticket.claim_next"
      ~params:(json {|{"target_run_id":"outsider-run","attempt_id":"next"}|})
    |> ok
  in
  (match
     State.prepare_submission
       state
       ~run:outsider_run
       claim_next
       ~actor:outsider
       ~timestamp:"fixture"
       ~now_unix_ms:100L
     |> ok
   with
   | Prepared _ -> failwith "disallowed actor acquired work"
   | Observed observation ->
     let reasons =
       Json.field (State.Observation.result observation) "explanation"
       |> fun v -> Json.field v "reasons" |> Json.list
     in
     print_endline (Json.text (Json.field (List.hd_exn reasons) "kind")));
  List.iter
    [ "{}"; {|{"target_run_id":"outsider-run"}|}; {|{"target_run_id":"run"}|} ]
    ~f:(fun params ->
      let ids =
        query state "ticket.ready" params
        |> fun data ->
        Json.field data "items"
        |> Json.list
        |> List.map ~f:(fun item -> Json.field item "ticket_id" |> Json.text)
      in
      print_s [%sexp (ids : string list)]);
  let reason =
    query state "ticket.readiness" {|{"ticket_id":"a","target_run_id":"outsider-run"}|}
    |> fun data -> Json.field data "reasons" |> Json.list |> List.hd_exn
  in
  print_endline (Json.canonical (Json.field reason "reason"));
  let result =
    Coordinator.read
      ~workspace:(State.workspace state)
      ~revision:(State.revision state)
      ~head:None
      ~tickets:(State.coordination_tickets ~run:outsider_run ~now_unix_ms:100L state)
      ~runs:(State.agent_runs state)
      ~evidence:(State.evidence state)
      ~communication:(State.communication state)
      ~policies:(State.policies state)
      ~heartbeats:[]
      ~now_unix_ms:100L
      ~params:(json {|{"run_id":"outsider-run","kinds":["allocation_blocked"]}|})
    |> ok
  in
  let item = Json.field result "items" |> Json.list |> List.hd_exn in
  let reasons = Json.field (Json.field item "metadata") "allocation_reasons" in
  print_endline (Json.canonical reasons);
  [%expect
    {|
    actor_not_allowed
    (a)
    ()
    (a)
    {"actor_id":"outsider","kind":"actor_not_allowed"}
    [{"kind":"admission","reason":{"actor_id":"outsider","kind":"actor_not_allowed"}}]
  |}]
;;

let rec forge_actor = function
  | `String "worker" -> `String "outsider"
  | `String "run" -> `String "outsider-run"
  | `Array values -> `Array (List.map values ~f:forge_actor)
  | `Object fields ->
    `Object (List.map fields ~f:(fun (key, value) -> key, forge_actor value))
  | value -> value
;;

let%expect_test
    "forged claim start and reassignment grants reject independently on replay"
  =
  let state = actor_fixture () in
  List.iter
    [ "ticket.claim", {|{"ticket_id":"a"}|}
    ; "ticket.start", {|{"ticket_id":"a","attempt_id":"attempt"}|}
    ]
    ~f:(fun (method_, params) ->
      let prepared = prepare_as ~actor:worker ~run state method_ params |> ok in
      report (State.replay state (forge_actor (State.events prepared))));
  let claimed = step_as ~actor:worker ~run state "ticket.claim" {|{"ticket_id":"a"}|} in
  report
    (prepare_as
       ~actor:worker
       claimed
       "ticket.reassign"
       {|{"ticket_id":"a","expected_revision":"2","claimant_id":"outsider","claimant_run_id":"outsider-run","reason":"Handoff"}|});
  let reassigned =
    prepare_as
      ~actor:worker
      claimed
      "ticket.reassign"
      {|{"ticket_id":"a","expected_revision":"2","claimant_id":"worker","claimant_run_id":"run","reason":"Handoff"}|}
    |> ok
  in
  report (State.replay claimed (forge_actor (State.events reassigned)));
  let released =
    step_as ~actor:worker ~run claimed "ticket.release" {|{"ticket_id":"a","token":"1"}|}
  in
  let selected =
    prepare_as
      ~actor:worker
      ~run
      released
      "ticket.claim_next"
      {|{"target_run_id":"run","attempt_id":"after-release"}|}
    |> ok
  in
  printf
    "reoffered=%s\n"
    (Json.field (Json.field (State.result selected) "claim") "ticket_id" |> Json.text);
  [%expect
    {|
    Blocked actor_not_allowed
    Blocked actor_not_allowed
    Blocked actor_not_allowed
    Blocked actor_not_allowed
    reoffered=a
  |}]
;;

let%expect_test
    "stored event policy and lower-level new attempt replay retain actor invariants"
  =
  let state = actor_fixture () in
  let prepared =
    prepare_as
      ~actor:worker
      state
      "allocation.ticket_policy_put"
      {|{"ticket_id":"a","expected_revision":"1","required_capabilities":[],"pools":[],"allowed_actor_ids":["worker"]}|}
    |> ok
  in
  let rec replace policy = function
    | `Object fields ->
      `Object
        (List.filter_map fields ~f:(fun (key, value) ->
           if String.equal key "allowed_actor_ids"
           then Option.map policy ~f:(fun value -> key, value)
           else Some (key, replace policy value)))
    | `Array values -> `Array (List.map values ~f:(replace policy))
    | value -> value
  in
  List.iter
    [ None
    ; Some (json "[]")
    ; Some (json {|["worker","worker"]|})
    ; Some (json {|["bad id"]|})
    ]
    ~f:(fun policy ->
      report (State.replay state (replace policy (State.events prepared))));
  report
    (Agent_run.prepare
       (State.agent_runs state)
       ~now_unix_ms:100L
       (Attempt_start
          { id = Attempt.Id.of_string "lower" |> ok
          ; run = outsider_run
          ; ticket = Id.Ticket.of_string "a" |> ok
          ; token = 1
          ; sessions = []
          })
       ~actor:outsider
       ~run:(Some outsider_run)
       ~timestamp:"fixture"
       ~sequence:10);
  let reason =
    Actor_eligibility.assess (Actor_eligibility.allowed [ worker ] |> ok) ~actor:outsider
    |> Option.value_exn
  in
  let wire = Api_codec.encode Problem_wire.allocation_reason reason |> ok in
  printf
    "reason-roundtrip=%b\n"
    (Allocation_admission_reason.equal
       reason
       (Api_codec.decode Problem_wire.allocation_reason wire |> ok));
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Blocked actor_not_allowed
    reason-roundtrip=true
  |}]
;;
