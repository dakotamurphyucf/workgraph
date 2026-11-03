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
    ; metrics = []
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

let sample name unit_ value = { Usage_record.Metric.name; unit_; value }

let usage id metrics =
  { Usage_record.id = ok (Usage_record.Id.of_string id)
  ; scope = Run (ok (Id.Run.of_string "run"))
  ; actor = ok (Id.Actor.of_string "agent")
  ; tokens = 3L
  ; elapsed_ms = 4L
  ; metrics
  ; provenance = "caller report"
  ; timestamp = "recorded"
  }
;;

let%expect_test "named samples validate public inputs, durable decode and replay" =
  let request metrics =
    json
      (sprintf
         {|{"usage_id":"source","scope":{"kind":"run","run_id":"run"},"reported_actor_id":"agent","tokens":"0","elapsed_ms":"0","metrics":%s,"provenance":"caller","timestamp":"now"}|}
         metrics)
  in
  List.iter
    [ {|[{"name":"tokens","unit":"count","value":"1"}]|}
    ; {|[{"name":"x","unit":"count","value":"-1"}]|}
    ; {|[{"name":"x","unit":"count","value":"9223372036854775808"}]|}
    ; {|[{"name":"x","unit":"count","value":"01"}]|}
    ; {|[{"name":"é","unit":"count","value":"1"}]|}
    ; {|[{"name":"x","unit":"count","value":"1"},{"name":"x","unit":"ms","value":"1"}]|}
    ; "["
      ^ String.concat
          ~sep:","
          (List.init 17 ~f:(fun i ->
             sprintf {|{"name":"m%d","unit":"count","value":"1"}|} i))
      ^ "]"
    ]
    ~f:(fun metrics ->
      print_s
        [%sexp
          (Result.is_error
             (Domain_command.decode ~method_:"usage.report" ~params:(request metrics))
           : bool)]);
  let original = usage "source" [ sample "a" "count" 1L; sample "z" "ms" 2L ] in
  let prepared =
    ok (Agent_run_policy.prepare Agent_run_policy.empty (Usage_report original))
  in
  let replay =
    List.fold
      (Agent_run_policy.changes prepared)
      ~init:Agent_run_policy.empty
      ~f:(fun state event ->
        ok
          (Agent_run_policy.apply
             state
             (ok
                (Agent_run_policy.Change.of_json (Agent_run_policy.Change.to_json event)))))
  in
  print_s
    [%sexp
      (Usage_record.equal original (List.hd_exn (Agent_run_policy.usage_records replay))
       : bool)];
  let malformed_event =
    { Agent_run_policy.Change.revision = 1
    ; command = Usage_report { original with metrics = List.rev original.metrics }
    }
  in
  print_s
    [%sexp
      (Result.is_error (Agent_run_policy.apply Agent_run_policy.empty malformed_event)
       : bool)];
  let malformed =
    Usage_record.to_json { original with metrics = List.rev original.metrics }
  in
  print_s [%sexp (Result.is_error (Usage_record.of_json malformed) : bool)];
  print_s
    [%sexp
      (Result.is_error
         (Agent_run_policy.prepare
            replay
            (Usage_report { original with metrics = [ sample "a" "count" 2L ] }))
       : bool)];
  [%expect
    {|
    true
    true
    true
    true
    true
    true
    true
    true
    true
    true
    true
    |}]
;;

let%expect_test "immutable sources, explicit units, bounded previews and saturation" =
  let a = usage "a" [ sample "spend" "microUSD" Int64.max_value ] in
  let b = usage "b" [ sample "spend" "microUSD" 1L ] in
  let c = usage "c" [ sample "spend" "centEUR" 9L ] in
  let totals = ok (Usage_record.metric_totals [ a; a; b; c ]) in
  List.iter totals ~f:(fun m ->
    print_s
      [%sexp
        (m.unit_ : string), (m.samples : int), (m.value : int64), (m.overflow : bool)]);
  let records =
    List.init 18 ~f:(fun i ->
      usage ("source-" ^ Int.to_string i) [ sample (sprintf "m%02d" i) "count" 1L ])
  in
  let preview = Workspace_metrics.Usage.of_records records in
  print_s
    [%sexp
      (List.length preview.metrics : int)
    , (preview.metric_series : int)
    , (preview.omitted_metric_series : int)
    , (preview.metric_overflow : bool)];
  let totals = Workspace_metrics.Usage.of_records [ a; a; b ] in
  print_s
    [%sexp
      (totals.observations : int)
    , (totals.tokens : int64)
    , (totals.overflow : bool)
    , (totals.metric_overflow : bool)];
  print_s
    [%sexp
      (Result.is_error (Usage_record.deduplicate [ a; { a with tokens = 4L } ]) : bool)];
  [%expect
    {|
    (centEUR 1 9 false)
    (microUSD 2 9223372036854775807 true)
    (16 18 2 false)
    (2 6 false true)
    true
    |}]
;;
