open Core
open Workgraph

let unwrap = Disk.unwrap
let id text = Session_id.of_string text |> unwrap
let run text = Id.Run.of_string text |> unwrap

let show_time = function
  | None -> "null"
  | Some value -> Int64.to_string value
;;

let%expect_test "session server times survive dedup, exact retries, archive and replay" =
  History_test.with_store (fun _env fs root store ->
    let params =
      Json.obj [ "session_id", Json.string "timed"; "title", Json.string "Timed" ]
    in
    let decode now_unix_ms =
      History_command.decode
        ~workspace:History_test.workspace
        ~actor:History_test.actor
        ~now_unix_ms
        ~method_:"session.create"
        ~params
        ()
    in
    let created = decode 0L |> unwrap in
    let execute command ~now ~key =
      History_command.execute
        store
        command
        ~actor:History_test.actor
        ~now_unix_ms:now
        ~key:("agent:" ^ key)
        ~request_hash:(Json.hash key)
        ()
      |> unwrap
    in
    let receipt = execute created ~now:0L ~key:"create-timed" in
    let session = id "timed" in
    let append now key inputs =
      Session_store.append
        store
        ~session
        ~actor:History_test.actor
        ~now_unix_ms:now
        ~inputs
        ~key:("agent:" ^ key)
        ~request_hash:(Json.hash key)
        ()
      |> unwrap
    in
    let one = History_test.input "one" "body" in
    let first = append 10L "first" [ one ] in
    let capture = History_test.current store in
    let show name store =
      let metadata = Session_store.get store ~session |> unwrap in
      printf
        "%s created=%s last=%s archived=%b\n"
        name
        (Session.created_at_unix_ms metadata |> show_time)
        (Session.last_event_at_unix_ms metadata |> show_time)
        (Session.archived metadata)
    in
    show "first" store;
    ignore (append 20L "dedup" [ one ] : Jsonaf.t);
    show "dedup" store;
    printf
      "append retry stable=%b\n"
      (String.equal (Json.canonical first) (Json.canonical (append 30L "first" [ one ])));
    ignore (append 5L "regressed" [ History_test.input "two" "new" ] : Jsonaf.t);
    show "clock-regressed" store;
    let old = List.hd_exn (Session_store.Capture.sessions capture) in
    printf "captured last=%s\n" (Session.last_event_at_unix_ms old |> show_time);
    ignore
      (Session_store.archive
         store
         ~session
         ~key:"agent:archive"
         ~request_hash:(Json.hash "archive")
       |> unwrap
       : Jsonaf.t);
    show "archive" store;
    let retry = execute (decode 999L |> unwrap) ~now:999L ~key:"create-timed" in
    printf
      "create retry stable=%b\n"
      (String.equal (Json.canonical receipt) (Json.canonical retry));
    let reopened =
      Session_store.open_existing ~fs ~root ~workspace:History_test.workspace |> unwrap
    in
    show "replayed" reopened;
    History_test.show (decode (-1L));
    let legacy =
      Session.create
        ~workspace:History_test.workspace
        ~id:(id "unknown")
        ~title:"Unknown"
        ~actor:History_test.actor
        ~scopes:[]
        ()
      |> unwrap
    in
    let updated = Session.with_last_event_at_unix_ms legacy (Some 0L) |> unwrap in
    let roundtrip = Session.of_json (Session.to_json updated) |> unwrap in
    printf
      "unknown creation known event=%s/%s\n"
      (Session.created_at_unix_ms roundtrip |> show_time)
      (Session.last_event_at_unix_ms roundtrip |> show_time));
  [%expect
    {|
    first created=0 last=10 archived=false
    dedup created=0 last=10 archived=false
    append retry stable=true
    clock-regressed created=0 last=5 archived=false
    captured last=10
    archive created=0 last=5 archived=true
    create retry stable=true
    replayed created=0 last=5 archived=true
    Invalid_argument
    unknown creation known event=null/0
    |}]
;;

