open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error p -> failwith p.Problem.message
;;

let json text = ok (Json.parse text)
let actor = ok (Id.Actor.of_string "worker")
let other = ok (Id.Actor.of_string "other")
let run = ok (Id.Run.of_string "run")

let empty () =
  ok (State.empty ~workspace:(ok (Id.Workspace.of_string "lifecycle")) ~name:"Lifecycle")
;;

let prepare ?(actor = actor) ?run state method_ params =
  Result.bind
    (Domain_command.decode ~method_ ~params:(json params))
    ~f:(fun command ->
      State.prepare state command ~actor ?run ~timestamp:"2026-10-08T00:00:00Z")
;;

let apply ?actor ?run state method_ params =
  State.candidate (ok (prepare ?actor ?run state method_ params))
;;

let outcome = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_s [%sexp (p.Problem.kind : Problem.kind)]
;;

let get state method_ params =
  ok (State.query state ~method_ ~params:(json params)) |> fun j -> Json.field j "data"
;;

let create state id =
  apply state "ticket.create" (sprintf {|{"ticket_id":"%s","title":"%s"}|} id id)
;;

let complete state id =
  let state = apply state "ticket.claim" (sprintf {|{"ticket_id":"%s"}|} id) in
  apply
    state
    "ticket.complete"
    (sprintf {|{"ticket_id":"%s","token":"1","evidence":"checked"}|} id)
;;

let%expect_test "optional claim guard and composite validation preserve atomic state" =
  let state = create (empty ()) "task" in
  outcome (prepare state "ticket.start" {|{"ticket_id":"task","expected_revision":"0"}|});
  outcome
    (prepare
       state
       "ticket.start"
       {|{"ticket_id":"task","initial_note":"working","attempt_id":"a"}|});
  let context = get state "ticket.context" {|{"ticket_id":"task"}|} in
  print_s [%sexp (Json.field (Json.field context "ticket") "claim" : Jsonaf.t)];
  let started =
    ok (prepare state "ticket.start" {|{"ticket_id":"task","initial_note":"working"}|})
  in
  outcome
    (prepare
       (State.candidate started)
       "ticket.finish"
       {|{"ticket_id":"task","token":"1","evidence":"","handoff":{"summary":"ready","next_steps":"ship"}}|});
  let replayed = ok (State.replay state (State.events started)) in
  print_s
    [%sexp
      (String.equal
         (Json.canonical (State.to_json replayed))
         (Json.canonical (State.to_json (State.candidate started)))
       : bool)];
  [%expect
    {|
    Conflict
    Invalid_argument
    Null
    Invalid_argument
    true |}]
;;

let%expect_test
    "reopen preserves completion and waivers and flags dependents without cascading"
  =
  let state =
    empty ()
    |> fun s ->
    create s "source"
    |> fun s ->
    create s "idle"
    |> fun s ->
    create s "running" |> fun s -> create s "done" |> fun s -> create s "waived"
  in
  let state =
    List.fold [ "idle"; "running"; "done"; "waived" ] ~init:state ~f:(fun s id ->
      apply
        s
        "dependency.add"
        (sprintf {|{"ticket_id":"%s","prerequisite_id":"source"}|} id))
  in
  let state = complete state "source" in
  let state =
    apply
      state
      "dependency.waive"
      {|{"ticket_id":"waived","prerequisite_id":"source","expected_revision":"2","reason":"independent"}|}
  in
  let state = complete state "done" in
  let state = apply state "ticket.claim" {|{"ticket_id":"running"}|} in
  let prepared =
    ok
      (prepare
         ~actor:other
         state
         "ticket.reopen"
         {|{"ticket_id":"source","expected_revision":"3","reason":"new finding"}|})
  in
  let reopened = State.candidate prepared in
  let inbox =
    State.query
      reopened
      ~method_:"inbox.read"
      ~params:
        (json
           {|{"consumer_id":"lifecycle-worker","recipient":{"kind":"actor","id":"worker"},"after":"0"}|})
    |> ok
  in
  print_s [%sexp (List.length (Json.list (Json.field inbox "items")) : int)];
  let status id =
    Json.field
      (Json.field
         (get reopened "ticket.context" (sprintf {|{"ticket_id":"%s"}|} id))
         "ticket")
      "status"
    |> Json.text
  in
  List.iter [ "source"; "idle"; "running"; "done"; "waived" ] ~f:(fun id ->
    print_endline (id ^ ":" ^ status id));
  List.iter [ "idle"; "waived" ] ~f:(fun id ->
    print_s
      [%sexp
        (Json.field
           (get reopened "ticket.readiness" (sprintf {|{"ticket_id":"%s"}|} id))
           "ready"
         : Jsonaf.t)]);
  let ticket =
    Json.field (get reopened "ticket.context" {|{"ticket_id":"running"}|}) "ticket"
  in
  print_s [%sexp (Json.optional ticket "claim" |> Option.is_some : bool)];
  print_s [%sexp (List.length (Json.list (Json.field ticket "reassessments")) : int)];
  outcome
    (prepare
       reopened
       "ticket.update"
       {|{"ticket_id":"done","expected_revision":"5","status":"todo"}|});
  print_s
    [%sexp
      (String.equal
         (Json.canonical (State.to_json reopened))
         (Json.canonical
            (State.to_json (ok (State.replay state (State.events prepared)))))
       : bool)];
  [%expect
    {|
    1
    source:todo
    idle:todo
    running:in_progress
    done:done
    waived:todo
    False
    True
    true
    1
    Conflict
    true |}]
