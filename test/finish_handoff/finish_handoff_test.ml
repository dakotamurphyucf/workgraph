open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error p -> failwith p.Problem.message
;;

let json text = ok (Json.parse text)
let actor = ok (Id.Actor.of_string "worker")

let prepare state method_ params =
  Result.bind
    (Domain_command.decode ~method_ ~params:(json params))
    ~f:(fun command ->
      State.prepare state command ~actor ~timestamp:"2026-10-09T00:00:00Z")
;;

let apply state method_ params = State.candidate (ok (prepare state method_ params))

let get state method_ params =
  Json.field (ok (State.query state ~method_ ~params:(json params))) "data"
;;

let current state = get state "handoff.get" {|{"ticket_id":"task"}|}

let history state =
  Json.list (Json.field (get state "handoff.history" {|{"ticket_id":"task"}|}) "items")
;;

let empty () =
  ok
    (State.empty ~workspace:(ok (Id.Workspace.of_string "finish-handoff")) ~name:"Finish")
;;

let started () =
  apply (empty ()) "ticket.create" {|{"ticket_id":"task","title":"Task"}|}
  |> fun state -> apply state "ticket.start" {|{"ticket_id":"task"}|}
;;

let rich () =
  started ()
  |> fun state ->
  apply
    state
    "resource.put_text"
    {|{"resource_id":"proof","expected_revision":"0","title":"Proof","text":"passed"}|}
  |> fun state ->
  apply
    state
    "handoff.set"
    {|{"ticket_id":"task","expected_revision":"0","token":"1","summary":"Earlier","next_steps":"Finish","evidence":"Earlier proof","objective":"Implement feature","completed":"Built API","decisions":"Use immutable pins","blockers":"Review pending","resource_ids":["proof"],"covers_through":"2"}|}
;;

let print_fields value =
  List.iter
    [ "summary"
    ; "next_steps"
    ; "evidence"
    ; "objective"
    ; "completed"
    ; "decisions"
    ; "blockers"
    ; "resource_ids"
    ; "covers_through"
    ]
    ~f:(fun field -> printf "%s=%s\n" field (Json.canonical (Json.field value field)))
;;

let equal_state a b =
  String.equal (Json.canonical (State.to_json a)) (Json.canonical (State.to_json b))
;;

let%expect_test "partial finish preserves rich fields, history, capture and replay" =
  let state = rich () in
  let original = current state in
  let original_history = history state in
  let prepared =
    ok
      (prepare
         state
         "ticket.finish"
         {|{"ticket_id":"task","token":"1","evidence":"Final proof","handoff":{"summary":"Done","next_steps":"Ship"}}|})
  in
  let finished = State.candidate prepared in
  print_fields (current finished);
  print_s [%sexp (List.length (history finished) : int)];
  print_s
    [%sexp
      (List.equal
         (fun a b -> String.equal (Json.canonical a) (Json.canonical b))
         original_history
         (List.take (history finished) 1)
       : bool)];
  print_s
    [%sexp
      (String.equal (Json.canonical original) (Json.canonical (current state)) : bool)];
  print_s
    [%sexp
      (equal_state finished (ok (State.replay state (State.events prepared))) : bool)];
  [%expect
    {|
    summary="Done"
    next_steps="Ship"
    evidence="Final proof"
    objective="Implement feature"
    completed="Built API"
    decisions="Use immutable pins"
    blockers="Review pending"
    resource_ids=["proof"]
    covers_through="2"
    2
    true
    true
    true |}]
;;

let%expect_test "explicit empty fields clear and supplied coverage advances" =
  let state = rich () in
  let finished =
    apply
      state
      "ticket.finish"
      {|{"ticket_id":"task","token":"1","evidence":"Cleared intentionally","handoff":{"summary":"Done","next_steps":"","objective":"","completed":"","decisions":"","blockers":"","resource_ids":[],"covers_through":"3"}}|}
  in
  print_fields (current finished);
  print_s
    [%sexp
      (String.equal
         (Json.canonical (List.hd_exn (history state)))
         (Json.canonical (List.hd_exn (history finished)))
       : bool)];
  [%expect
    {|
    summary="Done"
    next_steps=""
    evidence="Cleared intentionally"
    objective=""
    completed=""
    decisions=""
    blockers=""
    resource_ids=[]
    covers_through="3"
    true |}]
;;

let%expect_test
    "first finish uses empty defaults and finish without patch leaves handoff alone"
  =
  let finished =
    apply
      (started ())
      "ticket.finish"
      {|{"ticket_id":"task","token":"1","evidence":"Checked","handoff":{"summary":"Done","next_steps":""}}|}
  in
  print_fields (current finished);
  let state = rich () in
  let finished =
    apply
      state
      "ticket.finish"
      {|{"ticket_id":"task","token":"1","evidence":"New completion"}|}
  in
  print_s
    [%sexp
      (List.equal
         (fun a b -> String.equal (Json.canonical a) (Json.canonical b))
         (history state)
         (history finished)
       : bool)];
  let without =
    apply
      (started ())
      "ticket.finish"
      {|{"ticket_id":"task","token":"1","evidence":"Checked"}|}
  in
  print_s
    [%sexp
      (Json.field (get without "ticket.context" {|{"ticket_id":"task"}|}) "handoff"
       : Jsonaf.t)];
  [%expect
    {|
    summary="Done"
    next_steps=""
    evidence="Checked"
    objective=""
    completed=""
    decisions=""
    blockers=""
    resource_ids=[]
    covers_through="0"
    true
    Null |}]
