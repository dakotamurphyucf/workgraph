open Core
open Workgraph

let ok = function
  | Ok x -> x
  | Error p -> failwith p.Problem.message
;;

let json value = Json.parse value |> ok
let actor = Id.Actor.of_string "worker" |> ok
let run = Id.Run.of_string "run" |> ok

let step ?run state method_ params =
  let command = Domain_command.decode ~method_ ~params:(json params) |> ok in
  let prepared =
    State.prepare
      state
      command
      ~actor
      ?run
      ~now_unix_ms:100L
      ~timestamp:"2026-11-05T00:00:00Z"
    |> ok
  in
  let candidate = State.candidate prepared in
  let replayed = State.replay state (State.events prepared) |> ok in
  assert (
    String.equal
      (Json.canonical (State.to_json candidate))
      (Json.canonical (State.to_json replayed)));
  candidate
;;

let fixture () =
  State.empty ~workspace:(Id.Workspace.of_string "liveness" |> ok) ~name:"Liveness"
  |> ok
  |> fun state -> step state "run.register" {|{"target_run_id":"run","objective":"Work"}|}
;;

let read ?(heartbeats = []) ?(now = 200L) ?(extra = []) state =
  Coordinator.read
    ~workspace:(State.workspace state)
    ~revision:(State.revision state)
    ~head:(Some "head")
    ~tickets:(State.coordination_tickets state)
    ~runs:(State.agent_runs state)
    ~evidence:(State.evidence state)
    ~communication:(State.communication state)
    ~policies:(State.policies state)
    ~heartbeats
    ~now_unix_ms:now
    ~params:
      (Json.obj
         ([ "stale_after_ms", Json.int64 100L
          ; "kinds", `Array [ Json.string "stale_run"; Json.string "unobserved_run" ]
          ]
          @ extra))
;;

let metadata result =
  Json.field result "items"
  |> Json.list
  |> List.hd_exn
  |> fun row -> Json.field row "metadata"
;;

let observation result =
  let rows = Json.field result "items" |> Json.list in
  match rows with
  | [] -> print_endline "fresh/no warning"
  | [ row ] ->
    let m = Json.field row "metadata" in
    print_endline
      (Json.canonical
         (Json.obj
            [ "kind", Json.field row "kind"
            ; "last", Json.field m "last_observed_unix_ms"
            ; "age", Json.field m "observation_age_ms"
            ; "clock_regressed", Json.field m "clock_regressed"
            ]))
  | _ -> failwith "unexpected rows"
;;

let outcome = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_endline (Problem.wire_name p.Problem.kind)
;;

let%expect_test "unknown, exact stale boundary, latest observation and backwards clock" =
  let state = fixture () in
  read state |> ok |> observation;
  let state =
    step
      state
      "run.observe"
      {|{"target_run_id":"run","expected_revision":"1","observed_unix_ms":"100"}|}
  in
  List.iter [ 199L; 200L; 50L ] ~f:(fun now -> read ~now state |> ok |> observation);
  read ~now:250L ~heartbeats:[ run, 120L ] state |> ok |> observation;
  read ~now:250L ~heartbeats:[ run, 90L ] state |> ok |> observation;
  read ~now:250L ~heartbeats:[ run, 200L ] state |> ok |> observation;
  let terminal =
    step
      state
      "run.transition"
      {|{"target_run_id":"run","expected_revision":"2","status":"completed","evidence":"Finished"}|}
  in
  read ~now:1000L terminal |> ok |> observation;
  [%expect
    {|
    {"age":null,"clock_regressed":false,"kind":"unobserved_run","last":null}
    fresh/no warning
    {"age":"100","clock_regressed":false,"kind":"stale_run","last":"100"}
    {"age":null,"clock_regressed":true,"kind":"stale_run","last":"100"}
    {"age":"130","clock_regressed":false,"kind":"stale_run","last":"120"}
    {"age":"150","clock_regressed":false,"kind":"stale_run","last":"100"}
    fresh/no warning
    fresh/no warning |}]
;;

let replace json key value =
  match json with
  | `Object fields ->
    Json.obj
      ((key, value) :: List.filter fields ~f:(fun (k, _) -> not (String.equal k key)))
  | _ -> failwith "object expected"
;;

let response result =
  match result with
  | `Object fields ->
    Json.obj (List.filter fields ~f:(fun (key, _) -> not (String.equal key "revision")))
  | _ -> failwith "object expected"
;;

let%expect_test "public decoder and encoder bind exact age to captured clock" =
  let state =
    step
      (fixture ())
      "run.observe"
      {|{"target_run_id":"run","expected_revision":"1","observed_unix_ms":"100"}|}
  in
  let result = read state |> ok |> response in
  Api_codec.decode Coordinator_wire.Response.codec result |> outcome;
  let row = Json.field result "items" |> Json.list |> List.hd_exn in
  let m = Json.field row "metadata" in
  List.iter
    [ "observation_age_ms", Json.int64 99L
    ; "observation_age_ms", `Null
    ; "clock_regressed", `True
    ; "last_observed_unix_ms", Json.int64 101L
    ; "liveness_is_advisory", `False
    ; ( "held_work"
      , Json.obj
          [ "ticket_claim_count", Json.string "-1"
          ; "named_reservation_count", Json.int 0
          ; "path_reservation_count", Json.int 0
          ; "active_attempt_count", Json.int 0
          ] )
    ]
    ~f:(fun (key, value) ->
      let altered =
        replace result "items" (`Array [ replace row "metadata" (replace m key value) ])
      in
      Api_codec.decode Coordinator_wire.Response.codec altered |> outcome);
  let typed = Api_codec.decode Coordinator_wire.Response.codec result |> ok in
  Api_codec.encode
    Coordinator_wire.Response.codec
    { typed with captured_now_unix_ms = 201L }
  |> outcome;
  let regressed = read ~now:50L state |> ok |> response in
  Api_codec.decode Coordinator_wire.Response.codec regressed |> outcome;
  Api_codec.decode
    Coordinator_wire.Response.codec
    (replace regressed "captured_now_unix_ms" (Json.int64 200L))
  |> outcome;
  let unobserved = read (fixture ()) |> ok |> response in
  let row = Json.field unobserved "items" |> Json.list |> List.hd_exn in
  let wrong = replace (Json.field row "metadata") "observation_age_ms" (Json.int64 0L) in
  Api_codec.decode
    Coordinator_wire.Response.codec
    (replace unobserved "items" (`Array [ replace row "metadata" wrong ]))
  |> outcome;
  [%expect
    {|
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    ok
    Invalid_argument
    Invalid_argument |}]
;;

let%expect_test "held claims remain counted after expiry and cannot be archived" =
  let state = fixture () in
  let state =
    List.fold [ "a"; "b" ] ~init:state ~f:(fun state id ->
      step state "ticket.create" (sprintf {|{"ticket_id":"%s","title":"%s"}|} id id))
  in
  let state =
    step
      ~run
      state
      "ticket.start"
      {|{"ticket_id":"a","attempt_id":"attempt","lease_duration_ms":"1"}|}
  in
  let state = step ~run state "ticket.claim" {|{"ticket_id":"b"}|} in
  let archive =
    Domain_command.decode
      ~method_:"ticket.archive"
      ~params:(json {|{"ticket_id":"b","expected_revision":"2","archived":true}|})
    |> ok
  in
  State.prepare state archive ~actor ~now_unix_ms:1000L ~timestamp:"2026-11-05T00:00:00Z"
  |> outcome;
  let before = Json.canonical (State.to_json state) in
  let result = read ~now:1000L state |> ok in
  print_endline (Json.canonical (Json.field (metadata result) "held_work"));
  print_s
    [%sexp
      (List.map (State.coordination_tickets state) ~f:(fun ticket ->
         Id.Ticket.to_string ticket.id)
       : string list)];
  print_s [%sexp (String.equal before (Json.canonical (State.to_json state)) : bool)];
  [%expect
    {|
    Conflict
    {"active_attempt_count":"1","named_reservation_count":"0","path_reservation_count":"0","ticket_claim_count":"2"}
    (a b)
    true |}]
;;

let%expect_test "age and held counts use the frozen first-page clock" =
  let state = fixture () in
  let state =
    step state "run.register" {|{"target_run_id":"second","objective":"Work"}|}
  in
  let state =
    step
      state
      "run.observe"
      {|{"target_run_id":"run","expected_revision":"1","observed_unix_ms":"100"}|}
  in
  let state =
    step
      state
      "run.observe"
      {|{"target_run_id":"second","expected_revision":"1","observed_unix_ms":"100"}|}
  in
  let first = read ~extra:[ "limit", Json.int 1 ] state |> ok in
  let extra = [ "limit", Json.int 1; "cursor", Json.field first "next_cursor" ] in
  let second = read ~now:900L ~extra state |> ok in
  print_endline (Json.canonical (Json.field (metadata first) "observation_age_ms"));
  print_endline (Json.canonical (Json.field (metadata second) "observation_age_ms"));
  print_endline (Json.text (Json.field second "captured_now_unix_ms"));
  read ~now:900L ~extra ~heartbeats:[ run, 110L ] state |> outcome;
  [%expect
    {|
    "100"
    "100"
    200
    Conflict |}]
;;
