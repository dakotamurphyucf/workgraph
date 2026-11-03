open Core
open Workgraph

let unwrap = Disk.unwrap
let run = Id.Run.of_string "observed-run" |> unwrap
let actor = Id.Actor.of_string "owner" |> unwrap
let session = Session_id.of_string "recorded-session" |> unwrap

let record =
  { Agent_run_event.Record.id = run
  ; revision = 4
  ; parent = None
  ; parent_stop_policy = Continue
  ; objective = "Objective text is not copied into a bounded mutation result"
  ; actor
  ; capabilities = [ "ocaml" ]
  ; sessions = [ session ]
  ; process_ref = None
  ; worktree_ref = None
  ; status = Waiting
  ; last_observed_unix_ms = Some 123L
  ; evidence = "Caller reports state; does not prove process liveness"
  }
;;

let%expect_test "snapshot identifies the affected run and bounded resulting state" =
  let receipt = Run_receipt.of_record record |> unwrap in
  assert (Id.Run.equal (Run_receipt.run receipt) run);
  assert (Id.Actor.equal (Run_receipt.actor receipt) actor);
  assert (Run_receipt.revision receipt = 4);
  assert (Agent_run_event.Status.equal (Run_receipt.status receipt) Waiting);
  assert (List.equal Session_id.equal (Run_receipt.sessions receipt) [ session ]);
  let value = Run_receipt.to_json receipt in
  let decoded = Api_codec.decode Run_receipt.codec value |> unwrap in
  assert (Option.equal Int64.equal (Run_receipt.last_observed_unix_ms decoded) (Some 123L));
  print_endline (Json.canonical (Run_receipt.to_json decoded));
  [%expect
    {| {"actor_id":"owner","last_observed_unix_ms":"123","revision":"4","run_id":"observed-run","session_ids":["recorded-session"],"status":"waiting"} |}]
;;

let%expect_test "public decode rejects impossible or misleading receipt states" =
  let encoded = Run_receipt.of_record record |> unwrap |> Run_receipt.to_json in
  let fields =
    match encoded with
    | `Object fields -> fields
    | _ -> assert false
  in
  List.iter
    [ "run_id", Json.string "bad/run"
    ; "revision", Json.int 0
    ; "actor_id", Json.string "bad/actor"
    ; "status", Json.string "stale"
    ; "last_observed_unix_ms", Json.string "-1"
    ; "session_ids", `Array [ Json.string "s"; Json.string "s" ]
    ; ( "session_ids"
      , `Array
          (List.init 101 ~f:(fun index -> Json.string ("session-" ^ Int.to_string index)))
      )
    ; "liveness", Json.string "alive"
    ]
    ~f:(fun (field, value) ->
      match
        Api_codec.decode
          Run_receipt.codec
          (Json.obj (List.Assoc.add fields ~equal:String.equal field value))
      with
      | Ok _ -> print_endline "incorrectly accepted"
      | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]);
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
  |}]
;;

let%expect_test "direct projection does not hide an invalid source record" =
  List.iter
    [ { record with revision = 0 }
    ; { record with last_observed_unix_ms = Some (-1L) }
    ; { record with sessions = [ session; session ] }
    ; { record with status = Completed; evidence = "" }
    ]
    ~f:(fun record ->
      match Run_receipt.of_record record with
      | Ok _ -> print_endline "incorrectly accepted"
      | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]);
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
  |}]
;;

let%expect_test "public mutation descriptors enforce their real resulting state shapes" =
  List.iter
    [ "run.register", {|{"revision":"1"}|}
    ; "allocation.pool_put", {|{"name":"build","revision":"1","limit":"0"}|}
    ; ( "allocation.ticket_policy_put"
      , {|{"ticket_id":"bad/ticket","revision":"1","required_capabilities":[],"pools":[]}|}
      )
    ; ( "allocation.ticket_policy_put"
      , {|{"ticket_id":"task","revision":"0","required_capabilities":[],"pools":[]}|} )
    ]
    ~f:(fun (method_, value) ->
      let codec = Option.value_exn (Agent_run_api.response_codec ~method_) in
      match Api_codec.decode codec (Json.parse value |> unwrap) with
      | Ok _ -> print_endline "incorrectly accepted"
      | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]);
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
  |}]
;;