;;

let%expect_test "replacement handoff.set still clears omitted rich fields" =
  let state =
    apply
      (rich ())
      "handoff.set"
      {|{"ticket_id":"task","expected_revision":"1","token":"1","summary":"Replacement","next_steps":"","evidence":"Proof"}|}
  in
  print_fields (current state);
  [%expect
    {|
    summary="Replacement"
    next_steps=""
    evidence="Proof"
    objective=""
    completed=""
    decisions=""
    blockers=""
    resource_ids=[]
    covers_through="0" |}]
;;

let%expect_test "blocked completion and invalid resource/cursor publish no staged patch" =
  let state = rich () in
  let blocked =
    apply
      state
      "ticket.hold"
      {|{"ticket_id":"task","expected_revision":"2","reason":"Wait"}|}
  in
  List.iter
    [ ( blocked
      , {|{"ticket_id":"task","token":"1","evidence":"Proof","handoff":{"summary":"Never published","next_steps":""}}|}
      )
    ; ( state
      , {|{"ticket_id":"task","token":"1","evidence":"Proof","handoff":{"summary":"Never published","next_steps":"","resource_ids":["missing"]}}|}
      )
    ; ( state
      , {|{"ticket_id":"task","token":"1","evidence":"Proof","handoff":{"summary":"Never published","next_steps":"","covers_through":"100"}}|}
      )
    ]
    ~f:(fun (state, params) ->
      let before = State.to_json state |> Json.canonical in
      (match prepare state "ticket.finish" params with
       | Ok _ -> print_endline "unexpected success"
       | Error p -> print_s [%sexp (p.Problem.kind : Problem.kind)]);
      print_s [%sexp (String.equal before (State.to_json state |> Json.canonical) : bool)]);
  [%expect
    {|
    Blocked
    true
    Not_found
    true
    Conflict
    true |}]
;;

let%expect_test
    "raw patch retains aliases and omissions while typed commands validate identities"
  =
  let raw =
    json
      {|{"ticket_id":"task","token":"1","evidence":"Proof","handoff":{"summary":"Done","next_steps":"","objective":"","resource_ids":["$proof"]}}|}
  in
  let codec = ok (Ticket_lifecycle.request_codec "ticket.finish") in
  print_s
    [%sexp
      (String.equal
         (Json.canonical raw)
         (Json.canonical (ok (Api_codec.encode codec (ok (Api_codec.decode codec raw)))))
       : bool)];
  (match Ticket_lifecycle.Command.decode ~method_:"ticket.finish" ~params:raw with
   | Ok _ -> print_endline "unexpected success"
   | Error p -> print_s [%sexp (p.Problem.kind : Problem.kind)]);
  let prepared =
    ok
      (prepare
         (started ())
         "transaction.apply"
         {|{"operations":[{"method":"resource.put_text","as":"proof","params":{"resource_id":"proof","expected_revision":"0","title":"Proof","text":"Checked"}},{"method":"ticket.finish","params":{"ticket_id":"task","token":"1","evidence":"Proof","handoff":{"summary":"Done","next_steps":"","resource_ids":["$proof"]}}}]}|})
  in
  print_s
    [%sexp (Json.field (current (State.candidate prepared)) "resource_ids" : Jsonaf.t)];
  [%expect
    {|
    true
    Invalid_argument
    (Array ((String proof))) |}]
;;

let outcome = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_s [%sexp (p.Problem.kind : Problem.kind)]
;;

