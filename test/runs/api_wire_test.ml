open Core
open Workgraph

let json = Jsonaf.of_string

let unwrap = function
  | Ok value -> value
  | Error error -> failwith error.Problem.message
;;

let report = function
  | Ok _ -> print_endline "ok"
  | Error error -> print_endline error.Problem.message
;;

let%expect_test "run requests use lowercase public enums and distinct target identities" =
  report
    (Agent_run.decode
       ~method_:"run.register"
       ~params:
         (json
            {|{"target_run_id":"worker","objective":"Work","parent_stop_policy":"request_cancel"}|}));
  report
    (Agent_run.decode
       ~method_:"run.register"
       ~params:(json {|{"id":"worker","objective":"Work"}|}));
  report
    (Agent_run.decode
       ~method_:"run.transition"
       ~params:
         (json
            {|{"target_run_id":"worker","expected_revision":"1","status":["Completed"],"evidence":"Done"}|}));
  report
    (Agent_run.decode
       ~method_:"run.register"
       ~params:
         (json {|{"target_run_id":"worker","objective":"Work","parent_run_id":null}|}));
  [%expect
    {|
  ok
  unknown field: id
  expected string
  expected string
 |}]
;;

let%expect_test "checkpoint declarations drive input output and alias schemas" =
  let command =
    Agent_run.decode
      ~method_:"attempt.checkpoint"
      ~params:
        (json
           {|{"attempt_id":"attempt","expected_revision":"1","checkpoint":{"kind":"resource","resource_id":"resource","revision":"3"}}|})
    |> unwrap
  in
  let method_, params = Agent_run.encode command in
  print_endline method_;
  print_endline (Json.canonical params);
  report
    (Agent_run.decode
       ~method_:"attempt.checkpoint"
       ~params:
         (json
            {|{"attempt_id":"attempt","expected_revision":"1","checkpoint":["Resource",{"id":"resource","revision":"3"}]}|}));
  report
    (Agent_run.decode
       ~method_:"attempt.checkpoint"
       ~params:
         (json
            {|{"attempt_id":"attempt","expected_revision":"1","checkpoint":{"kind":"handoff","resource_id":"r","revision":"3"}}|}));
  [%expect
    {|
  attempt.checkpoint
  {"attempt_id":"attempt","checkpoint":{"kind":"resource","resource_id":"resource","revision":"3"},"expected_revision":"1"}
  expected object
  unknown field: resource_id
 |}]
;;

let%expect_test
    "reservation optional indefinite lease is explicit and modes are lowercase"
  =
  List.iter
    [ {|{"target_run_id":"worker","requests":[{"reservation_id":"path","mode":"exclusive"}]}|}
    ; {|{"target_run_id":"worker","requests":[{"reservation_id":"path","mode":"shared","lease_duration_ms":null}]}|}
    ]
    ~f:(fun params ->
      report (Agent_run.decode ~method_:"reservation.acquire" ~params:(json params)));
  report
    (Agent_run.decode
       ~method_:"reservation.acquire"
       ~params:(json {|{"target_run_id":"worker","requests":[]}|}));
  report
    (Agent_run.decode
       ~method_:"reservation.acquire"
       ~params:
         (json
            {|{"target_run_id":"worker","requests":[{"reservation_id":"path","mode":["Exclusive"]}]}|}));
  [%expect
    {|
  ok
  ok
  reservation acquisition requires 1..32 requests
  expected string
 |}]
;;

let%expect_test "all-family batch resolution understands new run identity fields" =
  let params =
    json
      {|{"operations":[{"method":"ticket.create","as":"ticket","params":{"ticket_id":"t","title":"Ticket"}},{"method":"run.register","as":"worker","params":{"target_run_id":"r","objective":"Work"}},{"method":"attempt.start","as":"attempt","params":{"attempt_id":"a","target_run_id":"$worker","ticket_id":"$ticket","token":"1"}},{"method":"run.register","params":{"target_run_id":"child","parent_run_id":"$worker","objective":"Child"}}]}|}
  in
  match Domain_command.decode ~method_:"transaction.apply" ~params with
  | Ok
      (Batch
         [ _
         ; _
         ; Agent_run (Agent_run.Command.Attempt_start { id; run; ticket; _ })
         ; Agent_run (Register { parent; _ })
         ]) ->
    printf
      "%s %s %s parent=%s\n"
      (Attempt.Id.to_string id)
      (Id.Run.to_string run)
      (Id.Ticket.to_string ticket)
      (Option.value_map parent ~default:"missing" ~f:Id.Run.to_string);
    [%expect {|a r t parent=r|}]
  | Ok _ -> failwith "unexpected command sequence"
  | Error error -> failwith error.message
