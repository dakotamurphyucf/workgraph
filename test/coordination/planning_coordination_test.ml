open Core
open Workgraph

let ok = function
  | Ok x -> x
  | Error p -> failwith p.Problem.message
;;

let actor = ok (Id.Actor.of_string "worker")
let operator = ok (Id.Actor.of_string "operator")
let run = ok (Id.Run.of_string "run")
let parse s = ok (Json.parse s)

let prepare ?(actor = actor) ?run ?(now = 100L) t method_ params =
  Result.bind
    (Domain_command.decode ~method_ ~params:(parse params))
    ~f:(fun c ->
      State.prepare t c ~actor ?run ~now_unix_ms:now ~timestamp:"2026-10-08T00:00:00Z")
;;

let step ?actor ?run ?now t method_ params =
  State.candidate (ok (prepare ?actor ?run ?now t method_ params))
;;

let outcome = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_s [%sexp (p.Problem.kind : Problem.kind)]
;;

let fixture () =
  let t =
    ok
      (State.empty
         ~workspace:(ok (Id.Workspace.of_string "coordination"))
         ~name:"Coordination")
  in
  let t = step t "run.register" {|{"target_run_id":"run","objective":"work"}|} in
  step t "ticket.create" {|{"ticket_id":"task","title":"task"}|}
;;

let paths =
  {|{"ticket_id":"task","expected_revision":"0","require_reservations":true,"declarations":[{"target":{"worktree_id":"tree","kind":"subtree","path":"src"},"mode":"exclusive"}]}|}
;;

let target =
  ok
    (Path_scope.create
       ~worktree_id:(ok (Coordination_id.Worktree.of_string "tree"))
       ~kind:Subtree
       ~path:"src")
;;

let data json = Option.value (Json.optional json "data") ~default:json

let context t =
  ok (State.query t ~method_:"ticket.context" ~params:(parse {|{"ticket_id":"task"}|}))
  |> data
;;

let claim t = Json.field (Json.field (context t) "ticket") "claim"

let condition =
  Printf.sprintf
    {|{"condition_id":"deploy","expected_revision":"0","ticket_id":"task","operation_id":"operation","artifact":{"kind":"checksum","source":"deploy","digest":"%s"},"label":"wait","recipients":["worker","operator","worker"]}|}
    (String.make 64 'a')
;;

let signal =
  Printf.sprintf
    {|{"condition_id":"deploy","signal_id":"signal","expected_revision":"1","operation_id":"operation","artifact":{"kind":"checksum","source":"deploy","digest":"%s"},"evidence":[{"kind":"checksum","source":"result","digest":"%s"}],"summary":"done"}|}
    (String.make 64 'a')
    (String.make 64 'b')
;;

let%expect_test "required paths gate no-run starts and grant atomically with attempt" =
  let t = step (fixture ()) "ticket.paths.put" paths in
  outcome (prepare t "ticket.start" {|{"ticket_id":"task"}|});
  let p =
    ok (prepare ~run t "ticket.start" {|{"ticket_id":"task","attempt_id":"try"}|})
  in
  let next = State.candidate p in
  print_s
    [%sexp
      (Option.is_some (Agent_run.get_path_reservation (State.agent_runs next) target)
       : bool)
    , (Option.is_some
         (Agent_run.get_attempt (State.agent_runs next) (ok (Attempt.Id.of_string "try")))
       : bool)];
  print_s
    [%sexp
      (String.equal
         (Json.canonical (State.to_json next))
         (Json.canonical (State.to_json (ok (State.replay t (State.events p)))))
       : bool)];
  [%expect
    {|
    Blocked
    (true true)
    true
    |}]
;;

let%expect_test "late batch failure discards claim note and path ownership" =
  let t = step (fixture ()) "ticket.paths.put" paths in
  outcome
    (prepare
       ~run
       t
       "transaction.apply"
       {|{"operations":[{"method":"ticket.start","params":{"ticket_id":"task","initial_note":"working"}},{"method":"ticket.update","params":{"ticket_id":"task","expected_revision":"0","title":"wrong"}}]}|});
  print_s
    [%sexp
      (claim t : Jsonaf.t)
    , (Option.is_none (Agent_run.get_path_reservation (State.agent_runs t) target) : bool)];
  [%expect
    {|
    Conflict
    (Null true)
    |}]
;;

let%expect_test
    "condition notifications freeze deduplicated creator and owner routing; duplicate \
     signal is silent"
  =
  let t = step ~run (fixture ()) "ticket.start" {|{"ticket_id":"task"}|} in
  let p = ok (prepare ~actor:operator t "condition.put" condition) in
  let declared = State.candidate p in
  let declaration =
    External_condition.get
      (Agent_run.external_conditions (State.agent_runs declared))
      (ok (Coordination_id.Condition.of_string "deploy"))
    |> Option.value_exn
  in
  let message_id =
    External_condition.notification_id (Put declaration) ~sequence:(State.revision t + 1)
  in
  let message =
    Communication.get_message (State.communication declared) message_id
    |> Option.value_exn
  in
  print_s [%sexp (List.length message.recipients : int)];
  outcome (prepare declared "ticket.claim" {|{"ticket_id":"task"}|});
  let p = ok (prepare declared "condition.signal" signal) in
  let satisfied = State.candidate p in
  let duplicate = ok (prepare satisfied "condition.signal" signal) in
  print_s
    [%sexp
      (Json.integer (Json.field (Json.field (State.result duplicate) "signal") "sequence")
       : int)
    , (State.revision declared + 1 : int)];
  let changes = Json.list (Json.field (State.events duplicate) "changes") in
  print_s [%sexp (List.length changes : int)];
  print_s
    [%sexp
      (String.equal
         (Json.canonical (State.to_json declared))
         (Json.canonical
            (State.to_json
               (ok
                  (State.replay
                     t
                     (State.events
                        (ok (prepare ~actor:operator t "condition.put" condition)))))))
       : bool)];
  [%expect
    {|
    2
    Already_claimed
    (5 5)
    1
    true
    |}]