;;

let%expect_test
    "batch creation order and parent completion diagnostic agree with execution"
  =
  let state =
    apply
      (empty ())
      "transaction.apply"
      {|{"operations":[{"method":"ticket.create","params":{"ticket_id":"z","title":"first"}},{"method":"ticket.create","params":{"ticket_id":"a","title":"second","parent_ticket_id":"z"}}]}|}
  in
  let ready =
    get state "ticket.ready" "{}" |> fun j -> Json.field j "items" |> Json.list
  in
  List.iter ready ~f:(fun j -> print_endline (Json.field j "ticket_id" |> Json.text));
  let state = apply state "ticket.claim" {|{"ticket_id":"z"}|} in
  let context = get state "ticket.context" {|{"ticket_id":"z"}|} in
  print_s
    [%sexp
      (Json.field (Json.field context "completion_readiness") "can_complete" : Jsonaf.t)];
  outcome
    (prepare state "ticket.finish" {|{"ticket_id":"z","token":"1","evidence":"checked"}|});
  [%expect
    {|
    z
    a
    False
    Blocked |}]
;;

let%expect_test
    "handoff default preserves intervening activity instead of covering save time"
  =
  let state =
    create (empty ()) "task" |> fun s -> apply s "ticket.claim" {|{"ticket_id":"task"}|}
  in
  let state =
    apply
      state
      "ticket.progress"
      {|{"ticket_id":"task","token":"1","kind":"progress","body":"concurrent detail"}|}
  in
  let state =
    apply
      state
      "handoff.set"
      {|{"ticket_id":"task","expected_revision":"0","token":"1","summary":"handoff","next_steps":"read updates","evidence":"checked"}|}
  in
  let context = get state "ticket.context" {|{"ticket_id":"task"}|} in
  print_endline (Json.field (Json.field context "handoff") "covers_through" |> Json.text);
  print_s
    [%sexp
      (List.length (Json.list (Json.field (Json.field context "updates") "items")) > 0
       : bool)];
  [%expect
    {|
    0
    true |}]
;;

let register state =
  State.prepare
    state
    (Domain_command.Agent_run
       (Agent_run.Command.Register
          { id = run
          ; parent = None
          ; parent_stop_policy = Continue
          ; objective = "Implement"
          ; capabilities = []
          ; process_ref = None
          ; worktree_ref = None
          }))
    ~actor
    ~timestamp:"2026-10-08T00:00:00Z"
  |> ok
  |> State.candidate
;;

