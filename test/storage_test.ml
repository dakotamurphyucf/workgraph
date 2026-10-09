open Core
open Workgraph

let parse bytes = Json.parse bytes |> Disk.unwrap

let outcome result =
  match result with
  | Ok _ -> print_endline "ok"
  | Error error -> print_s [%sexp (error.Problem.kind : Problem.kind)]
;;

let fixture name =
  (* Dune fixtures are symlinks outside its test cwd capability. *)
  Eio_main.run (fun env -> Eio.Path.load Eio.Path.(Eio.Stdenv.fs env / "fixtures" / name))
;;

let update json key value =
  match json with
  | `Object fields -> Json.obj (List.Assoc.add fields key value ~equal:String.equal)
  | _ -> assert false
;;

let%expect_test "independent current canonical bytes, digest and receipt" =
  let json = parse (fixture "transaction.json") in
  let tx = Storage.Transaction.of_json json |> Disk.unwrap in
  let canonical = Json.canonical (Storage.Transaction.to_json tx) in
  printf
    "canonical fixture: %b\n"
    (String.equal canonical (fixture "transaction.canonical.json"));
  printf
    "sha256 fixture: %b\n"
    (String.equal (Json.hash canonical) (String.strip (fixture "transaction.sha256")));
  printf
    "receipt: %s at %d\n"
    (Storage.Transaction.key tx)
    (Storage.Transaction.sequence tx);
  let state =
    State.empty ~workspace:(Storage.Transaction.workspace tx) ~name:"Fixture"
    |> Disk.unwrap
  in
  let state = State.replay state (Storage.Transaction.events tx) |> Disk.unwrap in
  print_endline
    (Json.canonical
       (State.query
          state
          ~method_:"ticket.resolve"
          ~params:(parse {|{"display_key":"WG-1"}|})
        |> Disk.unwrap
        |> fun json -> Json.field json "data"));
  [%expect
    {|
    canonical fixture: true
    sha256 fixture: true
    receipt: agent:create at 1
    {"display_key":"WG-1","ticket_id":"task"} |}]
;;

let%expect_test "receipt identity and shape validation is independent of hashes" =
  let json = parse (fixture "transaction.json") in
  let reject key value = outcome (Storage.Transaction.of_json (update json key value)) in
  reject "version" (Json.int 4);
  reject "future" `True;
  reject "key" (Json.string "other:create");
  reject "key" (Json.string "agent:../bad");
  reject "sequence" (Json.int 0);
  reject "sequence" (Json.int 100_001);
  reject "previous" (Json.string (String.make 64 'a'));
  reject "request_hash" (Json.string (String.make 64 'A'));
  let response = Json.field json "response" in
  reject "response" (update response "workspace_revision" (Json.int 2));
  reject "response" (update response "durable" `False);
  [%expect
    {|
    Unsupported_version
    Invalid_argument
    Corrupt_store
    Invalid_argument
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Corrupt_store |}]
;;

let%expect_test
    "current event definitions reject future shapes and preserve current bytes"
  =
  let events =
    parse (fixture "transaction.json") |> fun json -> Json.field json "events"
  in
  let validate json = outcome (Storage_event.of_json json) in
  validate events;
  validate (update events "changes" (`Array []));
  validate (update events "changes" (parse {|[["Future_event",{}]]|}));
  let change =
    parse {|["Project_put",{"id":"p","title":"P","description":"","future":true}]|}
  in
  validate (update events "changes" (`Array [ change ]));
  validate (update events "run_id" `Null);
  let frozen = Storage_event.of_json events |> Disk.unwrap |> Storage_event.to_json in
  printf
    "current bytes retained: %b\n"
    (String.equal (Json.canonical events) (Json.canonical frozen));
  [%expect
    {|
    ok
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Invalid_argument
    current bytes retained: true |}]
;;

let%expect_test "descriptor and HEAD accept only supported exact schemas" =
  List.iter
    [ {|{"version":"3","workspace_id":"demo","name":"Demo"}|}
    ; {|{"version":"4","workspace_id":"demo","name":"Demo"}|}
    ; {|{"version":"3","workspace_id":"demo","name":"Demo","extra":true}|}
    ]
    ~f:(fun bytes -> outcome (Storage.Descriptor.of_json (parse bytes)));
  List.iter
    [ {|{"version":"1","sequence":"0","digest":null}|}
    ; {|{"version":"1","sequence":"1","digest":null}|}
    ; {|{"version":"1","sequence":"100001","digest":null}|}
    ; {|{"version":"2","sequence":"0","digest":null}|}
    ]
    ~f:(fun bytes -> outcome (Storage.Head.of_json (parse bytes)));
  [%expect
    {|
    ok
    Unsupported_version
    Invalid_argument
    ok
    Corrupt_store
    Corrupt_store
    Unsupported_version |}]
;;

let%expect_test "replayed counters cannot overflow later claim allocation" =
  let events =
    parse (fixture "transaction.json") |> fun json -> Json.field json "events"
  in
  let ticket =
    match Json.list (Json.field events "changes") with
    | [ `Array [ `String "Ticket_put"; ticket ] ] -> ticket
    | _ -> assert false
  in
  let state =
    State.empty
      ~workspace:(Id.Workspace.of_string "fixture" |> Disk.unwrap)
      ~name:"Fixture"
    |> Disk.unwrap
  in
  List.iter [ "0"; "4611686018427387903"; "9223372036854775807" ] ~f:(fun token ->
    let changed = update ticket "next_token" (Json.string token) in
    outcome
      (State.replay
         state
         (update
            events
            "changes"
            (`Array [ `Array [ Json.string "Ticket_put"; changed ] ]))));
  [%expect
    {|
    Corrupt_store
    Corrupt_store
    Invalid_argument |}]
;;

let%expect_test "canonical decimal int64 boundaries and malformed JSON" =
  List.iter
    [ "0"
    ; "9223372036854775807"
    ; "9223372036854775808"
    ; "-1"
    ; "00"
    ; "0x10"
    ; "+1"
    ; "1_000"
    ]
    ~f:(fun value -> outcome (Json.decode (fun () -> Json.integer64 (Json.string value))));
  List.iter
    [ "{\"bad\":\"\255\"}"; {|{"x":1e309}|}; {|{"x":NaN}|}; {|{"x":true,"x":false}|} ]
    ~f:(fun bytes -> outcome (Json.parse bytes));
  outcome (Json.decode (fun () -> Json.canonical (`Number "Infinity")));
  [%expect
    {|
    ok
    ok
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument |}]
;;

let%expect_test "resource revision cannot precede its published versions" =
  let id = Id.Resource.of_string "resource" |> Disk.unwrap in
  let actor = Id.Actor.of_string "agent" |> Disk.unwrap in
  let version revision : Resource.Version.t =
    { revision
    ; digest = Json.hash (Int.to_string revision)
    ; size_bytes = Some 1
    ; actor
    ; timestamp = "fixture"
    ; filename = "file.txt"
    ; mime_type = "text/plain"
    }
  in
  let metadata : Resource.Metadata.t =
    { title = "Resource"
    ; filename = "file.txt"
    ; mime_type = "text/plain"
    ; description = ""
    ; archived = false
    ; targets = []
    }
  in
  List.iter [ 1; 2; 3 ] ~f:(fun revision ->
    outcome
      (Json.decode (fun () ->
         Resource.validate { id; revision; metadata; versions = [ version 2; version 1 ] })));
  [%expect
    {|
    Corrupt_store
    ok
    ok
    |}]
;;