;;

let%expect_test "ticket recovery preserves progress and cancels only exact old attempt" =
  let t =
    step ~run (fixture ()) "ticket.start" {|{"ticket_id":"task","attempt_id":"attempt"}|}
  in
  let request =
    {|{"ticket_id":"task","recovery_id":"ticket-recovery","expected_revision":"2","old_actor_id":"worker","old_run_id":"run","token":"1","expected_lease_revision":"1","confirmation":"isolated","reason":"sandbox stopped"}|}
  in
  let p = ok (prepare ~actor:operator t "ticket.recover" request) in
  let recovered = State.candidate p in
  print_s
    [%sexp
      (claim recovered : Jsonaf.t)
    , (Json.text (Json.field (Json.field (context recovered) "ticket") "status") : string)
    , ((Option.value_exn
          (Agent_run.get_attempt
             (State.agent_runs recovered)
             (ok (Attempt.Id.of_string "attempt"))))
         .state
       : Attempt.State.t)];
  outcome (prepare ~actor:operator recovered "ticket.recover" request);
  print_s
    [%sexp
      (String.equal
         (Json.canonical (State.to_json recovered))
         (Json.canonical (State.to_json (ok (State.replay t (State.events p)))))
       : bool)];
  let changed =
    match State.events p with
    | `Object fields ->
      `Object (List.Assoc.add fields "actor" (Json.string "forged") ~equal:String.equal)
    | _ -> assert false
  in
  outcome (State.replay t changed);
  [%expect
    {|
    (Null in_progress Cancelled)
    Conflict
    true
    Corrupt_store
    |}]
;;

let%expect_test
    "timed attempt replay uses its accepted clock and pure reads disclose missing clock"
  =
  let t =
    step
      (fixture ())
      "reservation.paths.acquire"
      {|{"target_run_id":"run","requests":[{"target":{"worktree_id":"tree","kind":"subtree","path":"src"},"mode":"exclusive","lease_duration_ms":"10"}]}|}
  in
  let t = step t "ticket.paths.put" paths in
  let t = step ~run ~now:101L t "ticket.claim" {|{"ticket_id":"task"}|} in
  let readiness =
    ok
      (State.query t ~method_:"ticket.readiness" ~params:(parse {|{"ticket_id":"task"}|}))
    |> data
  in
  print_s
    [%sexp
      (List.exists
         (Json.list (Json.field readiness "reasons"))
         ~f:(fun reason ->
           String.equal (Json.text (Json.field reason "kind")) "observation_time_required")
       : bool)];
  outcome
    (prepare
       ~run
       ~now:111L
       t
       "attempt.start"
       {|{"attempt_id":"late","target_run_id":"run","ticket_id":"task","token":"1"}|});
  let p =
    ok
      (prepare
         ~run
         ~now:105L
         t
         "attempt.start"
         {|{"attempt_id":"early","target_run_id":"run","ticket_id":"task","token":"1"}|})
  in
  let rec forge = function
    | `Object fields ->
      `Object
        (List.map fields ~f:(fun (key, value) ->
           key, if String.equal key "now_unix_ms" then Json.int 200 else forge value))
    | `Array xs -> `Array (List.map xs ~f:forge)
    | value -> value
  in
  outcome (State.replay t (forge (State.events p)));
  [%expect
    {|
    true
    Blocked
    Blocked
    |}]
;;

let%expect_test "project membership epochs fence A to B to A including moved children" =
  let t = step (fixture ()) "project.create" {|{"project_id":"a","title":"A"}|} in
  let t = step t "project.create" {|{"project_id":"b","title":"B"}|} in
  let t =
    step t "ticket.create" {|{"ticket_id":"root","title":"Root","project_id":"a"}|}
  in
  let t =
    step
      t
      "ticket.create"
      {|{"ticket_id":"child","title":"Child","project_id":"a","parent_ticket_id":"root"}|}
  in
  let move state revision project =
    step
      state
      "ticket.move"
      (Printf.sprintf
         {|{"ticket_id":"root","expected_revision":"%d","project_id":"%s","parent_ticket_id":null,"milestone_id":null}|}
         revision
         project)
  in
  let t = move t 1 "b" |> fun t -> move t 2 "a" |> fun t -> move t 3 "a" in
  let membership id =
    let ticket =
      ok
        (State.query
           t
           ~method_:"ticket.context"
           ~params:(Json.obj [ "ticket_id", Json.string id ]))
      |> data
    in
    Json.integer (Json.field (Json.field ticket "ticket") "membership_revision")
  in
  print_s [%sexp (membership "root" : int), (membership "child" : int)];
  let change =
    ok
      (prepare
         t
         "ticket.move"
         {|{"ticket_id":"root","expected_revision":"4","project_id":"b","parent_ticket_id":null,"milestone_id":null}|})
  in
  let rec invalid = function
    | `Object fields ->
      `Object
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if String.equal key "membership_revision" then Json.int 0 else invalid value
           )))
    | `Array values -> `Array (List.map values ~f:invalid)
    | value -> value
  in
  outcome (State.replay t (invalid (State.events change)));
  [%expect
    {|
    (3 3)
    Invalid_argument
    |}]
;;