let%expect_test "ordinary attempts finish without manifests while explicit policy gates" =
  let state = create (empty ()) "plain" |> register in
  let state =
    apply ~run state "ticket.start" {|{"ticket_id":"plain","attempt_id":"ordinary"}|}
  in
  let prepared =
    ok
      (prepare
         ~run
         state
         "ticket.finish"
         {|{"ticket_id":"plain","token":"1","evidence":"tests passed","handoff":{"summary":"implemented","next_steps":"review"}}|})
  in
  let finished = State.candidate prepared in
  print_endline
    (Json.field
       (Json.field (get finished "ticket.context" {|{"ticket_id":"plain"}|}) "ticket")
       "status"
     |> Json.text);
  print_s
    [%sexp
      (String.equal
         (Json.canonical (State.to_json finished))
         (Json.canonical
            (State.to_json (ok (State.replay state (State.events prepared)))))
       : bool)];
  let gated = create finished "gated" in
  let gated =
    State.prepare
      gated
      (Domain_command.Evidence
         (Evidence.Command.Policy_put
            { ticket = ok (Id.Ticket.of_string "gated")
            ; expected_revision = 0
            ; enabled = true
            ; reviewers = []
            ; separate_actor = false
            ; validators = [ "tests" ]
            ; weakening_reason = None
            }))
      ~actor
      ~run
      ~timestamp:"2026-10-08T00:00:00Z"
    |> ok
    |> State.candidate
  in
  let gated =
    apply ~run gated "ticket.start" {|{"ticket_id":"gated","attempt_id":"configured"}|}
  in
  outcome
    (prepare
       ~run
       gated
       "ticket.finish"
       {|{"ticket_id":"gated","token":"1","evidence":"checked"}|});
  outcome
    (prepare
       ~run
       gated
       "attempt.finish"
       {|{"attempt_id":"configured","expected_revision":"1","state":"completed","evidence":"checked"}|});
  [%expect
    {|
    done
    true
    Blocked
    Blocked |}]
;;

let%expect_test "claim-next preserves batch order and leaf-only is explicit" =
  let state =
    register
      (apply
         (empty ())
         "transaction.apply"
         {|{"operations":[{"method":"ticket.create","params":{"ticket_id":"z","title":"parent"}},{"method":"ticket.create","params":{"ticket_id":"a","title":"child","parent_ticket_id":"z"}}]}|})
  in
  let chosen leaf_only attempt_id =
    let prepared =
      ok
        (prepare
           ~run
           state
           "ticket.claim_next"
           (sprintf
              {|{"target_run_id":"run","attempt_id":"%s","leaf_only":%s}|}
              attempt_id
              (if leaf_only then "true" else "false")))
    in
    print_endline
      (State.result prepared
       |> fun j -> Json.field (Json.field j "claim") "ticket_id" |> Json.text)
  in
  chosen false "default";
  chosen true "leaf";
  [%expect
    {|
    z
    a |}]
;;