;;

let%expect_test "query codecs do not consume attribution and enforce page guards" =
  report
    (Agent_run_api.Query.decode
       ~method_:"run.get"
       ~params:(json {|{"target_run_id":"r"}|}));
  report (Agent_run_api.Query.decode ~method_:"run.get" ~params:(json {|{"run_id":"r"}|}));
  report
    (Agent_run_api.Query.decode
       ~method_:"attempt.list"
       ~params:(json {|{"ticket_id":"t","target_run_id":"r","offset":"1"}|}));
  report
    (Agent_run_api.Query.decode
       ~method_:"attempt.list"
       ~params:
         (json
            {|{"ticket_id":"t","target_run_id":"r","offset":"1","expected_revision":"2"}|}));
  report (Agent_run_api.Query.decode ~method_:"run.list" ~params:(json {|{"limit":"0"}|}));
  [%expect
    {|
  ok
  unknown field: run_id
  offset pages require expected_revision
  ok
  limit must be 1..100
 |}]
;;

let%expect_test "public run projections preserve persisted enum encoding" =
  let record : Agent_run_event.Record.t =
    { id = Id.Run.of_string "r" |> unwrap
    ; revision = 1
    ; parent = None
    ; parent_stop_policy = Continue
    ; objective = "Work"
    ; actor = Id.Actor.of_string "actor" |> unwrap
    ; capabilities = []
    ; sessions = []
    ; process_ref = None
    ; worktree_ref = None
    ; status = Running
    ; last_observed_unix_ms = None
    ; evidence = ""
    }
  in
  let public = Agent_run_api.run_json record in
  print_endline (Json.text (Json.field public "run_id"));
  print_endline (Jsonaf.to_string (Json.field public "status"));
  print_endline
    (Jsonaf.to_string (Json.field (Agent_run_event.Record.jsonaf_of_t record) "status"));
  report (Api_codec.decode Agent_run_wire.run public);
  [%expect
    {|
  r
  "running"
  ["Running"]
  ok
 |}]
;;

let%expect_test "all advertised methods have executable request and response codecs" =
  let methods = Agent_run_api.mutation_methods @ Agent_run_api.query_methods in
  List.iter methods ~f:(fun method_ ->
    if
      Option.is_none (Agent_run_api.request_codec ~method_)
      || Option.is_none (Agent_run_api.response_codec ~method_)
      || Option.is_none (Agent_run_api.descriptor ~method_)
    then failwith ("missing executable codec: " ^ method_));
  printf
    "mutation methods: %d; query methods: %d\n"
    (List.length Agent_run_api.mutation_methods)
    (List.length Agent_run_api.query_methods);
  (try
     ignore
       (Agent_run_api.validate_result ~method_:"run.register" (json {|{"revision":1}|})
        : unit option)
   with
   | Api_method.Invalid_response (method_, _) -> print_endline method_);
  [%expect
    {|
  mutation methods: 21; query methods: 18
  run.register
 |}]
;;

