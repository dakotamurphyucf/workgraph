open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error p -> failwith p.Problem.message
;;

let json text = ok (Json.parse text)
let actor = ok (Id.Actor.of_string "worker")
let run = ok (Id.Run.of_string "run")
let attempt = ok (Attempt.Id.of_string "attempt")
let ticket = ok (Id.Ticket.of_string "task")

let empty () =
  ok (State.empty ~workspace:(ok (Id.Workspace.of_string "results")) ~name:"Results")
;;

let prepare ?run state method_ params =
  let command = ok (Domain_command.decode ~method_ ~params:(json params)) in
  State.prepare state command ~actor ?run ~timestamp:"2026-10-09T00:00:00Z"
;;

let apply ?run state method_ params =
  State.candidate (ok (prepare ?run state method_ params))
;;

let result prepared = State.result prepared |> Json.canonical |> print_endline

let entity_revision prepared =
  Json.integer (Json.field (State.result prepared) "revision")
;;

let register id =
  Agent_run_command.Register
    { id = ok (Id.Run.of_string id)
    ; parent = None
    ; parent_stop_policy = Continue
    ; objective = "Work"
    ; capabilities = []
    ; process_ref = None
    ; worktree_ref = None
    }
;;

let pure ?(run = None) state command =
  ok (Agent_run.prepare state command ~actor ~run ~timestamp:"now" ~sequence:1)
;;

let checked command state =
  let prepared = pure state command in
  let method_, _ = Agent_run.encode command in
  ignore
    (Agent_run_api.validate_result ~method_ (Agent_run.result prepared) : unit option);
  let replayed =
    List.fold (Agent_run.changes prepared) ~init:state ~f:(fun state change ->
      ok (Agent_run.apply state change))
  in
  print_s
    [%sexp
      (String.equal
         (Json.canonical (Agent_run.to_json replayed))
         (Json.canonical (Agent_run.to_json (Agent_run.candidate prepared)))
       : bool)];
  print_endline (Json.canonical (Agent_run.result prepared));
  Agent_run.candidate prepared
;;

let%expect_test
    "run and allocation mutations return each entity revision after unrelated \
     coordination"
  =
  let state = Agent_run.candidate (pure Agent_run.empty (register "first")) in
  let state =
    checked (Pool_put { name = "build"; expected_revision = 0; limit = 2 }) state
  in
  let state = checked (register "run") state in
  let state =
    checked (Observe { id = run; expected_revision = 1; observed_unix_ms = 100L }) state
  in
  let state =
    checked
      (Link_session
         { id = run
         ; expected_revision = 2
         ; session = ok (Session_id.of_string "session")
         })
      state
  in
  let state =
    checked (Pool_put { name = "build"; expected_revision = 1; limit = 3 }) state
  in
  let state =
    checked
      (Ticket_policy_put
         { ticket
         ; expected_revision = 0
         ; required_capabilities = []
         ; pools = [ "build" ]
         })
      state
  in
  let state =
    checked
      (Ticket_policy_put
         { ticket
         ; expected_revision = 1
         ; required_capabilities = [ "ocaml" ]
         ; pools = [ "build" ]
         })
      state
  in
  ignore
    (checked
       (Transition
          { id = run; expected_revision = 3; status = Completed; evidence = "Done" })
       state
     : Agent_run.t);
  [%expect
    {|
    true
    {"revision":"1"}
    true
    {"revision":"1"}
    true
    {"revision":"2"}
    true
    {"revision":"3"}
    true
    {"revision":"2"}
    true
    {"revision":"1"}
    true
    {"revision":"2"}
    true
    {"revision":"4"} |}]
;;

let%expect_test "attempt receipts identify current attempt state and entity revision" =
  let state = Agent_run.candidate (pure Agent_run.empty (register "first")) in
  let state = Agent_run.candidate (pure state (register "run")) in
  let state =
    checked (Attempt_start { id = attempt; run; ticket; token = 1; sessions = [] }) state
  in
  let state =
    checked
      (Attempt_checkpoint
         { id = attempt
         ; expected_revision = 1
         ; checkpoint = Handoff { ticket; revision = 1 }
         })
      state
  in
  ignore
    (checked
       (Attempt_finish
          { id = attempt; expected_revision = 2; state = Completed; evidence = "Checked" })
       state
     : Agent_run.t);
  [%expect
    {|
    true
    {"attempt_id":"attempt","revision":"1","state":"running"}
    true
    {"attempt_id":"attempt","revision":"2","state":"running"}
    true
    {"attempt_id":"attempt","revision":"3","state":"completed"} |}]
;;

let started () =
  let state = apply (empty ()) "ticket.create" {|{"ticket_id":"task","title":"Task"}|} in
  apply state "run.register" {|{"target_run_id":"run","objective":"Work"}|}
;;