let%expect_test "reopened configured work cannot reuse an accepted previous attempt" =
  let ticket = ok (Id.Ticket.of_string "reviewed") in
  let attempt = ok (Attempt.Id.of_string "original") in
  let contract_id = ok (Evidence_id.Contract.of_string "contract") in
  let manifest_id = ok (Evidence_id.Manifest.of_string "manifest") in
  let contract = { Evidence.Contract_ref.id = contract_id; revision = 1 } in
  let manifest = { Evidence.Manifest_ref.id = manifest_id; revision = 1 } in
  let state = create (empty ()) "reviewed" |> register in
  let state =
    apply
      ~run
      state
      "resource.put_text"
      {|{"resource_id":"schema","expected_revision":"0","title":"schema","text":"{}"}|}
  in
  let state =
    apply ~run state "ticket.start" {|{"ticket_id":"reviewed","attempt_id":"original"}|}
  in
  let evidence state command =
    State.prepare
      state
      (Domain_command.Evidence command)
      ~actor
      ~run
      ~timestamp:"2026-10-08T00:00:00Z"
    |> ok
    |> State.candidate
  in
  let state =
    evidence
      state
      (Contract_put
         { id = contract_id
         ; expected_revision = 0
         ; schema_version = 1
         ; schema =
             { id = ok (Id.Resource.of_string "schema")
             ; revision = 1
             ; digest = Json.hash "{}"
             }
         ; required_inputs = []
         ; required_outputs = []
         })
  in
  let state =
    evidence
      state
      (Manifest_publish
         { id = manifest_id
         ; expected_revision = 0
         ; schema_version = 1
         ; attempt
         ; ticket
         ; contract
         ; inputs = []
         ; outputs = []
         })
  in
  let state =
    evidence
      state
      (Policy_put
         { ticket
         ; expected_revision = 0
         ; enabled = true
         ; reviewers = []
         ; separate_actor = false
         ; validators = [ "tests" ]
         ; weakening_reason = None
         })
  in
  let state =
    evidence
      state
      (Submit { ticket; expected_revision = 0; manifest; review_request = None })
  in
  let state =
    evidence
      state
      (Validate
         { id = ok (Evidence_id.Validation.of_string "passed")
         ; manifest
         ; name = "tests"
         ; expected_policy_digest =
             Json.text
               (Json.field
                  (Json.field
                     (ok
                        (State.query
                           state
                           ~method_:"acceptance.policy.effective"
                           ~params:
                             (Json.obj [ "ticket_id", Id.Ticket.jsonaf_of_t ticket ])))
                     "record")
                  "digest")
         ; passed = true
         ; evidence = "passed"
         })
  in
  let state = evidence state (Accept { ticket; expected_revision = 1 }) in
  let state =
    apply
      ~run
      state
      "ticket.finish"
      {|{"ticket_id":"reviewed","token":"1","evidence":"validated"}|}
  in
  let state =
    apply
      ~actor:other
      state
      "ticket.reopen"
      {|{"ticket_id":"reviewed","expected_revision":"3","reason":"replacement required"}|}
  in
  let state =
    apply
      ~run
      state
      "ticket.start"
      {|{"ticket_id":"reviewed","attempt_id":"replacement"}|}
  in
  outcome
    (prepare
       ~run
       state
       "ticket.finish"
       {|{"ticket_id":"reviewed","token":"2","evidence":"old validation exists"}|});
  print_s
    [%sexp
      (Json.field
         (Json.field
            (get state "ticket.readiness" {|{"ticket_id":"reviewed"}|})
            "completion")
         "can_complete"
       : Jsonaf.t)];
  [%expect
    {|
    Blocked
    False |}]
;;

let%expect_test "independent malformed lifecycle requests reject stateless violations" =
  List.iter
    [ "ticket.reopen", {|{"ticket_id":"task","expected_revision":"3","reason":"  "}|}
    ; "ticket.finish", {|{"ticket_id":"task","token":"1","evidence":""}|}
    ; "ticket.finish", {|{"ticket_id":"task","token":"0","evidence":"checked"}|}
    ; "ticket.claim", {|{"ticket_id":"task","lease_duration_ms":"0"}|}
    ; "ticket.start", {|{"ticket_id":"task","lease_duration_ms":"86400001"}|}
    ; "ticket.start", {|{"ticket_id":"task","initial_note":" "}|}
    ; "ticket.claim", {|{"ticket_id":"$created","expected_revision":1}|}
    ]
    ~f:(fun (method_, params) ->
      outcome
        (Api_codec.decode (ok (Ticket_lifecycle.request_codec method_)) (json params)));
  outcome (Ticket_lifecycle.response_codec "unsupported");
  outcome
    (Api_codec.decode
       (ok (Ticket_lifecycle.response_codec "ticket.claim"))
       (json {|{"ticket_id":"bad/id","token":"1"}|}));
  outcome
    (Api_codec.decode
       (ok (Ticket_lifecycle.request_codec "ticket.start"))
       (json {|{"ticket_id":"$created","attempt_id":"fresh"}|}));
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    ok |}]
;;

let replace_field j key value =
  match j with
  | `Object fields ->
    Json.obj
      (List.map fields ~f:(fun (name, original) ->
         name, if String.equal name key then value else original))
  | _ -> failwith "object required"
;;

let modify_ticket_events event ~f =
  replace_field
    event
    "changes"
    (`Array
        (Json.field event "changes"
         |> Json.list
         |> List.map ~f:(function
           | `Array [ `String "Ticket_put"; ticket ] ->
             `Array [ `String "Ticket_put"; f ticket ]
           | change -> change)))
