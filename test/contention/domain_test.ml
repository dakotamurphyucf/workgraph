open Core
open Workgraph
module D = Reservation_contention

let ok = function
  | Ok x -> x
  | Error p -> failwith p.Problem.message
;;

let json x = Json.parse x |> ok
let actor = Id.Actor.of_string "worker" |> ok
let run = Id.Run.of_string "run" |> ok
let named = {|{"kind":"named","reservation_id":"db"}|}

let command
      ?(target = named)
      ?(run = "run")
      ?(method_ = "reservation.waiter.put")
      revision
      action
  =
  Api_codec.decode
    (Option.value_exn (D.Command.codec ~method_))
    (json
       (sprintf
          {|{"target":%s,"target_run_id":"%s","expected_revision":"%d",%s}|}
          target
          run
          revision
          action))
  |> ok
;;

let begin_ = {|"action":"begin","duration_ms":"100","note":"waiting"|}

let outcome = function
  | Ok _ -> print_endline "ok"
  | Error p -> print_endline (Problem.wire_name p.Problem.kind)
;;

let step ?target ?run ?method_ state revision action now =
  let change =
    D.prepare
      state
      (command ?target ?run ?method_ revision action)
      ~actor
      ~now_unix_ms:now
    |> ok
  in
  let encoded = D.Change.jsonaf_of_t change in
  let replayed = D.Change.t_of_jsonaf encoded in
  assert (D.Change.equal change replayed);
  D.apply state change |> ok
;;

let show state =
  List.iter (D.waiters state) ~f:(fun r ->
    printf
      "%d %Ld %Ld %Ld %s\n"
      r.revision
      r.started_unix_ms
      r.updated_unix_ms
      r.expires_unix_ms
      (match r.state with
       | Waiting -> "waiting"
       | Closed r -> r))
;;

let%expect_test
    "explicit begin refresh close and reopen preserve fences and server clocks"
  =
  let state = step D.empty 0 begin_ 100L in
  show state;
  let state =
    step state 1 {|"action":"refresh","duration_ms":"100","note":"still waiting"|} 150L
  in
  show state;
  let state = step state 2 {|"action":"close","reason":"timeout"|} 300L in
  show state;
  D.prepare
    state
    (command 3 {|"action":"refresh","duration_ms":"100","note":"x"|})
    ~actor
    ~now_unix_ms:300L
  |> outcome;
  let state = step state 3 begin_ 400L in
  show state;
  List.iter
    [ 0, 450L; 4, 399L; 4, Int64.max_value; 4, -1L ]
    ~f:(fun (revision, now) ->
      D.prepare state (command revision begin_) ~actor ~now_unix_ms:now |> outcome);
  D.prepare
    state
    (command 4 {|"action":"refresh","duration_ms":"100","note":"x"|})
    ~actor
    ~now_unix_ms:500L
  |> outcome;
  [%expect
    {|
    1 100 100 200 waiting
    2 100 150 250 waiting
    3 100 300 250 timeout
    Conflict
    4 400 400 500 waiting
    Conflict
    Conflict
    Conflict
    Invalid_argument
    Conflict |}]
;;

let%expect_test "retained capacity includes inactive waiter and holder-note keys" =
  let set =
    {|"token":"1","action":"set","duration_ms":"100","note":"holder estimate","expected_release_unix_ms":null|}
  in
  let state = step ~method_:"reservation.holder_note.put" D.empty 0 set 100L in
  let state =
    List.fold (List.range 0 999) ~init:state ~f:(fun s n ->
      step ~run:(sprintf "r%d" n) s 0 begin_ 100L)
  in
  D.prepare state (command ~run:"new" 0 begin_) ~actor ~now_unix_ms:100L |> outcome;
  let state = step ~run:"r0" state 1 {|"action":"close","reason":"cancelled"|} 100L in
  let state =
    step
      ~method_:"reservation.holder_note.put"
      state
      1
      {|"token":"1","action":"clear"|}
      100L
  in
  D.prepare state (command ~run:"new" 0 begin_) ~actor ~now_unix_ms:200L |> outcome;
  let state = step ~run:"r0" state 2 begin_ 200L in
  printf "%d %d\n" (List.length (D.waiters state)) (List.length (D.holder_notes state));
  [%expect
    {|
    Blocked
    Blocked
    999 1 |}]
;;

let%expect_test "public bounds and strict durable shape clocks and action tags" =
  List.iter [ "1"; "300000"; "0"; "300001" ] ~f:(fun duration ->
    Api_codec.decode
      (Option.value_exn (D.Command.codec ~method_:"reservation.waiter.put"))
      (json
         (sprintf
            {|{"target":%s,"target_run_id":"run","expected_revision":"0","action":"begin","duration_ms":"%s","note":""}|}
            named
            duration))
    |> outcome);
  List.iter [ 1024; 1025 ] ~f:(fun n ->
    let note = Json.string (String.make n 'x') |> Json.canonical in
    Api_codec.decode
      (Option.value_exn (D.Command.codec ~method_:"reservation.waiter.put"))
      (json
         (sprintf
            {|{"target":%s,"target_run_id":"run","expected_revision":"0","action":"begin","duration_ms":"1","note":%s}|}
            named
            note))
    |> outcome);
  let change = D.prepare D.empty (command 0 begin_) ~actor ~now_unix_ms:100L |> ok in
  let record =
    match change with
    | D.Change.Waiter_begin r -> r
    | _ -> assert false
  in
  D.apply D.empty (Waiter_begin { record with expires_unix_ms = 100L }) |> outcome;
  D.apply D.empty (Waiter_refresh record) |> outcome;
  let closed =
    step (step D.empty 0 begin_ 100L) 1 {|"action":"close","reason":"done"|} 200L
  in
  let closed = List.hd_exn (D.waiters closed) in
  Api_codec.decode
    D.Change.codec
    (Json.obj
       [ "kind", Json.string "waiter_refresh"
       ; "record", Coordination_wire.encode_exn D.Waiter.codec closed
       ])
  |> outcome;
  let path =
    {|{"kind":"path","target":{"worktree_id":"tree","kind":"file","path":"a/b"}}|}
  in
  let change =
    D.prepare D.empty (command ~target:path 0 begin_) ~actor ~now_unix_ms:100L |> ok
  in
  let text =
    Json.canonical (D.Change.jsonaf_of_t change)
    |> String.substr_replace_all ~pattern:"a/b" ~with_:"a//b"
  in
  Json.decode (fun () -> D.Change.t_of_jsonaf (json text)) |> outcome;
  [%expect
    {|
    ok
    ok
    Invalid_argument
    Invalid_argument
    ok
    Invalid_argument
    Invalid_argument
    Not_found
    Invalid_argument
    Invalid_argument |}]
;;
