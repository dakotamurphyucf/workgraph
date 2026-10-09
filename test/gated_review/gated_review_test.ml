open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error p -> failwith p.Problem.message
;;

let json text = ok (Json.parse text)
let worker = ok (Id.Actor.of_string "worker")
let reviewer = ok (Id.Actor.of_string "reviewer")
let other = ok (Id.Actor.of_string "other")
let run = ok (Id.Run.of_string "worker-run")
let ticket = ok (Id.Ticket.of_string "task")

let prepare ?(actor = worker) ?run state method_ params =
  Result.bind
    (Domain_command.decode ~method_ ~params:(json params))
    ~f:(fun command ->
      State.prepare state command ~actor ?run ~timestamp:"2026-10-09T00:00:00Z")
;;

let apply ?actor ?run state method_ params =
  State.candidate (ok (prepare ?actor ?run state method_ params))
;;

let fixture ?(multiple = false) () =
  let state =
    ok (State.empty ~workspace:(ok (Id.Workspace.of_string "review")) ~name:"Review")
  in
  let state = apply state "ticket.create" {|{"ticket_id":"task","title":"Task"}|} in
  let state =
    apply state "run.register" {|{"target_run_id":"worker-run","objective":"Work"}|}
  in
  let state =
    apply ~run state "ticket.start" {|{"ticket_id":"task","attempt_id":"attempt"}|}
  in
  let state =
    apply
      ~run
      state
      "resource.put_text"
      {|{"resource_id":"schema","expected_revision":"0","title":"Schema","text":"{}"}|}
  in
  let digest = Json.hash "{}" in
  let state =
    apply
      ~run
      state
      "contract.put"
      (sprintf
         {|{"contract_id":"contract","expected_revision":"0","schema_version":"1","schema":{"resource_id":"schema","revision":"1","digest":"%s"},"required_inputs":[],"required_outputs":[]}|}
         digest)
  in
  let reviewers =
    if multiple
    then {|[{"kind":"actor","actor_id":"reviewer"},{"kind":"actor","actor_id":"other"}]|}
    else {|[{"kind":"actor","actor_id":"reviewer"}]|}
  in
  let state =
    apply
      ~run
      state
      "review.policy.put"
      (sprintf
         {|{"ticket_id":"task","expected_revision":"0","enabled":true,"reviewers":%s,"separate_actor":true,"validators":[]}|}
         reviewers)
  in
  let state =
    apply
      ~run
      state
      "manifest.publish"
      {|{"manifest_id":"manifest","expected_revision":"0","schema_version":"1","attempt_id":"attempt","ticket_id":"task","contract":{"contract_id":"contract","revision":"1"},"inputs":[],"outputs":[]}|}
  in
  apply
    ~run
    state
    "review.submit"
    {|{"ticket_id":"task","expected_revision":"0","manifest":{"manifest_id":"manifest","revision":"1"}}|}
;;

let submission state =
  Option.value_exn (Evidence.get_submission (State.evidence state) ticket)
;;