;;

let%expect_test
    "independent replay rejects fabricated initial history and evidence-free completion"
  =
  let before = empty () in
  let created =
    ok (prepare before "ticket.create" {|{"ticket_id":"task","title":"Task"}|})
  in
  let event = State.events created in
  outcome
    (State.replay
       before
       (modify_ticket_events event ~f:(fun ticket ->
          replace_field ticket "status" (`String "done"))));
  outcome
    (State.replay
       before
       (modify_ticket_events event ~f:(fun ticket ->
          replace_field ticket "reopened_token" (Json.int 1))));
  let fabricated =
    json
      {|{"prerequisite":"task","reopened_revision":"1","reason":"invented","actor":"worker","timestamp":"2026-10-08T00:00:00Z"}|}
  in
  outcome
    (State.replay
       before
       (modify_ticket_events event ~f:(fun ticket ->
          replace_field ticket "reassessments" (`Array [ fabricated ]))));
  let unclaimed = State.candidate created in
  let claimed = apply unclaimed "ticket.claim" {|{"ticket_id":"task"}|} in
  let completed =
    ok
      (prepare
         claimed
         "ticket.finish"
         {|{"ticket_id":"task","token":"1","evidence":"checked"}|})
  in
  let evidence_missing =
    replace_field
      (State.events completed)
      "changes"
      (`Array (List.take (Json.list (Json.field (State.events completed) "changes")) 1))
  in
  outcome (State.replay claimed evidence_missing);
  let unowned =
    modify_ticket_events (State.events completed) ~f:(fun ticket ->
      replace_field ticket "revision" (Json.int 2))
    |> fun event -> replace_field event "revision" (Json.int 2)
  in
  outcome (State.replay unclaimed unowned);
  let reopened =
    ok
      (prepare
         (State.candidate completed)
         "ticket.reopen"
         {|{"ticket_id":"task","expected_revision":"3","reason":"correction"}|})
  in
  outcome
    (State.replay
       (State.candidate completed)
       (replace_field (State.events reopened) "actor" (`String "someone_else")));
  [%expect
    {|
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store |}]
;;

let reopening_fixture () =
  let state = create (empty ()) "source" |> fun s -> create s "dependent" in
  let state =
    apply state "dependency.add" {|{"ticket_id":"dependent","prerequisite_id":"source"}|}
  in
  let state = complete state "source" in
  apply state "ticket.start" {|{"ticket_id":"dependent"}|}
;;