let%expect_test
    "lifecycle receipts expose created/completed attempts and omit absent attempts"
  =
  let state = started () in
  let started_transaction =
    ok (prepare ~run state "ticket.start" {|{"ticket_id":"task","attempt_id":"attempt"}|})
  in
  result started_transaction;
  let finished =
    ok
      (prepare
         ~run
         (State.candidate started_transaction)
         "ticket.finish"
         {|{"ticket_id":"task","token":"1","evidence":"Checked"}|})
  in
  result finished;
  print_s
    [%sexp
      (String.equal
         (Json.canonical (State.to_json (State.candidate finished)))
         (Json.canonical
            (State.to_json
               (ok
                  (State.replay
                     (State.candidate started_transaction)
                     (State.events finished)))))
       : bool)];
  let state = apply state "ticket.start" {|{"ticket_id":"task"}|} in
  result
    (ok
       (prepare
          state
          "ticket.finish"
          {|{"ticket_id":"task","token":"1","evidence":"Checked"}|}));
  let allocated =
    ok
      (prepare
         ~run
         (started ())
         "ticket.claim_next"
         {|{"target_run_id":"run","attempt_id":"allocated"}|})
  in
  result allocated;
  [%expect
    {|
    {"attempt":{"attempt_id":"attempt","revision":"1","state":"running"},"ticket_id":"task","token":"1"}
    {"attempt":{"attempt_id":"attempt","revision":"2","state":"completed"},"completed":true,"ticket_revision":"3"}
    true
    {"completed":true,"ticket_revision":"3"}
    {"attempt":{"attempt_id":"allocated","revision":"1","state":"running"},"claim":{"ticket_id":"task","token":"1"},"kind":"selected"}
    |}]
;;

let%expect_test "reservation aggregate counters are explicitly coordination revisions" =
  let state = Agent_run.candidate (pure Agent_run.empty (register "run")) in
  let name = ok (Reservation.Name.of_string "build") in
  let state =
    checked
      (Reservation_acquire
         { run
         ; requests = [ { Reservation.name; mode = Exclusive; lease_duration_ms = None } ]
         })
      state
  in
  ignore (checked (Reservation_release { run; name; token = 1 }) state : Agent_run.t);
  let prepared =
    ok
      (prepare
         (started ())
         "ticket.paths.put"
         {|{"ticket_id":"task","expected_revision":"0","declarations":[]}|})
  in
  result prepared;
  [%expect
    {|
    true
    {"coordination_revision":"2"}
    true
    {"coordination_revision":"3"}
    {"revision":"1"} |}]
;;

let outcome = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_s [%sexp (p.Problem.kind : Problem.kind)]
;;

let%expect_test
    "attempt/lifecycle result decoders reject malformed identities counters and states"
  =
  List.iter
    [ "attempt.start", {|{"attempt_id":"bad/id","revision":"1","state":"running"}|}
    ; "attempt.start", {|{"attempt_id":"a","revision":"0","state":"running"}|}
    ; "attempt.start", {|{"attempt_id":"a","revision":"1","state":"completed"}|}
    ; "attempt.finish", {|{"attempt_id":"a","revision":"2","state":"running"}|}
    ; "reservation.acquire", {|{"revision":"2"}|}
    ]
    ~f:(fun (method_, params) ->
      outcome
        (Api_codec.decode
           (Option.value_exn (Agent_run_api.response_codec ~method_))
           (json params)));
  List.iter
    [ ( "ticket.start"
      , {|{"ticket_id":"task","token":"1","attempt":{"attempt_id":"a","revision":"1","state":"completed"}}|}
      )
    ; ( "ticket.finish"
      , {|{"completed":true,"ticket_revision":"3","attempt":{"attempt_id":"a","revision":"2","state":"failed"}}|}
      )
    ; "ticket.finish", {|{"completed":true,"ticket_revision":"3","attempt":null}|}
    ]
    ~f:(fun (method_, params) ->
      outcome
        (Api_codec.decode (ok (Ticket_lifecycle.response_codec method_)) (json params)));
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument |}]
;;

let overview ?(heartbeats = []) ?(limit = 50) ?cursor state now =
  Coordinator.read
    ~workspace:(State.workspace state)
    ~revision:(State.revision state)
    ~head:(Some "capture")
    ~tickets:(State.coordination_tickets state)
    ~runs:(State.agent_runs state)
    ~evidence:(State.evidence state)
    ~communication:(State.communication state)
    ~policies:(State.policies state)
    ~heartbeats
    ~now_unix_ms:now
    ~params:
      (Json.obj
         ([ "stale_after_ms", Json.int64 100L; "limit", Json.int limit ]
          @ Option.to_list (Option.map cursor ~f:(fun cursor -> "cursor", cursor))))
;;

let kinds value =
  List.map
    (Json.list (Json.field value "items"))
    ~f:(fun row -> Json.text (Json.field row "kind"))
;;

