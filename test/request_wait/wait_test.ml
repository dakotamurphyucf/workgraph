open Core
open Workgraph

let unwrap = Disk.unwrap
let workspace = Id.Workspace.of_string "w" |> unwrap
let request_id = Communication_id.Request.of_string "question" |> unwrap

let plan () =
  Request_wait.create
    ~workspace
    ~request:request_id
    ~timeout_ms:1000
    ~poll_interval_ms:250
  |> unwrap
;;

let replace json key value =
  match json with
  | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal key value)
  | _ -> assert false
;;

let fixture () =
  let actor = Id.Actor.of_string "alice" |> unwrap in
  let initial = State.empty ~workspace ~name:"Work" |> unwrap in
  let state =
    State.prepare
      initial
      (Communication
         (Request_ask
            { id = request_id
            ; destination = New_thread { board = None; title = "Question"; ticket = None }
            ; body = "Question body"
            ; recipients = [ Actor actor ]
            ; resolver = actor
            ; kind = Clarification
            ; priority = 0
            ; deadline_unix_ms = None
            ; related = []
            ; supersedes = []
            }))
      ~actor
      ~timestamp:"now"
    |> unwrap
    |> State.candidate
  in
  State.query
    state
    ~method_:"request.get"
    ~params:(Json.obj [ "request_id", Json.string "question" ])
  |> unwrap
  |> Api_response.project (Domain_query Communication)
  |> Api_response.to_json
;;

let terminal response kind =
  let data = Json.field response "data" in
  let status =
    Json.obj
      ([ "kind", Json.string kind; "attribution", Json.field data "created" ]
       @ if String.equal kind "resolved" then [ "answer", `Null ] else [])
  in
  replace response "data" (replace data "status" status)
;;

let show outcome =
  let json = Request_wait.Outcome.to_json outcome in
  print_endline (Json.canonical (Json.field (Json.field json "meta") "wait"))
;;

let%expect_test "bounded polling preserves final state and never exchanges after deadline"
  =
  let response = fixture () in
  let time = ref 0. in
  let calls = ref 0 in
  let exchange ~timeout_seconds request =
    assert (String.equal (Protocol.Request.method_ request) "request.get");
    assert (Float.(timeout_seconds > 0. && timeout_seconds <= 1.));
    incr calls;
    Ok response
  in
  Request_wait.collect
    (plan ())
    ~now:(fun () -> !time)
    ~sleep:(fun seconds -> time := !time +. seconds)
    ~exchange
  |> unwrap
  |> show;
  print_s [%sexp (!calls : int), (!time : float)];
  List.iter [ "resolved"; "cancelled" ] ~f:(fun kind ->
    Request_wait.collect
      (plan ())
      ~now:(fun () -> 0.)
      ~sleep:(fun _ -> failwith "terminal observation slept")
      ~exchange:(fun ~timeout_seconds:_ _ -> Ok (terminal response kind))
    |> unwrap
    |> show);
  (* A delayed in-flight complete resolution is not discarded as a timeout. *)
  time := 0.;
  Request_wait.collect
    (plan ())
    ~now:(fun () -> !time)
    ~sleep:(fun _ -> failwith "resolved slept")
    ~exchange:(fun ~timeout_seconds:_ _ ->
      time := 2.;
      Ok (terminal response "resolved"))
  |> unwrap
  |> show;
  [%expect
    {|
    {"poll_count":"4","resolved":false,"stop":"deadline"}
    (4 1)
    {"poll_count":"1","resolved":true,"stop":"resolved"}
    {"poll_count":"1","resolved":false,"stop":"cancelled"}
    {"poll_count":"1","resolved":true,"stop":"resolved"}
    |}]
;;

let%expect_test "open observations delay before the exact terminal answer read" =
  let response = fixture () in
  let time = ref 0. in
  let calls = ref 0 in
  Request_wait.collect
    (plan ())
    ~now:(fun () -> !time)
    ~sleep:(fun seconds -> time := !time +. seconds)
    ~exchange:(fun ~timeout_seconds:_ _ ->
      incr calls;
      Ok (if !calls < 3 then response else terminal response "resolved"))
  |> unwrap
  |> show;
  print_s [%sexp (!time : float)];
  [%expect
    {|
    {"poll_count":"3","resolved":true,"stop":"resolved"}
    0.5
    |}]
;;

let%expect_test
    "reject malformed and mismatched responses, retain read errors, propagate exceptions"
  =
  let response = fixture () in
  let data = Json.field response "data" in
  let invalid =
    [ replace response "data" (replace data "request_id" (Json.string "other"))
    ; replace response "data" (replace data "answer" (Json.obj []))
    ; replace response "meta" (Json.obj [])
    ; replace response "extra" `True
    ]
  in
  let collect exchange =
    Request_wait.collect
      (plan ())
      ~now:(fun () -> 0.)
      ~sleep:(fun _ -> failwith "unexpected sleep")
      ~exchange
  in
  List.iter invalid ~f:(fun response ->
    match collect (fun ~timeout_seconds:_ _ -> Ok response) with
    | Ok _ -> failwith "invalid response accepted"
    | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]);
  let problem = Problem.create Not_found "original read failure" in
  (match collect (fun ~timeout_seconds:_ _ -> Error problem) with
   | Ok _ -> failwith "error accepted"
   | Error observed ->
     assert (phys_equal observed problem);
     print_endline observed.message);
  (try
     ignore
       (collect (fun ~timeout_seconds:_ _ -> failwith "unexpected callback")
        : (Request_wait.Outcome.t, Problem.t) Result.t)
   with
   | Failure message -> print_endline message);
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    original read failure
    unexpected callback
    |}]
;;

let%expect_test "clipped resolved answer and invalid clocks never claim completion" =
  let response = fixture () |> fun response -> terminal response "resolved" in
  let meta = Json.field response "meta" in
  let budget = Json.field meta "budget" in
  let budget = replace budget "truncated" `True in
  let budget = replace budget "omitted_fields" (Json.int 1) in
  let budget = replace budget "details_complete" `False in
  let clipped = replace response "meta" (replace meta "budget" budget) in
  Request_wait.collect
    (plan ())
    ~now:(fun () -> 0.)
    ~sleep:(fun _ -> failwith "clipped result slept")
    ~exchange:(fun ~timeout_seconds:_ _ -> Ok clipped)
  |> unwrap
  |> show;
  List.iter
    [ [ Float.nan ]; [ 1.; 0. ] ]
    ~f:(fun times ->
      let times = ref times in
      let now () =
        match !times with
        | [] -> failwith "unexpected clock call"
        | head :: tail ->
          times := tail;
          head
      in
      match
        Request_wait.collect
          (plan ())
          ~now
          ~sleep:(fun _ -> failwith "bad clock slept")
          ~exchange:(fun ~timeout_seconds:_ _ -> failwith "bad clock exchanged")
      with
      | Ok _ -> failwith "invalid clock accepted"
      | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]);
  [%expect
    {|
    {"poll_count":"1","resolved":false,"stop":"incomplete"}
    Invalid_argument
    Invalid_argument
    |}]
;;