let replace_changes payload changes =
  match payload with
  | `Object fields ->
    `Object (List.Assoc.add fields "changes" (`Array changes) ~equal:String.equal)
  | _ -> assert false
;;

let%expect_test "full UTF8 reopening reasons survive bounded generated prose" =
  let state = reopening_fixture () in
  let reason = String.concat (List.init 32768 ~f:(fun _ -> "é")) in
  let command =
    Domain_command.Lifecycle
      (Reopen
         { ticket_id = ok (Id.Ticket.of_string "source"); expected_revision = 3; reason })
  in
  let prepared = ok (State.prepare state command ~actor:other ~timestamp:"now") in
  let reopened = State.candidate prepared in
  List.iter [ "source"; "dependent" ] ~f:(fun id ->
    let context =
      get
        reopened
        "ticket.context"
        (sprintf {|{"ticket_id":"%s","max_bytes":"1048576"}|} id)
    in
    let reassessment =
      Json.field (Json.field context "ticket") "reassessments"
      |> Json.list
      |> List.last_exn
    in
    print_s
      [%sexp (String.equal reason (Json.text (Json.field reassessment "reason")) : bool)]);
  let comments =
    get reopened "comment.list" {|{"max_bytes":"1048576"}|}
    |> fun data ->
    Json.list (Json.field data "items")
    |> List.filter ~f:(fun comment ->
      String.equal (Json.text (Json.field comment "actor_id")) "other")
  in
  print_s
    [%sexp
      (List.length comments : int)
    , (List.for_all comments ~f:(fun comment ->
         let body = Json.text (Json.field comment "body") in
         String.length body <= 65536
         && Result.is_ok
              (Api_codec.decode (Api_codec.text ~max_bytes:65536) (Json.string body))
         && String.is_substring body ~substring:"full reason retained")
       : bool)];
  print_s
    [%sexp
      (String.equal
         (Json.canonical (State.to_json reopened))
         (Json.canonical
            (State.to_json (ok (State.replay state (State.events prepared)))))
       : bool)];
  [%expect
    {|
    true
    true
    (3 true)
    true
    |}]
;;

let%expect_test "replay rejects stripped or altered reopening effects independently" =
  let state = reopening_fixture () in
  let prepared =
    ok
      (prepare
         ~actor:other
         state
         "ticket.reopen"
         {|{"ticket_id":"source","expected_revision":"3","reason":"new finding"}|})
  in
  let payload = State.events prepared in
  let changes = Json.list (Json.field payload "changes") in
  outcome (State.replay state (replace_changes payload [ List.hd_exn changes ]));
  List.iteri changes ~f:(fun index _ ->
    if index > 0
    then
      outcome
        (State.replay
           state
           (replace_changes
              payload
              (List.filteri changes ~f:(fun i _ -> not (Int.equal i index))))));
  let rec alter_body = function
    | `Object fields ->
      `Object
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if String.equal key "body" then Json.string "altered" else alter_body value )))
    | `Array values -> `Array (List.map values ~f:alter_body)
    | value -> value
  in
  outcome (State.replay state (alter_body payload));
  let rec alter_routing = function
    | `Object fields ->
      `Object
        (List.map fields ~f:(fun (key, value) ->
           ( key
           , if String.equal key "direct_recipients"
             then `Array [ json {|{"kind":"actor","id":"other"}|} ]
             else alter_routing value )))
    | `Array values -> `Array (List.map values ~f:alter_routing)
    | value -> value
  in
  outcome (State.replay state (alter_routing payload));
  [%expect
    {|
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store
    |}]
;;

let%expect_test "same-source reopenings and later changes remain one valid transaction" =
  let state = reopening_fixture () in
  let prepared =
    ok
      (prepare
         state
         "transaction.apply"
         {|{"operations":[{"method":"ticket.reopen","params":{"ticket_id":"source","expected_revision":"3","reason":"first finding"}},{"method":"ticket.start","params":{"ticket_id":"source"}},{"method":"ticket.finish","params":{"ticket_id":"source","token":"2","evidence":"first correction"}},{"method":"ticket.reopen","params":{"ticket_id":"source","expected_revision":"6","reason":"second finding"}},{"method":"ticket.update","params":{"ticket_id":"source","expected_revision":"7","title":"Still reopened"}}]}|})
  in
  let reopened = State.candidate prepared in
  let context = get reopened "ticket.context" {|{"ticket_id":"dependent"}|} in
  print_s
    [%sexp
      (Json.text
         (Json.field
            (Json.field
               (get reopened "ticket.context" {|{"ticket_id":"source"}|})
               "ticket")
            "title")
       : string)
    , (List.length (Json.list (Json.field (Json.field context "ticket") "reassessments"))
       : int)];
  let inbox =
    ok
      (State.query
         reopened
         ~method_:"inbox.read"
         ~params:
           (json
              {|{"consumer_id":"repeat","recipient":{"kind":"actor","id":"worker"},"after":"0"}|}))
  in
  print_s [%sexp (List.length (Json.list (Json.field inbox "items")) : int)];
  print_s
    [%sexp
      (String.equal
         (Json.canonical (State.to_json reopened))
         (Json.canonical
            (State.to_json (ok (State.replay state (State.events prepared)))))
       : bool)];
  [%expect
    {|
    ("Still reopened" 2)
    2
    true
    |}]
;;