let%expect_test
    "patch decoder rejects invalid types, bounds, resources and missing required text"
  =
  let codec = ok (Ticket_lifecycle.request_codec "ticket.finish") in
  let params handoff =
    Json.obj
      [ "ticket_id", Json.string "task"
      ; "token", Json.string "1"
      ; "evidence", Json.string "Proof"
      ; "handoff", handoff
      ]
  in
  List.iter
    [ json {|{"summary":"Done","next_steps":"","objective":null}|}
    ; json {|{"summary":"Done","next_steps":"","completed":true}|}
    ; json {|{"summary":"Done","next_steps":"","resource_ids":["bad/id"]}|}
    ; json {|{"summary":"Done","next_steps":"","resource_ids":null}|}
    ; json {|{"summary":"Done","next_steps":"","covers_through":1}|}
    ; json {|{"summary":"Done"}|}
    ; json {|{"next_steps":""}|}
    ; Json.obj
        [ "summary", Json.string "Done"
        ; "next_steps", Json.string ""
        ; "blockers", Json.string (String.make 65537 'x')
        ]
    ; Json.obj
        [ "summary", Json.string "Done"
        ; "next_steps", Json.string ""
        ; ( "resource_ids"
          , `Array (List.init 101 ~f:(fun i -> Json.string (sprintf "r%d" i))) )
        ]
    ]
    ~f:(fun handoff -> outcome (Api_codec.decode codec (params handoff)));
  let command =
    ok
      (Ticket_lifecycle.Command.decode
         ~method_:"ticket.finish"
         ~params:
           (params
              (json
                 {|{"summary":"Done","next_steps":"","objective":"New","resource_ids":[]}|})))
  in
  let _, encoded = ok (Ticket_lifecycle.Command.encode command) in
  print_s
    [%sexp
      (String.equal
         (Json.canonical encoded)
         (Json.canonical
            (params
               (json
                  {|{"summary":"Done","next_steps":"","objective":"New","resource_ids":[]}|})))
       : bool)];
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
    true |}]
;;

let replace_field value key replacement =
  match value with
  | `Object fields -> `Object (List.Assoc.add fields key replacement ~equal:String.equal)
  | _ -> failwith "object required"
;;

let%expect_test
    "independent malformed replay rejects bad handoff coverage and resource references"
  =
  let state = rich () in
  let prepared =
    ok
      (prepare
         state
         "ticket.finish"
         {|{"ticket_id":"task","token":"1","evidence":"Proof","handoff":{"summary":"Done","next_steps":""}}|})
  in
  let forge field replacement =
    replace_field
      (State.events prepared)
      "changes"
      (`Array
          (List.map
             (Json.list (Json.field (State.events prepared) "changes"))
             ~f:(function
               | `Array [ `String "Handoff_put"; handoff ] ->
                 `Array [ `String "Handoff_put"; replace_field handoff field replacement ]
               | change -> change)))
  in
  outcome (State.replay state (forge "covers_through" (Json.int 100)));
  outcome (State.replay state (forge "resources" (`Array [ Json.string "missing" ])));
  print_s
    [%sexp
      (equal_state
         (State.candidate prepared)
         (ok (State.replay state (State.events prepared)))
       : bool)];
  [%expect
    {|
    Conflict
    Not_found
    true |}]
;;

let%expect_test "supplied rich fields replace values in one finish patch" =
  let state =
    apply
      (rich ())
      "resource.put_text"
      {|{"resource_id":"replacement","expected_revision":"0","title":"Replacement","text":"New proof"}|}
  in
  let finished =
    apply
      state
      "ticket.finish"
      {|{"ticket_id":"task","token":"1","evidence":"New proof","handoff":{"summary":"Revised","next_steps":"Release","objective":"New objective","completed":"New work","decisions":"New decision","blockers":"New blocker","resource_ids":["replacement"],"covers_through":"3"}}|}
  in
  print_fields (current finished);
  [%expect
    {|
    summary="Revised"
    next_steps="Release"
    evidence="New proof"
    objective="New objective"
    completed="New work"
    decisions="New decision"
    blockers="New blocker"
    resource_ids=["replacement"]
    covers_through="3" |}]
;;

let%expect_test "blocked finish leaves active attempt and handoff unchanged" =
  let run = ok (Id.Run.of_string "run") in
  let state = apply (empty ()) "ticket.create" {|{"ticket_id":"task","title":"Task"}|} in
  let state =
    apply state "run.register" {|{"target_run_id":"run","objective":"Finish"}|}
  in
  let prepare_run state method_ params =
    Result.bind
      (Domain_command.decode ~method_ ~params:(json params))
      ~f:(fun command ->
        State.prepare state command ~actor ~run ~timestamp:"2026-10-09T00:00:00Z")
  in
  let state =
    State.candidate
      (ok
         (prepare_run
            state
            "ticket.start"
            {|{"ticket_id":"task","attempt_id":"attempt"}|}))
  in
  let state =
    State.candidate
      (ok
         (prepare_run
            state
            "handoff.set"
            {|{"ticket_id":"task","expected_revision":"0","token":"1","summary":"Before","next_steps":"Finish","evidence":"Before","objective":"Preserved"}|}))
  in
  let state =
    apply
      state
      "ticket.hold"
      {|{"ticket_id":"task","expected_revision":"2","reason":"Wait"}|}
  in
  let before = Json.canonical (State.to_json state) in
  outcome
    (prepare_run
       state
       "ticket.finish"
       {|{"ticket_id":"task","token":"1","evidence":"Proof","handoff":{"summary":"Never published","next_steps":"","objective":"Never published"}}|});
  print_s [%sexp (String.equal before (Json.canonical (State.to_json state)) : bool)];
  print_endline
    (Json.text
       (Json.field
          (ok
             (State.query
                state
                ~method_:"attempt.get"
                ~params:(json {|{"attempt_id":"attempt"}|})))
          "state"));
  print_endline (Json.text (Json.field (current state) "summary"));
  [%expect
    {|
    Blocked
    true
    running
    Before |}]
;;
