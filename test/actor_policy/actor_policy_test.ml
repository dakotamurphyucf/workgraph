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