let%expect_test
    "evidence replay repeats captured attempt ownership with terminal reconciliation \
     exceptions"
  =
  let ticket = ok (Id.Ticket.of_string "reviewed") in
  let attempt = ok (Attempt.Id.of_string "original") in
  let contract_id = ok (Evidence_id.Contract.of_string "contract") in
  let manifest_id = ok (Evidence_id.Manifest.of_string "manifest") in
  let manifest = { Evidence.Manifest_ref.id = manifest_id; revision = 1 } in
  let state = create (empty ()) "reviewed" |> register in
  let state =
    apply
      state
      "resource.put_text"
      {|{"resource_id":"schema","expected_revision":"0","title":"schema","text":"{}"}|}
  in
  let state =
    apply ~run state "ticket.start" {|{"ticket_id":"reviewed","attempt_id":"original"}|}
  in
  let evidence state command =
    ok
      (State.prepare state (Domain_command.Evidence command) ~actor ~run ~timestamp:"now")
  in
  let schema =
    { Evidence.Resource_pin.id = ok (Id.Resource.of_string "schema")
    ; revision = 1
    ; digest = Json.hash "{}"
    }
  in
  let contract expected_revision =
    Evidence.Command.Contract_put
      { id = contract_id
      ; expected_revision
      ; schema_version = 1
      ; schema
      ; required_inputs = []
      ; required_outputs = []
      }
  in
  let state = State.candidate (evidence state (contract 0)) in
  let publication =
    evidence
      state
      (Manifest_publish
         { id = manifest_id
         ; expected_revision = 0
         ; schema_version = 1
         ; attempt
         ; ticket
         ; contract = { id = contract_id; revision = 1 }
         ; inputs = []
         ; outputs = []
         })
  in
  let forge ~actor_id ~run_id payload =
    let rec rewrite = function
      | `Object fields ->
        `Object
          (List.filter_map fields ~f:(fun (key, value) ->
             match key, run_id with
             | "run_id", `Null -> None
             | _ ->
               Some
                 ( key
                 , if String.equal key "actor"
                   then Json.string actor_id
                   else if String.equal key "run" || String.equal key "run_id"
                   then run_id
                   else rewrite value )))
      | `Array items -> `Array (List.map items ~f:rewrite)
      | value -> value
    in
    rewrite payload
  in
  let check label state prepared =
    print_endline label;
    outcome (State.replay state (State.events prepared));
    outcome
      (State.replay
         state
         (forge ~actor_id:"other" ~run_id:(Json.string "run") (State.events prepared)));
    outcome
      (State.replay
         state
         (forge
            ~actor_id:"worker"
            ~run_id:(Json.string "another-run")
            (State.events prepared)));
    outcome
      (State.replay
         state
         (forge ~actor_id:"worker" ~run_id:`Null (State.events prepared)))
  in
  check "manifest publication" state publication;
  let state = State.candidate publication in
  let submitted =
    evidence
      state
      (Submit { ticket; expected_revision = 0; manifest; review_request = None })
  in
  check "submission" state submitted;
  let state = State.candidate submitted in
  let accepted = evidence state (Accept { ticket; expected_revision = 1 }) in
  check "acceptance" state accepted;
  let state = State.candidate accepted in
  let state = State.candidate (evidence state (contract 1)) in
  let acknowledge =
    Evidence.Command.Reconcile
      { serial = 1; expected_revision = 1; disposition = Acknowledge }
  in
  let reconciled = evidence state acknowledge in
  check "active reconciliation" state reconciled;
  let cancelled =
    apply
      ~run
      state
      "attempt.finish"
      {|{"attempt_id":"original","expected_revision":"1","state":"cancelled","evidence":"stopped"}|}
  in
  let reconciled = evidence cancelled acknowledge in
  check "terminal reconciliation" cancelled reconciled;
  let continued =
    evidence
      cancelled
      (Reconcile
         { serial = 1; expected_revision = 1; disposition = Continue "intentional" })
  in
  outcome (State.replay cancelled (State.events continued));
  [%expect
    {|
    manifest publication
    ok
    Conflict
    Stale_claim
    Stale_claim
    submission
    ok
    Conflict
    Stale_claim
    Stale_claim
    acceptance
    ok
    Conflict
    Stale_claim
    Stale_claim
    active reconciliation
    ok
    Conflict
    Stale_claim
    Stale_claim
    terminal reconciliation
    ok
    Stale_claim
    Stale_claim
    Stale_claim
    ok
    |}]
;;
