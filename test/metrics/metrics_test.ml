open Core
open Workgraph

let ok = function
  | Ok v -> v
  | Error e -> failwith e.Problem.message
;;

let json text = ok (Json.parse text)

let initial () =
  ok (State.empty ~workspace:(ok (Id.Workspace.of_string "metrics")) ~name:"Metrics")
;;

let apply state ~timestamp method_ params =
  let command = ok (Domain_command.decode ~method_ ~params:(json params)) in
  let prepared =
    ok (State.prepare state command ~actor:(ok (Id.Actor.of_string "agent")) ~timestamp)
  in
  (* Exercise the durable replay path, not merely the prepared candidate. *)
  ok (State.replay state (State.events prepared))
;;

let at second = sprintf "1970-01-01T00:00:%02dZ" second

let%expect_test
    "status durations follow changes, not unrelated activity; reopenings are transitions"
  =
  let state =
    apply
      (initial ())
      ~timestamp:(at 0)
      "ticket.create"
      {|{"ticket_id":"task","title":"Task"}|}
  in
  let state = apply state ~timestamp:(at 1) "ticket.claim" {|{"ticket_id":"task"}|} in
  let state =
    apply
      state
      ~timestamp:(at 2)
      "ticket.progress"
      {|{"ticket_id":"task","token":"1","body":"working"}|}
  in
  let state =
    apply
      state
      ~timestamp:(at 3)
      "ticket.complete"
      {|{"ticket_id":"task","token":"1","evidence":"checked"}|}
  in
  let state =
    apply
      state
      ~timestamp:(at 4)
      "ticket.reopen"
      {|{"ticket_id":"task","expected_revision":"3","reason":"more work"}|}
  in
  let metrics = State.metrics state ~observed_unix_ms:5000L in
  List.iter metrics.statuses ~f:(fun r ->
    print_s
      [%sexp
        (r.Workspace_metrics.Status.status : Workflow.Category.t)
      , (r.tickets : int)
      , (r.elapsed_ms : int64)
      , (r.unknown_intervals : int)]);
  print_s
    [%sexp
      (( metrics.revision
       , metrics.completion_transitions
       , metrics.reopenings
       , metrics.completed_tickets_with_evidence )
       : int * int * int * int)];
  [%expect
    {|
    (Backlog 0 0 0)
    (Todo 1 2000 0)
    (In_progress 0 2000 0)
    (Done 0 1000 0)
    (Canceled 0 0 0)
    (5 1 1 0)
    |}]
;;

let%expect_test "unparseable and regressed intervals are disclosed" =
  let state =
    apply
      (initial ())
      ~timestamp:"unknown"
      "ticket.create"
      {|{"ticket_id":"task","title":"Task"}|}
  in
  let state = apply state ~timestamp:(at 1) "ticket.claim" {|{"ticket_id":"task"}|} in
  let metrics = State.metrics state ~observed_unix_ms:0L in
  List.iter metrics.statuses ~f:(fun r ->
    if r.unknown_intervals > 0
    then
      print_s
        [%sexp
          (r.status : Workflow.Category.t)
        , (r.elapsed_ms : int64)
        , (r.unknown_intervals : int)]);
  [%expect
    {|
    (Todo 0 1)
    (In_progress 0 1)
    |}]
;;

let%expect_test "reported totals saturate with disclosure instead of wrapping" =
  let record id tokens =
    { Usage_record.id = ok (Usage_record.Id.of_string id)
    ; scope = Run (ok (Id.Run.of_string "run"))
    ; actor = ok (Id.Actor.of_string "agent")
    ; tokens
    ; elapsed_ms = 0L
    ; provenance = "supplied"
    ; timestamp = "recorded"
    }
  in
  let usage =
    Workspace_metrics.Usage.of_records [ record "one" Int64.max_value; record "two" 1L ]
  in
  print_s
    [%sexp
      (usage.observations : int)
    , (Int64.equal usage.tokens Int64.max_value : bool)
    , (usage.overflow : bool)];
  [%expect {| (2 true true) |}]
;;

let%expect_test "metrics reject cross-capture counters and fabricated usage" =
  let planning = State.metrics (initial ()) ~observed_unix_ms:0L in
  let storage_admission =
    List.map
      [ Admission.Limit.Planning_commits
      ; Planning_transaction_bytes
      ; History_commits
      ; History_batch_bytes
      ; Active_uploads
      ; Reserved_upload_bytes
      ]
      ~f:(fun limit -> ok (Admission.create limit ~used:0))
  in
  let create planning history_head =
    Workspace_metrics.create
      planning
      ~observed_unix_ms:0L
      ~history_head
      ~storage_admission
  in
  print_s [%sexp (Result.is_ok (create planning None) : bool)];
  print_s [%sexp (Result.is_ok (create { planning with revision = 1 } None) : bool)];
  print_s [%sexp (Result.is_ok (create planning (Some (String.make 64 'a'))) : bool)];
  let malformed =
    json {|{"observations":"0","tokens":"10","elapsed_ms":"0","overflow":false}|}
  in
  print_s
    [%sexp
      (Result.is_ok (Api_codec.decode Workspace_metrics.Usage.codec malformed) : bool)];
  [%expect
    {|
    true
    false
    false
    false
    |}]
;;