let inbox state recipient =
  let params =
    Json.obj
      [ "consumer_id", Json.string "approval"
      ; "recipient", recipient
      ; "after", Json.int 0
      ; "kinds", `Array [ Json.string "message_received" ]
      ]
  in
  Json.list (Json.field (ok (State.query state ~method_:"inbox.read" ~params)) "items")
;;

let actor_recipient = json {|{"kind":"actor","id":"worker"}|}
let run_recipient = json {|{"kind":"run","id":"worker-run"}|}

let body packet =
  Json.parse (Json.text (Json.field (Json.field packet "body_source") "body")) |> ok
;;

let canonical_state state = Json.canonical (State.to_json state)

let%expect_test
    "approval routes exact public refs to recorded submitter without bumping submission"
  =
  let state = fixture ~multiple:true () in
  let before = submission state in
  let prepared =
    ok
      (prepare
         ~actor:reviewer
         state
         "review.record"
         {|{"review_id":"approved","ticket_id":"task","generation":"1","verdict":"approve","evidence":"Checked"}|})
  in
  let approved = State.candidate prepared in
  print_s [%sexp (Evidence.Submission.equal before (submission approved) : bool)];
  let actor_packets = inbox approved actor_recipient in
  let run_packets = inbox approved run_recipient in
  print_s [%sexp (List.length actor_packets : int), (List.length run_packets : int)];
  let payload = body (List.hd_exn actor_packets) in
  ignore (ok (Api_codec.decode Review_approval.codec payload) : Review_approval.t);
  List.iter
    [ "kind"
    ; "ticket_id"
    ; "generation"
    ; "manifest"
    ; "contract"
    ; "review_id"
    ; "gate_status"
    ]
    ~f:(fun field -> printf "%s=%s\n" field (Json.canonical (Json.field payload field)));
  (match
     prepare
       ~run
       approved
       "review.accept"
       {|{"ticket_id":"task","expected_revision":"1"}|}
   with
   | Ok _ -> print_endline "unexpected acceptance"
   | Error problem -> print_s [%sexp (problem.Problem.kind : Problem.kind)]);
  print_s
    [%sexp
      (String.equal
         (canonical_state approved)
         (canonical_state (ok (State.replay state (State.events prepared))))
       : bool)];
  print_s [%sexp (List.length (inbox state actor_recipient) : int)];
  [%expect
    {|
    true
    (1 1)
    kind="review_approved"
    ticket_id="task"
    generation="1"
    manifest={"manifest_id":"manifest","revision":"1"}
    contract={"contract_id":"contract","revision":"1"}
    review_id="approved"
    gate_status="not_evaluated"
    Blocked
    true
    0 |}]
;;

let outcome = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_s [%sexp (p.Problem.kind : Problem.kind)]
;;

let replace_field value key replacement =
  match value with
  | `Object fields -> `Object (List.Assoc.add fields key replacement ~equal:String.equal)
  | _ -> failwith "object required"
;;

let%expect_test
    "independent replay rejects missing modified and misrouted approval notification"
  =
  let state = fixture () in
  let prepared =
    ok
      (prepare
         ~actor:reviewer
         state
         "review.record"
         {|{"review_id":"approved","ticket_id":"task","generation":"1","verdict":"approve","evidence":"Checked"}|})
  in
  let payload = State.events prepared in
  let changes = Json.list (Json.field payload "changes") in
  outcome
    (State.replay
       state
       (replace_field payload "changes" (`Array [ List.hd_exn changes ])));
  List.iteri changes ~f:(fun index _ ->
    if index > 0
    then
      outcome
        (State.replay
           state
           (replace_field
              payload
              "changes"
              (`Array (List.filteri changes ~f:(fun i _ -> not (Int.equal i index)))))));
  let rec alter key replacement = function
    | `Object fields ->
      `Object
        (List.map fields ~f:(fun (field, value) ->
           ( field
           , if String.equal field key then replacement else alter key replacement value )))
    | `Array values -> `Array (List.map values ~f:(alter key replacement))
    | value -> value
  in
  outcome
    (State.replay state (alter "body" (Json.string "Changed approval refs") payload));
  outcome
    (State.replay
       state
       (alter
          "direct_recipients"
          (`Array [ json {|{"kind":"actor","id":"other"}|} ])
          payload));
  [%expect
    {|
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store |}]
;;

let%expect_test
    "large immutable approval evidence does not overflow the bounded notification"
  =
  let state = fixture () in
  let evidence = String.make 65536 'x' in
  let params =
    Json.obj
      [ "review_id", Json.string "large"
      ; "ticket_id", Json.string "task"
      ; "generation", Json.int 1
      ; "verdict", Json.string "approve"
      ; "evidence", Json.string evidence
      ]
  in
  let command = ok (Domain_command.decode ~method_:"review.record" ~params) in
  let prepared = ok (State.prepare state command ~actor:reviewer ~timestamp:"now") in
  let packet = List.hd_exn (inbox (State.candidate prepared) actor_recipient) in
  print_s
    [%sexp
      (String.length (Json.text (Json.field (Json.field packet "body_source") "body"))
       < 4096
       : bool)];
  print_s
    [%sexp
      (String.equal (Json.text (Json.field (State.result prepared) "evidence")) evidence
       : bool)];
  [%expect
    {|
    true
    true |}]
;;

let%expect_test "notification remains bound to original run after a replacement attempt" =
  let state = fixture () in
  let approved =
    apply
      ~actor:reviewer
      state
      "review.record"
      {|{"review_id":"approved","ticket_id":"task","generation":"1","verdict":"approve","evidence":"Checked"}|}
  in
  let before = body (List.hd_exn (inbox approved run_recipient)) in
  let state =
    apply
      ~run
      approved
      "attempt.finish"
      {|{"attempt_id":"attempt","expected_revision":"1","state":"cancelled","evidence":"Replacement planned"}|}
  in
  let state =
    apply
      ~run
      state
      "attempt.start"
      {|{"attempt_id":"replacement","ticket_id":"task","target_run_id":"worker-run","token":"1"}|}
  in
  let after = body (List.hd_exn (inbox state run_recipient)) in
  print_s [%sexp (String.equal (Json.canonical before) (Json.canonical after) : bool)];
  print_endline (Json.canonical (Json.field after "submitter"));
  outcome
    (prepare ~run state "review.accept" {|{"ticket_id":"task","expected_revision":"1"}|});
  [%expect
    {|
    true
    {"actor_id":"worker","run_id":"worker-run","timestamp":"2026-10-09T00:00:00Z"}
    Stale_claim |}]
;;

let%expect_test
    "public approval body decoder validates literals counters and immutable references"
  =
  let state = fixture () in
  let state =
    apply
      ~actor:reviewer
      state
      "review.record"
      {|{"review_id":"approved","ticket_id":"task","generation":"1","verdict":"approve","evidence":"Checked"}|}
  in
  let payload = body (List.hd_exn (inbox state actor_recipient)) in
  List.iter
    [ "kind", Json.string "accepted"
    ; "generation", Json.int 0
    ; "manifest", json {|{"manifest_id":"manifest","revision":"0"}|}
    ; "contract", json {|{"contract_id":"bad id","revision":"1"}|}
    ; "review_serial", Json.int 0
    ; "gate_status", Json.string "allowed"
    ; "submitter", json {|{"actor_id":"bad id","run_id":null,"timestamp":"now"}|}
    ]
    ~f:(fun (field, value) ->
      outcome (Api_codec.decode Review_approval.codec (replace_field payload field value)));
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument |}]
;;

let%expect_test "user message identity collision rejects approval atomically" =
  let state = fixture () in
  let params =
    {|{"review_id":"approved","ticket_id":"task","generation":"1","verdict":"approve","evidence":"Checked"}|}
  in
  let prospective =
    State.candidate (ok (prepare ~actor:reviewer state "review.record" params))
  in
  let packet = List.hd_exn (inbox prospective actor_recipient) in
  let message_id = Json.field (Json.field packet "source") "id" in
  let command =
    Json.obj
      [ "message_id", message_id
      ; "body", Json.string "Existing user message"
      ; "recipients", `Array [ actor_recipient ]
      ; "teams", `Array []
      ]
  in
  let state = apply state "message.send" (Json.canonical command) in
  outcome (prepare ~actor:reviewer state "review.record" params);
  print_s
    [%sexp (Evidence.Submission.equal (submission state) (submission prospective) : bool)];
  print_s [%sexp (List.length (inbox state actor_recipient) : int)];
  [%expect
    {|
    Conflict
    true
    1 |}]
;;