let%expect_test "unobserved runs stay visible without stale ownership warnings" =
  let state =
    apply ~run (started ()) "ticket.start" {|{"ticket_id":"task","attempt_id":"attempt"}|}
  in
  let record = Option.value_exn (Agent_run.get_run (State.agent_runs state) run) in
  print_s
    [%sexp
      (Agent_run.liveness record ~now_unix_ms:200L ~after_ms:100L : Agent_run.Liveness.t)];
  print_s [%sexp (Agent_run.stale record ~now_unix_ms:200L ~after_ms:100L : bool)];
  print_s [%sexp (kinds (ok (overview state 200L)) : string list)];
  let observed =
    apply
      state
      "run.observe"
      {|{"target_run_id":"run","expected_revision":"1","observed_unix_ms":"100"}|}
  in
  print_s [%sexp (kinds (ok (overview observed 150L)) : string list)];
  print_s [%sexp (kinds (ok (overview observed 200L)) : string list)];
  print_s
    [%sexp (kinds (ok (overview ~heartbeats:[ run, 200L ] observed 250L)) : string list)];
  print_s [%sexp (kinds (ok (overview observed 50L)) : string list)];
  let capture = ok (overview ~limit:1 state 200L) in
  let cursor = Json.field capture "next_cursor" in
  let second = ok (overview ~limit:1 ~cursor state 300L) in
  print_endline (Json.text (Json.field second "captured_now_unix_ms"));
  print_s [%sexp (kinds second : string list)];
  outcome (overview ~limit:1 ~cursor ~heartbeats:[ run, 200L ] state 300L);
  [%expect
    {|
    Unobserved
    false
    (active_attempt unobserved_run)
    (active_attempt)
    (active_attempt stale_ownership stale_run)
    (active_attempt)
    (active_attempt stale_ownership stale_run)
    200
    (unobserved_run)
    Conflict |}]
;;

let%expect_test "coordinator row decoders cannot label unobserved liveness stale" =
  List.iter
    [ {|{"kind":"stale_run","source":{"kind":"run","run_id":"run"},"metadata":{"status":"running","last_observed_unix_ms":null,"liveness":"unobserved","liveness_is_advisory":true}}|}
    ; {|{"kind":"unobserved_run","source":{"kind":"run","run_id":"run"},"metadata":{"status":"running","last_observed_unix_ms":"1","liveness":"stale","liveness_is_advisory":true}}|}
    ]
    ~f:(fun value -> outcome (Api_codec.decode Coordinator_wire.Item.codec (json value)));
  [%expect
    {|
    Invalid_argument
    Invalid_argument |}]
;;

let%expect_test "every coordination mutation schema names its guarded revision family" =
  let counts = ref (0, 0, 0) in
  List.iter Agent_run_api.mutation_methods ~f:(fun method_ ->
    let fields =
      Api_codec.field_names (Option.value_exn (Agent_run_api.response_codec ~method_))
      |> Option.value_exn
    in
    let entity, attempt, coordination = !counts in
    match method_ with
    | "run.register"
    | "run.transition"
    | "run.observe"
    | "run.link_session"
    | "allocation.pool_put"
    | "allocation.ticket_policy_put"
    | "ticket.paths.put" ->
      assert (List.equal String.equal fields [ "revision" ]);
      counts := entity + 1, attempt, coordination
    | "attempt.start" | "attempt.checkpoint" | "attempt.finish" ->
      assert (List.equal String.equal fields [ "attempt_id"; "revision"; "state" ]);
      counts := entity, attempt + 1, coordination
    | "reservation.acquire"
    | "reservation.renew"
    | "reservation.release"
    | "run.action_acknowledge"
    | "reservation.paths.acquire"
    | "reservation.path.renew"
    | "reservation.path.release"
    | "reservation.recover"
    | "reservation.path.recover"
    | "condition.put"
    | "condition.signal" ->
      assert (List.mem fields "coordination_revision" ~equal:String.equal);
      assert (not (List.mem fields "revision" ~equal:String.equal));
      counts := entity, attempt, coordination + 1
    | _ -> failwith ("unclassified mutation receipt: " ^ method_));
  print_s [%sexp (!counts : int * int * int)];
  [%expect {| (7 3 11) |}]
;;

let%expect_test
    "unobserved named ownership is not stale but lease expiry stays authoritative"
  =
  let state = apply ~run (started ()) "ticket.start" {|{"ticket_id":"task"}|} in
  let state =
    apply
      ~run
      state
      "reservation.acquire"
      {|{"target_run_id":"run","requests":[{"reservation_id":"indefinite","mode":"exclusive"}]}|}
  in
  print_s [%sexp (kinds (ok (overview state 200L)) : string list)];
  let command =
    ok
      (Domain_command.decode
         ~method_:"reservation.acquire"
         ~params:
           (json
              {|{"target_run_id":"run","requests":[{"reservation_id":"timed","mode":"exclusive","lease_duration_ms":"10"}]}|}))
  in
  let prepared =
    ok (State.prepare state ~run ~now_unix_ms:100L command ~actor ~timestamp:"now")
  in
  print_s [%sexp (kinds (ok (overview (State.candidate prepared) 110L)) : string list)];
  print_s [%sexp (kinds (ok (overview (State.candidate prepared) 99L)) : string list)];
  [%expect
    {|
    (reservation unobserved_run)
    (expired_ownership reservation reservation unobserved_run)
    (reservation reservation stale_ownership unobserved_run) |}]
;;
