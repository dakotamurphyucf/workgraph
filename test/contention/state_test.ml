open Core
open Workgraph
module D = Reservation_contention

let ok = function
  | Ok x -> x
  | Error p -> failwith p.Problem.message
;;

let json x = Json.parse x |> ok
let actor = Id.Actor.of_string "owner" |> ok
let run = Id.Run.of_string "owner" |> ok
let other = Id.Run.of_string "waiter" |> ok
let target = {|{"kind":"named","reservation_id":"db"}|}

let prepare ?(actor = actor) ?run ?(now = 100L) state method_ params =
  State.prepare
    state
    (Domain_command.decode ~method_ ~params:(json params) |> ok)
    ~actor
    ?run
    ~now_unix_ms:now
    ~timestamp:"2026-11-05T00:00:00Z"
;;

let step ?actor ?run ?now state method_ params =
  let p = prepare ?actor ?run ?now state method_ params |> ok in
  let candidate = State.candidate p in
  let replay = State.replay state (State.events p) |> ok in
  assert (
    String.equal
      (Json.canonical (State.to_json candidate))
      (Json.canonical (State.to_json replay)));
  candidate
;;

let fixture () =
  State.empty ~workspace:(Id.Workspace.of_string "contention" |> ok) ~name:"Contention"
  |> ok
  |> fun s ->
  step s "run.register" {|{"target_run_id":"owner","objective":"holder"}|}
  |> fun s ->
  step s "run.register" {|{"target_run_id":"waiter","objective":"waiter"}|}
  |> fun s ->
  step
    s
    "reservation.acquire"
    {|{"target_run_id":"owner","requests":[{"reservation_id":"db","mode":"exclusive"}]}|}
;;

let waiter revision action =
  sprintf
    {|{"target":%s,"target_run_id":"waiter","expected_revision":"%d",%s}|}
    target
    revision
    action
;;

let note token revision =
  sprintf
    {|{"target":%s,"target_run_id":"owner","token":"%d","expected_revision":"%d","action":"set","duration_ms":"100","note":"done soon","expected_release_unix_ms":"500"}|}
    target
    token
    revision
;;

let begin_ = {|"action":"begin","duration_ms":"100","note":"needs database"|}

let query ?(now = 150L) ?(extra = []) state =
  State.query
    ~now_unix_ms:now
    state
    ~method_:"reservation.contention"
    ~params:(Json.obj ([ "target", json target ] @ extra))
;;

let data result = Json.field result "data"
let rows result = Json.field (data result) "items" |> Json.list

let outcome = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_endline (Problem.wire_name p.Problem.kind)
;;

