open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error error -> failwith error.Problem.message
;;

let json text = Json.parse text |> ok
let actor name = Id.Actor.of_string name |> ok

let prepare ?(by = "worker") ?run ?now_unix_ms state method_ params =
  let command = Domain_command.decode ~method_ ~params:(json params) |> ok in
  State.prepare ?run ?now_unix_ms state command ~actor:(actor by) ~timestamp:"recorded"
;;

let step ?by ?run ?now_unix_ms state method_ params =
  let prepared = prepare ?by ?run ?now_unix_ms state method_ params |> ok in
  let replayed = State.replay state (State.events prepared) |> ok in
  if
    not
      (String.equal
         (Json.canonical (State.to_json replayed))
         (Json.canonical (State.to_json (State.candidate prepared))))
  then failwith "candidate/replay differs";
  State.candidate prepared
;;

let empty () =
  State.empty ~workspace:(Id.Workspace.of_string "amendments" |> ok) ~name:"Amendments"
  |> ok
;;

let task ?now_unix_ms ?(timed = false) () =
  let state = step (empty ()) "ticket.create" {|{"ticket_id":"task","title":"Task"}|} in
  step
    ?now_unix_ms
    state
    (if timed then "ticket.start" else "ticket.claim")
    (if timed
     then {|{"ticket_id":"task","expected_revision":"1","lease_duration_ms":"10"}|}
     else {|{"ticket_id":"task","expected_revision":"1"}|})
;;

let publish state =
  step
    ~by:"lead"
    state
    "ticket.amendment.publish"
    {|{"amendment_id":"instruction","ticket_id":"task","expected_revision":"0","title":"New instruction","source":{"kind":"text","body":"Do the updated work"},"require_ack":true}|}
;;

let ack =
  {|{"amendment_id":"instruction","expected_revision":"1","ticket_id":"task","token":"1"}|}
;;

let finish = {|{"ticket_id":"task","token":"1","evidence":"Checked"}|}

let report = function
  | Ok _ -> print_endline "ok"
  | Error error -> print_s [%sexp (error.Problem.kind : Problem.kind)]
;;

let query state method_ params =
  try
    State.query state ~method_ ~params:(json params)
    |> ok
    |> fun result -> Json.field result "data"
  with
  | Api_method.Invalid_response (_, error) ->
    failwith (Sexp.to_string_hum (Problem.sexp_of_t error))
;;