let%expect_test "run query budgets retain whole records and advance stable cursors" =
  let actor = Id.Actor.of_string "actor" |> unwrap in
  let objective = String.make 5000 'x' in
  let register state id =
    let command =
      Agent_run.decode
        ~method_:"run.register"
        ~params:
          (Json.obj
             [ "target_run_id", Json.string id; "objective", Json.string objective ])
      |> unwrap
    in
    Agent_run.prepare state command ~actor ~run:None ~timestamp:"fixture" ~sequence:1
    |> unwrap
    |> Agent_run.candidate
  in
  let state = register (register Agent_run.empty "a") "b" in
  report
    (Agent_run.query state ~method_:"run.list" ~params:(json {|{"max_bytes":"4096"}|}));
  let result =
    Agent_run.query state ~method_:"run.list" ~params:(json {|{"max_bytes":"8192"}|})
    |> unwrap
  in
  let items = Json.list (Json.field result "items") in
  printf
    "items=%d next=%s omitted=%s\n"
    (List.length items)
    (Json.text (Json.field result "next_offset"))
    (Json.text (Json.field result "omitted"));
  printf
    "objective bytes=%d fits=%b\n"
    (String.length (Json.text (Json.field (List.hd_exn items) "objective")))
    (Api_response.encoded_size (Domain_query Runs) result <= 8192);
  let data = Api_response.project (Domain_query Runs) result |> Api_response.data in
  report
    (Api_codec.encode
       (Option.value_exn (Agent_run_api.response_codec ~method_:"run.list"))
       data);
  report
    (Agent_run.query
       state
       ~method_:"run.get"
       ~params:(json {|{"target_run_id":"a","max_bytes":"4096"}|}));
  let record =
    Agent_run.query
      state
      ~method_:"run.get"
      ~params:(json {|{"target_run_id":"a","max_bytes":"8192"}|})
    |> unwrap
  in
  printf
    "get objective bytes=%d\n"
    (String.length (Json.text (Json.field record "objective")));
  [%expect
    {|
    one complete record cannot fit; increase max_bytes
    items=1 next=1 omitted=1
    objective bytes=5000 fits=true
    ok
    complete record cannot fit; increase max_bytes
    get objective bytes=5000
  |}]
;;

let%expect_test "request adapters preserve caller omissions and nullable identity" =
  let request = json {|{"target_run_id":"worker","objective":"Work"}|} in
  let codec = Option.value_exn (Agent_run_api.request_codec ~method_:"run.register") in
  let retained = Api_codec.decode codec request |> unwrap in
  print_endline (Json.canonical retained);
  let omitted =
    json
      {|{"target_run_id":"worker","requests":[{"reservation_id":"path","mode":"exclusive"}]}|}
  in
  let codec =
    Option.value_exn (Agent_run_api.request_codec ~method_:"reservation.acquire")
  in
  let retained = Api_codec.decode codec omitted |> unwrap in
  print_endline (Json.canonical retained);
  [%expect
    {|
    {"objective":"Work","target_run_id":"worker"}
    {"requests":[{"mode":"exclusive","reservation_id":"path"}],"target_run_id":"worker"}
  |}]
;;

let%expect_test "stateless run requests enforce domain bounds and terminal evidence" =
  let decode method_ fields =
    report (Agent_run.decode ~method_ ~params:(Json.obj fields))
  in
  let register field value =
    decode
      "run.register"
      [ "target_run_id", Json.string "worker"
      ; "objective", Json.string "Work"
      ; field, Json.string value
      ]
  in
  report
    (Agent_run.decode
       ~method_:"run.register"
       ~params:
         (Json.obj
            [ "target_run_id", Json.string "worker"
            ; "objective", Json.string (String.make 16385 'x')
            ]));
  register "process_ref" " ";
  register "process_ref" (String.make 1025 'x');
  register "worktree_ref" (String.make 4097 'x');
  decode
    "run.transition"
    [ "target_run_id", Json.string "worker"
    ; "expected_revision", Json.int 1
    ; "status", Json.string "completed"
    ; "evidence", Json.string " "
    ];
  decode
    "attempt.finish"
    [ "attempt_id", Json.string "attempt"
    ; "expected_revision", Json.int 1
    ; "state", Json.string "running"
    ; "evidence", Json.string "Done"
    ];
  decode
    "attempt.finish"
    [ "attempt_id", Json.string "attempt"
    ; "expected_revision", Json.int 1
    ; "state", Json.string "completed"
    ; "evidence", Json.string " "
    ];
  report
    (Agent_run.decode
       ~method_:"attempt.start"
       ~params:
         (json
            {|{"attempt_id":"attempt","target_run_id":"worker","ticket_id":"ticket","session_ids":["session","session"]}|}));
  report
    (Agent_run.decode
       ~method_:"reservation.acquire"
       ~params:
         (json
            {|{"target_run_id":"worker","requests":[{"reservation_id":"path","mode":"exclusive"},{"reservation_id":"path","mode":"shared"}]}|}));
  [%expect
    {|
    text exceeds byte limit
    text must not be blank
    text exceeds byte limit
    text exceeds byte limit
    terminal runs require evidence
    unknown enum value
    text must not be blank
    duplicate session reference
    duplicate reservation reference
    |}]
;;