let%expect_test "notes preserve actual holders and do not acquire or release work" =
  let state = fixture () in
  let before = Agent_run.reservations (State.agent_runs state) in
  let state = step state "reservation.holder_note.put" (note 1 0) in
  let state = step ~now:100L state "reservation.waiter.put" (waiter 0 begin_) in
  print_s
    [%sexp
      (List.equal
         Reservation.equal
         before
         (Agent_run.reservations (State.agent_runs state))
       : bool)];
  let regressed = query ~now:50L state |> ok |> rows |> List.last_exn in
  print_endline (Json.canonical (Json.field regressed "elapsed_ms"));
  print_endline (Json.canonical (Json.field regressed "clock_regressed"));
  let page = query state |> ok in
  print_s
    [%sexp
      (List.map (rows page) ~f:(fun r -> Json.field r "kind" |> Json.text) : string list)];
  let row = List.last_exn (rows page) in
  print_endline (Json.canonical (Json.field row "elapsed_ms"));
  prepare
    state
    "reservation.acquire"
    {|{"target_run_id":"waiter","requests":[{"reservation_id":"db","mode":"exclusive"}]}|}
  |> outcome;
  prepare
    ~actor:(Id.Actor.of_string "wrong" |> ok)
    state
    "reservation.waiter.put"
    (waiter 1 begin_)
  |> outcome;
  prepare ~run:other state "reservation.holder_note.put" (note 1 1) |> outcome;
  prepare state "reservation.holder_note.put" (note 2 1) |> outcome;
  let expired = query ~now:200L state |> ok in
  printf "%d\n" (List.length (rows expired));
  let holder = List.hd_exn (rows expired) in
  print_endline (Json.canonical (Json.field holder "note"));
  let all = query ~now:200L ~extra:[ "include_inactive", `True ] state |> ok in
  print_endline (Json.text (Json.field (List.last_exn (rows all)) "phase"));
  [%expect
    {|
    true
    null
    true
    (holder waiter)
    "50"
    Already_claimed
    Conflict
    Conflict
    Stale_claim
    1
    null
    expired |}]
;;

let%expect_test "first clock paging, terminal cleanup and strict response observations" =
  let state = step (fixture ()) "reservation.waiter.put" (waiter 0 begin_) in
  let first = query ~extra:[ "limit", Json.int 1 ] state |> ok in
  let cursor = Json.field (data first) "cursor" in
  let second =
    query ~now:199L ~extra:[ "limit", Json.int 1; "cursor", cursor ] state |> ok
  in
  let row = List.hd_exn (rows second) in
  print_endline (Json.canonical (Json.field row "elapsed_ms"));
  let replace obj key value =
    match obj with
    | `Object fields ->
      Json.obj
        ((key, value) :: List.filter fields ~f:(fun (k, _) -> not (String.equal k key)))
    | _ -> assert false
  in
  Api_codec.decode
    Reservation_contention_api.read_response_codec
    (replace (data second) "items" (`Array [ replace row "elapsed_ms" (Json.int 99) ]))
  |> outcome;
  let terminal =
    step
      state
      "run.transition"
      {|{"target_run_id":"waiter","expected_revision":"1","status":"cancelled","evidence":"stop waiting"}|}
  in
  let page = query terminal |> ok in
  printf "%d\n" (List.length (rows page));
  let all = query ~extra:[ "include_inactive", `True ] terminal |> ok in
  print_endline (Json.text (Json.field (List.last_exn (rows all)) "phase"));
  query ~extra:[ "cursor", cursor ] terminal |> outcome;
  let state =
    step
      state
      "reservation.release"
      {|{"target_run_id":"owner","reservation_id":"db","token":"1"}|}
  in
  let state =
    step
      state
      "reservation.acquire"
      {|{"target_run_id":"owner","requests":[{"reservation_id":"db","mode":"exclusive"}]}|}
  in
  prepare state "reservation.holder_note.put" (note 1 0) |> outcome;
  [%expect
    {|
    "50"
    Invalid_argument
    1
    run_terminal
    Conflict
    Stale_claim |}]
;;

let%expect_test "independent run replay repeats holder-fence and attribution guards" =
  let state = fixture () in
  let runs = State.agent_runs state in
  let command =
    D.Command.codec ~method_:"reservation.holder_note.put"
    |> Option.value_exn
    |> fun c -> Api_codec.decode c (json (note 1 0)) |> ok
  in
  let prepared =
    Agent_run.prepare
      runs
      (Contention command)
      ~actor
      ~run:None
      ~timestamp:"now"
      ~sequence:1
      ~now_unix_ms:100L
    |> ok
  in
  let change = List.hd_exn (Agent_run.changes prepared) in
  let after =
    match change.update with
    | Contention_changed (Holder_note_put r) -> r
    | _ -> assert false
  in
  let tamper after =
    { change with update = Contention_changed (Holder_note_put after) }
  in
  Agent_run.apply runs (tamper { after with token = 2 }) |> outcome;
  Agent_run.apply runs (tamper { after with actor = Id.Actor.of_string "forged" |> ok })
  |> outcome;
  Agent_run.apply runs change |> outcome;
  let wire = Agent_run.Change.jsonaf_of_t change |> Agent_run.Change.t_of_jsonaf in
  print_s [%sexp (Agent_run.Change.equal change wire : bool)];
  [%expect
    {|
    Stale_claim
    Conflict
    ok
    true |}]
;;

let%expect_test "oversized whole holder row keeps exact cursor position and selector" =
  let state = fixture () in
  let path = String.make 4096 'x' in
  let target =
    Json.obj
      [ "worktree_id", Json.string "tree"
      ; "kind", Json.string "file"
      ; "path", Json.string path
      ]
  in
  let state =
    step
      state
      "reservation.paths.acquire"
      (Json.canonical
         (Json.obj
            [ "target_run_id", Json.string "owner"
            ; ( "requests"
              , `Array [ Json.obj [ "target", target; "mode", Json.string "exclusive" ] ]
              )
            ]))
  in
  let target = Json.obj [ "kind", Json.string "path"; "target", target ] in
  let state =
    step
      state
      "reservation.holder_note.put"
      (Json.canonical
         (Json.obj
            [ "target", target
            ; "target_run_id", Json.string "owner"
            ; "token", Json.int 1
            ; "expected_revision", Json.int 0
            ; "action", Json.string "set"
            ; "duration_ms", Json.int 100
            ; "note", Json.string (String.make 1024 'n')
            ]))
  in
  let read ?(now = 150L) fields =
    State.query
      ~now_unix_ms:now
      state
      ~method_:"reservation.contention"
      ~params:(Json.obj (("target", target) :: fields))
  in
  let small = read [ "max_bytes", Json.int 4096 ] |> ok in
  printf
    "%d %s\n"
    (List.length (rows small))
    (Json.canonical (Json.field (data small) "needs_larger_budget"));
  let cursor = Json.field (data small) "cursor" in
  let full = read ~now:199L [ "cursor", cursor; "max_bytes", Json.int 65536 ] |> ok in
  printf
    "%d %s %s\n"
    (List.length (rows full))
    (Json.canonical (Json.field (data full) "observed_unix_ms"))
    (Json.canonical (Json.field (data full) "has_more"));
  read [ "cursor", cursor; "include_inactive", `True ] |> outcome;
  read ~now:149L [ "cursor", cursor ] |> outcome;
  [%expect
    {|
    0 true
    1 "150" false
    Conflict
    Conflict |}]
;;