let set json key value =
  match json with
  | `Object fields -> Json.obj (List.Assoc.add fields key value ~equal:String.equal)
  | _ -> assert false
;;

let rec replace_field value key f =
  match value with
  | `Object fields ->
    Json.obj
      (List.map fields ~f:(fun (name, value) ->
         name, if String.equal name key then f value else replace_field value key f))
  | `Array items -> `Array (List.map items ~f:(fun value -> replace_field value key f))
  | `String _ | `Number _ | `True | `False | `Null -> value
;;

let%expect_test
    "planning admission, exact ack, progress and historical Done all replay consistently"
  =
  let state = publish (task ()) in
  report (prepare state "ticket.finish" finish);
  let context = query state "ticket.context" {|{"ticket_id":"task"}|} in
  print_s
    [%sexp
      (Json.field (Json.field context "amendments") "items" |> Json.list |> List.length
       : int)
    , (Json.field (Json.field context "pending_amendment_acknowledgements") "items"
       |> Json.list
       |> List.length
       : int)];
  let brief = query state "ticket.brief" {|{"ticket_id":"task","max_bytes":"4096"}|} in
  print_s [%sexp (Json.field (Json.field brief "amendments") "total" : Jsonaf.t)];
  let state = step state "ticket.amendment.acknowledge" ack in
  let state =
    step
      state
      "ticket.progress"
      {|{"ticket_id":"task","token":"1","body":"Progress keeps accepted instructions"}|}
  in
  report (prepare state "ticket.finish" finish);
  let state = step state "ticket.finish" finish in
  let context = query state "ticket.context" {|{"ticket_id":"task"}|} in
  print_s [%sexp (Json.field (Json.field context "ticket") "claim" : Jsonaf.t)];
  report
    (prepare
       ~by:"lead"
       state
       "ticket.amendment.publish"
       {|{"amendment_id":"late-required","ticket_id":"task","expected_revision":"0","title":"Late","source":{"kind":"text","body":"Requires reopen"},"require_ack":true}|});
  let state =
    step
      ~by:"lead"
      state
      "ticket.amendment.publish"
      {|{"amendment_id":"information","ticket_id":"task","expected_revision":"0","title":"Information","source":{"kind":"text","body":"For reference"}}|}
  in
  let context = query state "ticket.context" {|{"ticket_id":"task"}|} in
  let revision = Json.field (Json.field context "ticket") "revision" |> Json.text in
  report
    (prepare
       state
       "ticket.update"
       (sprintf
          {|{"ticket_id":"task","expected_revision":"%s","title":"Still done"}|}
          revision));
  print_s
    [%sexp
      (Ticket_amendment.head
         (State.amendments state)
         (Amendment_id.of_string "instruction" |> ok)
       |> Option.is_some
       : bool)];
  [%expect
    {|
   Blocked
   (1 1)
   (String 1)
   ok
   Null
   Blocked
   ok
   true
   |}]
;;

let%expect_test
    "durable replay rejects omitted authority effects and tampered timed Ack clock"
  =
  let initial = task ~timed:true ~now_unix_ms:100L () in
  let publication =
    prepare
      ~by:"lead"
      initial
      "ticket.amendment.publish"
      {|{"amendment_id":"instruction","ticket_id":"task","expected_revision":"0","title":"New","source":{"kind":"text","body":"Pinned"},"require_ack":true}|}
    |> ok
  in
  let events = State.events publication in
  let changes = Json.field events "changes" |> Json.list in
  report (State.replay initial (set events "changes" (`Array (List.take changes 1))));
  let state = State.candidate publication in
  let prepared =
    prepare ~now_unix_ms:101L state "ticket.amendment.acknowledge" ack |> ok
  in
  report
    (State.replay
       state
       (replace_field (State.events prepared) "observed_unix_ms" (fun _ -> `Null)));
  report
    (State.replay
       state
       (replace_field (State.events prepared) "observed_unix_ms" (fun _ -> Json.int 110)));
  report
    (State.replay
       state
       (replace_field (State.events prepared) "observed_unix_ms" (fun _ -> Json.int (-1))));
  let accepted = State.replay state (State.events prepared) |> ok in
  report (prepare ~now_unix_ms:110L accepted "ticket.amendment.acknowledge" ack);
  [%expect
    {|
   Corrupt_store
   Invalid_argument
   Stale_claim
   Invalid_argument
   Stale_claim
   |}]
;;

let%expect_test
    "amendment offset pagination discovers codecs, freezes capture and preserves budget \
     pause"
  =
  let supported = Query_pagination.supported_methods () in
  List.iter
    [ "ticket.amendment.list"
    ; "ticket.amendment.history"
    ; "ticket.amendment.acknowledgements"
    ]
    ~f:(fun method_ ->
      print_s [%sexp (List.mem supported method_ ~equal:String.equal : bool)]);
  let state = publish (task ()) in
  let state =
    step
      ~by:"lead"
      state
      "ticket.amendment.publish"
      {|{"amendment_id":"other","ticket_id":"task","expected_revision":"0","title":"Other","source":{"kind":"text","body":"Retained"}}|}
  in
  let request params =
    Protocol.Request.create
      ~id:"paginate"
      ~method_:"ticket.amendment.list"
      ~params:(Json.obj ([ "workspace_id", `String "amendments" ] @ params))
    |> ok
  in
  let plan params =
    Query_pagination.create (request params) ~limits:Query_pagination.Limits.default |> ok
  in
  let count = ref 0 in
  let fetch state request =
    Int.incr count;
    if !count = 2
    then
      print_s
        [%sexp
          (Json.field (Protocol.Request.params request) "at_revision"
           |> Json.integer
           = State.revision state
           : bool)];
    State.query
      state
      ~method_:(Protocol.Request.method_ request)
      ~params:(Protocol.Request.params request)
    |> Result.map ~f:(fun value ->
      Api_response.project Planning_read value |> Api_response.to_json)
  in
  let complete =
    Query_pagination.collect (plan [ "limit", Json.int 1 ]) ~fetch:(fetch state) |> ok
  in
  print_s [%sexp (Query_pagination.Collection.complete complete : bool)];
  let command =
    Domain_command.Amendment
      (Ticket_amendment.Command.Publish
         { id = Amendment_id.of_string "a-large" |> ok
         ; ticket = Id.Ticket.of_string "task" |> ok
         ; expected_revision = 0
         ; title = "Large"
         ; source = Text (String.make 65536 'x')
         ; require_ack = false
         ; supersedes = []
         })
  in
  let state =
    State.prepare state command ~actor:(actor "lead") ~timestamp:"recorded"
    |> ok
    |> State.candidate
  in
  count := 0;
  let stopped =
    Query_pagination.collect (plan [ "max_bytes", Json.int 4096 ]) ~fetch:(fetch state)
    |> ok
  in
  print_s
    [%sexp
      (Query_pagination.Collection.stop stopped : Query_pagination.Stop.t), (!count : int)];
  let pagination =
    Query_pagination.Collection.to_json stopped
    |> fun value -> Json.field (Json.field value "data") "pagination"
  in
  let retry =
    Json.field pagination "retry_request" |> fun value -> Json.field value "params"
  in
  print_s
    [%sexp (Json.field retry "at_revision" |> Json.integer = State.revision state : bool)];
  [%expect
    {|
 true
 true
 true
 true
 true
 (Needs_larger_budget 1)
 true
 |}]