let%expect_test
    "captured session lists use stable timestamp order, nulls last and exact run filters"
  =
  History_test.with_store (fun _env fs root store ->
    let create ?created_at_unix_ms ?run name =
      let metadata =
        Session.create
          ~workspace:History_test.workspace
          ~id:(id name)
          ~title:name
          ~actor:History_test.actor
          ?run
          ?created_at_unix_ms
          ~scopes:[]
          ()
        |> unwrap
      in
      Session_store.create
        store
        metadata
        ~key:("agent:" ^ name)
        ~request_hash:(Json.hash name)
      |> unwrap
      |> ignore
    in
    create ~created_at_unix_ms:10L ~run:(run "selected") "b";
    create ~created_at_unix_ms:20L ~run:(run "other") "c";
    create ~created_at_unix_ms:10L ~run:(run "selected") "a";
    create "unknown";
    let append name now =
      Session_store.append
        store
        ~session:(id name)
        ~actor:History_test.actor
        ~now_unix_ms:now
        ~inputs:[ History_test.input "one" "body" ]
        ~key:("agent:append-" ^ name)
        ~request_hash:(Json.hash ("append-" ^ name))
        ()
      |> unwrap
      |> ignore
    in
    append "a" 40L;
    append "b" 30L;
    append "c" 0L;
    let capture = History_test.current store in
    let index = History_index.create ~fs ~root in
    let query fields =
      History_command.query
        capture
        ~fs
        ~root
        ~index
        ~method_:"session.list"
        ~params:(Json.obj fields)
      |> unwrap
    in
    let names result =
      Json.field result "items"
      |> Json.list
      |> List.map ~f:(fun item -> Json.field item "session_id" |> Json.text)
      |> String.concat ~sep:","
    in
    List.iter [ "session_id"; "created_at"; "last_event_at" ] ~f:(fun order ->
      printf "%s=%s\n" order (query [ "order", Json.string order ] |> names));
    printf
      "filtered=%s\n"
      (query [ "order", Json.string "created_at"; "run_id", Json.string "selected" ]
       |> names);
    let first = query [ "order", Json.string "created_at"; "limit", Json.int 2 ] in
    create ~created_at_unix_ms:99L "later";
    let second =
      query
        [ "order", Json.string "created_at"
        ; "limit", Json.int 2
        ; "offset", Json.field first "next_offset"
        ]
    in
    printf "captured pages=%s|%s\n" (names first) (names second);
    printf "default=%s\n" (query [] |> names));
  [%expect
    {|
    session_id=a,b,c,unknown
    created_at=c,a,b,unknown
    last_event_at=a,b,c,unknown
    filtered=a,b
    captured pages=c,a|b,unknown
    default=a,b,c,unknown
    |}]
;;

let%expect_test "timestamp codecs require current fields and reject negative values" =
  let metadata =
    Session.create
      ~workspace:History_test.workspace
      ~id:(id "codec")
      ~title:"Codec"
      ~actor:History_test.actor
      ~scopes:[]
      ()
    |> unwrap
  in
  let set json name value =
    match json with
    | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal name value)
    | _ -> assert false
  in
  let persisted = Session.to_json metadata in
  History_test.show
    (Session.of_json (set persisted "created_at_unix_ms" (Json.string "-1")));
  History_test.show
    (Session.of_json (set persisted "last_event_at_unix_ms" (Json.string "-1")));
  let wire = History_wire.session_json metadata in
  History_test.show
    (Api_codec.decode
       History_wire.session
       (set wire "created_at_unix_ms" (Json.string "-1")));
  History_test.show
    (Api_codec.decode
       History_wire.session
       (set wire "last_event_at_unix_ms" (Json.string "-1")));
  let missing =
    match persisted with
    | `Object fields ->
      Json.obj (List.Assoc.remove fields ~equal:String.equal "created_at_unix_ms")
    | _ -> assert false
  in
  History_test.show (Session.of_json missing);
  History_test.show
    (Session.create
       ~workspace:History_test.workspace
       ~id:(id "negative")
       ~title:"Negative"
       ~actor:History_test.actor
       ~created_at_unix_ms:(-1L)
       ~scopes:[]
       ());
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "invalid new session timestamps reject before durable publication" =
  History_test.with_store (fun _env _fs _root store ->
    let metadata =
      Session.create
        ~workspace:History_test.workspace
        ~id:(id "invalid")
        ~title:"Invalid"
        ~actor:History_test.actor
        ~scopes:[]
        ()
      |> unwrap
    in
    let create value key =
      Session_store.create store value ~key:("agent:" ^ key) ~request_hash:(Json.hash key)
      |> History_test.show
    in
    create (Session.with_last_event_at_unix_ms metadata (Some 1L) |> unwrap) "has-last";
    create (Session.archive metadata) "archived";
    printf
      "published sessions=%d\n"
      (History_test.current store |> Session_store.Capture.sessions |> List.length));
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    published sessions=0
    |}]
;;

let%expect_test "session-list run filter remains explicit under an attributed CLI context"
  =
  let context =
    Cli_context.of_json
      (Json.obj
         [ "socket", Json.string "/tmp/history-session-context.sock"
         ; "workspace_id", Json.string "history-test"
         ; "actor_id", Json.string "agent"
         ; "run_id", Json.string "writer"
         ])
    |> unwrap
  in
  let fields = Cli_context.apply context ~method_:"session.list" ~fields:[] in
  printf "implicit run filter=%b\n" (List.Assoc.mem fields "run_id" ~equal:String.equal);
  let fields =
    Cli_context.apply
      context
      ~method_:"session.list"
      ~fields:[ "run_id", Json.string "selected" ]
  in
  printf
    "explicit run filter=%s\n"
    (List.Assoc.find_exn fields "run_id" ~equal:String.equal |> Json.text);
  [%expect
    {|
    implicit run filter=false
    explicit run filter=selected
    |}]
;;