;;

let%expect_test "replay gates a forged Done transition on pre-transition ownership" =
  let before = publish (task ()) in
  let accepted = step before "ticket.amendment.acknowledge" ack in
  let completion = prepare accepted "ticket.finish" finish |> ok in
  (* Ack did not alter ticket/discussion revisions; retarget the captured closing
    event's transaction/sequence to the earlier unacknowledged capture. *)
  let events =
    State.events completion
    |> fun events ->
    set events "revision" (Json.int (State.revision before + 1))
    |> fun events ->
    replace_field events "sequence" (fun _ -> Json.int (State.revision before + 1))
  in
  report (State.replay before events);
  [%expect {|Blocked|}]
;;

let%expect_test "every revised head requires exact atomic invalidation during replay" =
  let state = publish (task ()) in
  let revision =
    prepare
      ~by:"lead"
      state
      "ticket.amendment.publish"
      {|{"amendment_id":"instruction","ticket_id":"task","expected_revision":"1","title":"Revised","source":{"kind":"text","body":"Version two"},"require_ack":true}|}
    |> ok
  in
  let events = State.events revision in
  let changes = Json.field events "changes" |> Json.list in
  let missing =
    List.filter changes ~f:(function
      | `Array [ `String "Evidence_changed"; _ ] -> false
      | _ -> true)
  in
  report (State.replay state (set events "changes" (`Array missing)));
  let forged =
    replace_field events "current" (fun value ->
      replace_field value "revision" (fun _ -> Json.int 999))
  in
  report (State.replay state forged);
  report (State.replay state events);
  [%expect
    {|
   Corrupt_store
   Corrupt_store
   ok
   |}]
;;

let%expect_test
    "Completed attempts and later batch publications share the exact acknowledgement gate"
  =
  let run = Id.Run.of_string "run" |> ok in
  let state =
    step (empty ()) "run.register" {|{"target_run_id":"run","objective":"Work"}|}
  in
  let state = step state "ticket.create" {|{"ticket_id":"task","title":"Task"}|} in
  let state =
    step ~run state "ticket.start" {|{"ticket_id":"task","attempt_id":"attempt"}|}
  in
  let state = publish state in
  let finish_attempt =
    {|{"attempt_id":"attempt","expected_revision":"1","state":"completed","evidence":"Checked"}|}
  in
  report (prepare ~run state "attempt.finish" finish_attempt);
  let state = step ~run state "ticket.amendment.acknowledge" ack in
  report (prepare ~run state "attempt.finish" finish_attempt);
  report
    (prepare
       ~run
       state
       "transaction.apply"
       {|{"operations":[
 {"method":"attempt.finish","params":{"attempt_id":"attempt","expected_revision":"1","state":"completed","evidence":"Checked"}},
 {"method":"ticket.amendment.publish","params":{"amendment_id":"instruction","ticket_id":"task","expected_revision":"1","title":"Changed after finish","source":{"kind":"text","body":"New required work"},"require_ack":true}}
 ]}|});
  [%expect
    {|
   Blocked
   ok
   Blocked
   |}]
;;

let%expect_test
    "durable duplicate ack marker preserves original acceptance and rejects forged or \
     expired no-op"
  =
  let before = publish (task ~timed:true ~now_unix_ms:100L ()) in
  let accepted = step ~now_unix_ms:101L before "ticket.amendment.acknowledge" ack in
  let duplicate =
    prepare ~now_unix_ms:102L accepted "ticket.amendment.acknowledge" ack |> ok
  in
  let events = State.events duplicate in
  let tag =
    Json.field events "changes"
    |> Json.list
    |> List.hd_exn
    |> function
    | `Array (`String tag :: _) -> tag
    | _ -> assert false
  in
  print_endline tag;
  let replayed = State.replay accepted events |> ok in
  let reference =
    { Ticket_amendment.Reference.id = Amendment_id.of_string "instruction" |> ok
    ; revision = 1
    }
  in
  let acknowledgements =
    Ticket_amendment.acknowledgements (State.amendments replayed) reference
  in
  print_s
    [%sexp
      (List.length acknowledgements : int)
    , ((List.hd_exn acknowledgements).observed_unix_ms : int64 option)];
  report
    (State.replay before (set events "revision" (Json.int (State.revision before + 1))));
  report
    (State.replay
       accepted
       (replace_field events "observed_unix_ms" (fun _ -> Json.int 110)));
  report
    (State.replay
       accepted
       (replace_field events "amendment" (fun value -> set value "revision" (Json.int 2))));
  [%expect
    {|
 Amendment_unchanged
 (1 (101))
 Corrupt_store
 Stale_claim
 Conflict
 |}]
;;

let%expect_test
    "same transaction acknowledgements use event-bound ownership and cannot be omitted"
  =
  let published = publish (task ()) in
  report
    (prepare
       published
       "transaction.apply"
       {|{"operations":[
 {"method":"ticket.amendment.acknowledge","params":{"amendment_id":"instruction","expected_revision":"1","ticket_id":"task","token":"1"}},
 {"method":"ticket.finish","params":{"ticket_id":"task","token":"1","evidence":"Checked"}}
 ]}|});
  let before = task () in
  let prepared =
    prepare
      before
      "transaction.apply"
      {|{"operations":[
 {"method":"ticket.amendment.publish","params":{"amendment_id":"instruction","ticket_id":"task","expected_revision":"0","title":"New","source":{"kind":"text","body":"New instruction"},"require_ack":true}},
 {"method":"ticket.amendment.acknowledge","params":{"amendment_id":"instruction","expected_revision":"1","ticket_id":"task","token":"1"}},
 {"method":"ticket.finish","params":{"ticket_id":"task","token":"1","evidence":"Checked"}}
 ]}|}
    |> ok
  in
  report (State.replay before (State.events prepared));
  let events = State.events prepared in
  let changes =
    Json.field events "changes"
    |> Json.list
    |> List.filter ~f:(function
      | `Array [ `String "Amendment_changed"; payload ] ->
        (match (Ticket_amendment.Change.of_json payload |> ok).update with
         | Acknowledged _ -> false
         | Revisions _ -> true)
      | _ -> true)
  in
  report (State.replay before (set events "changes" (`Array changes)));
  [%expect
    {|
 ok
 ok
 Blocked
 |}]
;;

let%expect_test
    "required instructions can follow an explicit reopen earlier in the transaction"
  =
  let state =
    publish (task ())
    |> fun state ->
    step state "ticket.amendment.acknowledge" ack
    |> fun state -> step state "ticket.finish" finish
  in
  let context = query state "ticket.context" {|{"ticket_id":"task"}|} in
  let revision = Json.field (Json.field context "ticket") "revision" |> Json.text in
  let params =
    sprintf
      {|{"operations":[
 {"method":"ticket.reopen","params":{"ticket_id":"task","expected_revision":"%s","reason":"Changed instructions"}},
 {"method":"ticket.amendment.publish","params":{"amendment_id":"new-instruction","ticket_id":"task","expected_revision":"0","title":"New required work","source":{"kind":"text","body":"After reopen"},"require_ack":true}}
 ]}|}
      revision
  in
  let prepared = prepare ~by:"lead" state "transaction.apply" params |> ok in
  report (State.replay state (State.events prepared));
  print_s
    [%sexp
      (Ticket_amendment.head
         (State.amendments (State.candidate prepared))
         (Amendment_id.of_string "new-instruction" |> ok)
       |> Option.is_some
       : bool)];
  [%expect
    {|
 ok
 true
 |}]
;;

let%expect_test "claim renewal retains exact accepted instruction beyond the old deadline"
  =
  let state = publish (task ~timed:true ~now_unix_ms:100L ()) in
  let state = step ~now_unix_ms:101L state "ticket.amendment.acknowledge" ack in
  let renewal =
    State.prepare
      state
      (Domain_command.Ticket_renew_lease
         { id = Id.Ticket.of_string "task" |> ok; token = 1; expected_lease_revision = 1 })
      ~actor:(actor "worker")
      ~timestamp:"recorded"
      ~now_unix_ms:105L
    |> ok
  in
  let state = State.replay state (State.events renewal) |> ok in
  report (prepare ~now_unix_ms:111L state "ticket.finish" finish);
  let reference =
    { Ticket_amendment.Reference.id = Amendment_id.of_string "instruction" |> ok
    ; revision = 1
    }
  in
  print_s
    [%sexp
      ((Ticket_amendment.acknowledgements (State.amendments state) reference
        |> List.hd_exn)
         .observed_unix_ms
       : int64 option)];
  [%expect
    {|
 ok
 (101)
 |}]
;;
