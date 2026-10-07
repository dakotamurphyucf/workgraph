open Core
open Workgraph

let workspace = Id.Workspace.of_string "history-test" |> Disk.unwrap
let actor = Id.Actor.of_string "agent" |> Disk.unwrap
let session = Session_id.of_string "conversation" |> Disk.unwrap
let hash text = Json.hash text

let show = function
  | Ok _ -> print_endline "ok"
  | Error problem -> print_s [%sexp (problem.Problem.kind : Problem.kind)]
;;

let with_store f =
  Eio_main.run (fun env ->
    let fs = Eio.Stdenv.fs env in
    let nonce = Cstruct.create 16 in
    Eio.Flow.read_exact (Eio.Stdenv.secure_random env) nonce;
    let root = "/tmp/workgraph-history-" ^ Json.hash (Cstruct.to_string nonce) in
    Eio.Path.mkdir ~perm:0o700 Eio.Path.(fs / root);
    Disk.ensure_directory Eio.Path.(fs / root / "blobs");
    let store = Session_store.open_existing ~fs ~root ~workspace |> Disk.unwrap in
    Exn.protect
      ~f:(fun () -> f env fs root store)
      ~finally:(fun () -> Eio.Path.rmtree Eio.Path.(fs / root)))
;;

let create store =
  let metadata =
    Session.create
      ~workspace
      ~id:session
      ~title:"Conversation"
      ~actor
      ~scopes:[ Entity_ref.Workspace ]
      ()
    |> Disk.unwrap
  in
  Session_store.create store metadata ~key:"agent:create" ~request_hash:(hash "create")
  |> Disk.unwrap
;;

let input ?text id payload =
  Session_event.Input.create
    ~client_id:id
    ~role:"tool"
    ~kind:"tool_result"
    ~phase:"completed"
    ~correlation:"call-1"
    ~payload:(Session_event.Content.Inline payload)
    ?searchable_text:(Option.map text ~f:(fun text -> Session_event.Content.Inline text))
    ~attachments:[]
    ()
  |> Disk.unwrap
;;

let append store ~key inputs =
  Session_store.append
    store
    ~session
    ~actor
    ~inputs
    ~key:("agent:" ^ key)
    ~request_hash:(hash key)
    ()
;;

let current store = Session_store.capture store |> Disk.unwrap
let ref_ sequence = Session.Event_ref.create ~session ~sequence |> Disk.unwrap
let count capture = Session_store.Capture.upper_bound capture ~session

let%expect_test "read bounds include empty capture metadata and final page flags" =
  with_store (fun _env _fs _root store ->
    ignore (create store : Jsonaf.t);
    let event =
      Session_event.Input.create
        ~client_id:"large-metadata"
        ~role:"assistant"
        ~kind:"message"
        ~phase:"completed"
        ~provenance:(Json.string (String.make 3800 'x'))
        ~payload:(Inline "body")
        ~attachments:[]
        ()
      |> Disk.unwrap
    in
    ignore (append store ~key:"large-metadata" [ event ] |> Disk.unwrap : Jsonaf.t);
    let read capture ~anchor ~max_bytes =
      History_query.read capture ~session ~anchor ~direction:After ~limit:1 ~max_bytes
    in
    let capture = current store in
    let page = read capture ~anchor:0 ~max_bytes:65_536 |> Disk.unwrap in
    let exact_bytes = String.length (Json.canonical page) in
    printf "metadata exceeds minimum budget: %b\n" (exact_bytes > 4096);
    show (read capture ~anchor:0 ~max_bytes:(exact_bytes - 1));
    let exact = read capture ~anchor:0 ~max_bytes:exact_bytes |> Disk.unwrap in
    printf "exact boundary fits: %b\n" (String.length (Json.canonical exact) = exact_bytes);
    for ordinal = 1 to 60 do
      let id = Printf.sprintf "other-%03d-%s" ordinal (String.make 70 'x') in
      let metadata =
        Session.create
          ~workspace
          ~id:(Session_id.of_string id |> Disk.unwrap)
          ~title:"Other conversation"
          ~actor
          ~scopes:[]
          ()
        |> Disk.unwrap
      in
      ignore
        (Session_store.create
           store
           metadata
           ~key:("agent:create-" ^ Int.to_string ordinal)
           ~request_hash:(hash id)
         |> Disk.unwrap
         : Jsonaf.t)
    done;
    let capture = current store in
    show (read capture ~anchor:1 ~max_bytes:4096);
    let empty = read capture ~anchor:1 ~max_bytes:65_536 |> Disk.unwrap in
    printf "empty page items: %d\n" (List.length (Json.list (Json.field empty "items"))));
  [%expect
    {|
    metadata exceeds minimum budget: true
    Blocked
    exact boundary fits: true
    Blocked
    empty page items: 0
    |}]
;;

let%expect_test
    "durable append retry, client deduplication, conflict and full opaque payload"
  =
  with_store (fun _env fs root store ->
    ignore (create store : Jsonaf.t);
    let bytes = String.make 90_000 '\255' ^ "preserved" in
    let event = input ~text:"remember violet telescope" "event-1" bytes in
    let first = append store ~key:"append-1" [ event ] |> Disk.unwrap in
    let reopened = Session_store.open_existing ~fs ~root ~workspace |> Disk.unwrap in
    let retry = append reopened ~key:"append-1" [ event ] |> Disk.unwrap in
    printf
      "same durable response: %b\n"
      (String.equal (Json.canonical first) (Json.canonical retry));
    show (append reopened ~key:"append-2" [ event ]);
    printf "committed events: %d\n" (count (current reopened));
    show (append reopened ~key:"changed" [ input "event-1" "different" ]);
    let stored = Session_store.Capture.event (current reopened) (ref_ 1) |> Disk.unwrap in
    let payload = Session_event.payload stored in
    let recovered, total =
      Session_store.read_blob_range reopened payload ~offset:0 ~length:100_000
      |> Disk.unwrap
    in
    printf "payload bytes %d identical: %b\n" total (String.equal bytes recovered);
    show
      (Session_store.lookup_receipt
         reopened
         ~key:"agent:append-1"
         ~request_hash:(hash "other")));
  [%expect
    {|
    same durable response: true
    ok
    committed events: 1
    Idempotency_conflict
    payload bytes 90009 identical: true
    Idempotency_conflict
    |}]
;;

let%expect_test
    "fixed capture reads, searchable history beyond prefix, index lag and rebuild"
  =
  with_store (fun _env fs root store ->
    ignore (create store : Jsonaf.t);
    let text =
      String.make 300_000 'x' ^ " hidden_requirement " ^ String.make 10_000 'z'
    in
    ignore
      (append store ~key:"first" [ input ~text "one" "body"; input "two" "opaque" ]
       |> Disk.unwrap
       : Jsonaf.t);
    let capture = current store in
    ignore
      (append
         store
         ~key:"later"
         [ input ~text:"hidden_requirement correction" "three" "new" ]
       |> Disk.unwrap
       : Jsonaf.t);
    printf "fixed/live bounds: %d/%d\n" (count capture) (count (current store));
    let page =
      History_query.read
        capture
        ~session
        ~anchor:0
        ~direction:After
        ~limit:1
        ~max_bytes:65_536
      |> Disk.unwrap
    in
    printf "read next: %d\n" (Json.integer (Json.field page "next_anchor"));
    let index = History_index.create ~fs ~root in
    let search index =
      History_index.search
        index
        capture
        ~text:"hidden_requirement"
        ~limit:10
        ~max_bytes:65_536
        ()
      |> Disk.unwrap
    in
    let lag = search index in
    printf "lag missing: %d\n" (Json.integer (Json.field lag "unindexed_events"));
    show (History_index.rebuild index capture);
    let result = search index in
    printf
      "hits/unsearchable: %d/%d\n"
      (List.length (Json.list (Json.field result "items")))
      (Json.integer (Json.field result "unsearchable_events"));
    let hit = List.hd_exn (Json.list (Json.field result "items")) in
    printf "offset: %d\n" (Json.integer (Json.field hit "byte_offset"));
    let restored_index = History_index.create ~fs ~root in
    ignore (History_index.rebuild restored_index capture |> Disk.unwrap : unit);
    printf
      "restart same search: %b\n"
      (String.equal (Json.canonical result) (Json.canonical (search restored_index)));
    show (History_query.get capture (ref_ 3)));
  [%expect
    {|
    fixed/live bounds: 2/3
    read next: 1
    lag missing: 2
    ok
    hits/unsearchable: 1/1
    offset: 300001
    restart same search: true
    Not_found
    |}]
;;

let%expect_test
    "fork and archived sessions retain refs, orphan tails ignored, corruption detected"
  =
  with_store (fun _env fs root store ->
    ignore (create store : Jsonaf.t);
    let fork_id = Session_id.of_string "fork" |> Disk.unwrap in
    let make parent =
      Session.create ~workspace ~id:fork_id ~title:"Fork" ~actor ~parent ~scopes:[] ()
      |> Disk.unwrap
    in
    show
      (Session_store.create
         store
         (make (ref_ 1))
         ~key:"agent:early-fork"
         ~request_hash:(hash "early"));
    ignore
      (append store ~key:"first" [ input ~text:"old requirement" "one" "body" ]
       |> Disk.unwrap
       : Jsonaf.t);
    show
      (Session_store.create
         store
         (make (ref_ 1))
         ~key:"agent:fork"
         ~request_hash:(hash "fork"));
    let frozen = current store in
    show
      (Session_store.archive
         store
         ~session
         ~key:"agent:archive"
         ~request_hash:(hash "archive"));
    show (append store ~key:"late" [ input "two" "new" ]);
    show (History_query.get (current store) (ref_ 1));
    Disk.write_new
      Eio.Path.(fs / root / "history/batches/orphan.json")
      "interrupted garbage";
    let recovered = Session_store.open_existing ~fs ~root ~workspace |> Disk.unwrap in
    printf "orphan ignored: %d\n" (count (current recovered));
    let ancestor =
      Session_store.capture_at recovered ~head:(Session_store.Capture.head frozen)
      |> Disk.unwrap
    in
    printf
      "captured ancestor: %b\n"
      (String.equal
         (Session_store.Capture.head_bytes frozen)
         (Session_store.Capture.head_bytes ancestor));
    let stored = Session_store.Capture.event frozen (ref_ 1) |> Disk.unwrap in
    Disk.replace
      Eio.Path.(fs / root / "blobs" / (Session_event.payload stored).digest)
      "tampered";
    show (Session_store.open_existing ~fs ~root ~workspace));
  [%expect
    {|
    Not_found
    ok
    ok
    Conflict
    ok
    orphan ignored: 1
    captured ancestor: true
    Corrupt_store
    |}]
;;

let%expect_test
    "uncertain publication fences owner; restoring authoritative head excludes tail"
  =
  with_store (fun env fs root store ->
    ignore (create store : Jsonaf.t);
    let history = Filename.concat root "history" in
    Eio.Process.run (Eio.Stdenv.process_mgr env) [ "chmod"; "500"; history ];
    Exn.protect
      ~f:(fun () ->
        show (append store ~key:"interrupted" [ input "one" "body" ]);
        show (Session_store.capture store))
      ~finally:(fun () ->
        Eio.Process.run (Eio.Stdenv.process_mgr env) [ "chmod"; "700"; history ]);
    let recovered = Session_store.open_existing ~fs ~root ~workspace |> Disk.unwrap in
    printf "recovered events: %d\n" (count (current recovered));
    show (append recovered ~key:"interrupted" [ input "one" "body" ]);
    printf "retried events: %d\n" (count (current recovered)));
  [%expect
    {|
    Storage_unavailable
    Outcome_unknown
    recovered events: 0
    ok
    retried events: 1
    |}]
;;

let%expect_test "current independent schema rejects malformed heads and unknown versions" =
  let parse text = Json.parse text |> Disk.unwrap in
  let good =
    parse {|{"version":"1","workspace_id":"history-test","sequence":"0","digest":null}|}
  in
  let head = History_storage.Head.of_json good |> Disk.unwrap in
  printf
    "independent empty HEAD: %s\n"
    (Json.canonical (History_storage.Head.to_json head));
  let change key value =
    match good with
    | `Object fields -> Json.obj (List.Assoc.add fields key value ~equal:String.equal)
    | _ -> assert false
  in
  show (History_storage.Head.of_json (change "version" (Json.int 2)));
  show (History_storage.Head.of_json (change "digest" (Json.string (String.make 64 'a'))));
  show (History_storage.Head.of_json (change "future" `True));
  show (Session.Event_ref.of_json (parse {|{"session_id":"s","sequence":"0"}|}));
  show
    (Session_event.Blob_ref.of_json (parse {|{"digest":"../unsafe","size_bytes":"0"}|}));
  [%expect
    {|
    independent empty HEAD: {"digest":null,"sequence":"0","version":"1","workspace_id":"history-test"}
    Unsupported_version
    Corrupt_store
    Invalid_argument
    Invalid_argument
    Invalid_argument
    |}]
;;

let%expect_test "opaque content identity matches inline and installed blobs" =
  Quickcheck.test String.quickcheck_generator ~trials:100 ~f:(fun bytes ->
    let inline = input "source" bytes in
    let ref_ =
      Session_event.Blob_ref.create
        ~digest:(Json.hash bytes)
        ~size_bytes:(String.length bytes)
      |> Disk.unwrap
    in
    let installed =
      Session_event.Input.create
        ~client_id:"source"
        ~role:"tool"
        ~kind:"tool_result"
        ~phase:"completed"
        ~correlation:"call-1"
        ~payload:(Session_event.Content.Blob ref_)
        ~attachments:[]
        ()
      |> Disk.unwrap
    in
    if
      not
        (String.equal
           (Session_event.Input.identity_hash inline)
           (Session_event.Input.identity_hash installed))
    then failwith "inline/blob identity differs");
  print_endline "100 opaque byte identity cases passed";
  [%expect {| 100 opaque byte identity cases passed |}]
;;

let%expect_test "searchable blob must be complete UTF-8, bodies remain opaque" =
  with_store (fun _env fs root store ->
    ignore (create store : Jsonaf.t);
    let bytes = "\255" in
    let digest = Json.hash bytes in
    Disk.write_new Eio.Path.(fs / root / "blobs" / digest) bytes;
    let ref_ = Session_event.Blob_ref.create ~digest ~size_bytes:1 |> Disk.unwrap in
    let bad =
      Session_event.Input.create
        ~client_id:"bad"
        ~role:"tool"
        ~kind:"tool_result"
        ~phase:"completed"
        ~payload:(Session_event.Content.Blob ref_)
        ~searchable_text:(Session_event.Content.Blob ref_)
        ~attachments:[]
        ()
      |> Disk.unwrap
    in
    show (append store ~key:"bad" [ bad ]);
    printf "committed after rejected text: %d\n" (count (current store)));
  [%expect
    {|
    Invalid_argument
    committed after rejected text: 0
    |}]
;;

let%expect_test "external journal HEAD changes fence mutation and immutable capture" =
  with_store (fun _env fs root store ->
    ignore (create store : Jsonaf.t);
    let before = current store in
    Disk.replace
      Eio.Path.(fs / root / "history/HEAD.json")
      (Session_store.Capture.head_bytes before ^ "\n");
    show (Session_store.capture store);
    show (append store ~key:"stale" [ input "one" "body" ]);
    let recovered = Session_store.open_existing ~fs ~root ~workspace |> Disk.unwrap in
    printf "recovered external head events: %d\n" (count (current recovered)));
  [%expect
    {|
    Conflict
    Outcome_unknown
    recovered external head events: 0
    |}]
;;

let%expect_test "durable history activity has sequence bounds and no transcript bodies" =
  with_store (fun _env fs root store ->
    ignore (create store : Jsonaf.t);
    ignore
      (append store ~key:"batch" [ input "one" "PRIVATE_TRANSCRIPT"; input "two" "body" ]
       |> Disk.unwrap
       : Jsonaf.t);
    let activity = Session_store.Capture.activity (current store) in
    printf
      "newest revisions: %s\n"
      (String.concat
         ~sep:","
         (List.map activity ~f:(fun event -> Json.text (Json.field event "revision"))));
    let append = List.hd_exn activity in
    let changes = Json.list (Json.field append "changes") |> List.hd_exn |> Json.list in
    printf "append metadata: %s\n" (Json.canonical (List.nth_exn changes 1));
    printf
      "transcript excluded: %b\n"
      (not
         (String.is_substring
            (Json.canonical (`Array activity))
            ~substring:"PRIVATE_TRANSCRIPT"));
    let recovered = Session_store.open_existing ~fs ~root ~workspace |> Disk.unwrap in
    printf
      "recovery same activity: %b\n"
      (String.equal
         (Json.canonical (`Array activity))
         (Json.canonical (`Array (Session_store.Capture.activity (current recovered))))));
  [%expect
    {|
    newest revisions: 2,1
    append metadata: {"appended_events":"2","first_sequence":"1","last_sequence":"2","session_id":"conversation","through":"2"}
    transcript excluded: true
    recovery same activity: true
    |}]
;;

let%expect_test "search snippets remain UTF-8 when stream reads split a scalar" =
  with_store (fun _env fs root store ->
    ignore (create store : Jsonaf.t);
    let cases =
      [ "\194\162", 1
      ; "\226\130\172", 1
      ; "\226\130\172", 2
      ; "\240\159\152\128", 1
      ; "\240\159\152\128", 2
      ; "\240\159\152\128", 3
      ]
    in
    let inputs =
      List.mapi cases ~f:(fun index (scalar, split_bytes) ->
        let needle = "needle" ^ Int.to_string index in
        let text =
          String.make 262_040 'a'
          ^ needle
          ^ String.make (262_144 - split_bytes - 262_040 - String.length needle) 'b'
          ^ scalar
          ^ String.make 1000 'z'
        in
        input ~text (Int.to_string index) "body")
    in
    ignore (append store ~key:"unicode-boundaries" inputs |> Disk.unwrap : Jsonaf.t);
    let capture = current store in
    let index = History_index.create ~fs ~root in
    History_index.rebuild index capture |> Disk.unwrap;
    List.iteri cases ~f:(fun ordinal _ ->
      let result =
        History_index.search
          index
          capture
          ~text:("needle" ^ Int.to_string ordinal)
          ~limit:10
          ~max_bytes:65_536
          ()
        |> Disk.unwrap
      in
      let hits = Json.list (Json.field result "items") in
      let hit = List.hd_exn hits in
      printf
        "%d: %d hit at %d\n"
        ordinal
        (List.length hits)
        (Json.integer (Json.field hit "byte_offset"))));
  [%expect
    {|
    0: 1 hit at 262040
    1: 1 hit at 262040
    2: 1 hit at 262040
    3: 1 hit at 262040
    4: 1 hit at 262040
    5: 1 hit at 262040
    |}]
;;

let%expect_test "recovery rejects searchable blobs that violate UTF-8 semantics" =
  with_store (fun _env fs root store ->
    ignore (create store : Jsonaf.t);
    let previous = current store |> Session_store.Capture.head in
    let bytes = "\255" in
    let blob =
      Session_event.Blob_ref.create ~digest:(Json.hash bytes) ~size_bytes:1 |> Disk.unwrap
    in
    Disk.write_new Eio.Path.(fs / root / "blobs" / blob.digest) bytes;
    let input =
      Session_event.Input.create
        ~client_id:"invalid-text"
        ~role:"assistant"
        ~kind:"message"
        ~phase:"completed"
        ~payload:(Blob blob)
        ~searchable_text:(Blob blob)
        ~attachments:[]
        ()
      |> Disk.unwrap
    in
    let event =
      Session_event.commit input ~ref_:(ref_ 1) ~actor ~run:None ~install:(fun _ -> blob)
    in
    let batch =
      History_storage.Batch.create
        ~workspace
        ~sequence:2
        ~previous
        ~key:"agent:invalid-text"
        ~request_hash:(hash "invalid-text")
        ~change:
          (Json.obj
             [ "kind", Json.string "append"
             ; "session_id", Session_id.jsonaf_of_t session
             ; "actor", Id.Actor.jsonaf_of_t actor
             ; "run", `Null
             ; "events", `Array [ Session_event.to_json event ]
             ])
        ~response:
          (Json.obj
             [ "durable", `True
             ; "session_id", Session_id.jsonaf_of_t session
             ; "through", Json.int 1
             ; "events", `Array [ Session.Event_ref.to_json (ref_ 1) ]
             ])
      |> Disk.unwrap
      |> History_storage.Batch.to_json
      |> Json.canonical
    in
    let digest = hash batch in
    Disk.write_new Eio.Path.(fs / root / "history/batches" / (digest ^ ".json")) batch;
    let head =
      History_storage.Head.create ~workspace ~sequence:2 ~digest:(Some digest)
      |> Disk.unwrap
      |> History_storage.Head.to_json
      |> Json.canonical
    in
    Disk.replace Eio.Path.(fs / root / "history/HEAD.json") head;
    show (Session_store.open_existing ~fs ~root ~workspace));
  [%expect {| Invalid_argument |}]
;;

let%expect_test "rehashed history batches cannot forge attribution or durable receipts" =
  let update json key value =
    match json with
    | `Object fields -> Json.obj (List.Assoc.add fields key value ~equal:String.equal)
    | _ -> assert false
  in
  with_store (fun _env fs root store ->
    ignore (create store : Jsonaf.t);
    let batch capture =
      let digest = Session_store.Capture.head capture |> Option.value_exn in
      Disk.read Eio.Path.(fs / root / "history/batches" / (digest ^ ".json"))
      |> Json.parse
      |> Disk.unwrap
    in
    let created = current store |> batch in
    ignore
      (append store ~key:"append" [ input "one" "first"; input "two" "second" ]
       |> Disk.unwrap
       : Jsonaf.t);
    let appended = current store |> batch in
    Session_store.archive
      store
      ~session
      ~key:"agent:archive"
      ~request_hash:(hash "archive")
    |> Disk.unwrap
    |> ignore;
    let archived = current store |> batch in
    let change = Json.field appended "change" in
    let response = Json.field appended "response" in
    let event_attribution key value =
      let events =
        Json.list (Json.field change "events")
        |> List.map ~f:(fun event -> update event key value)
      in
      update appended "change" (update change "events" (`Array events))
    in
    let metadata_response original =
      let response = Json.field original "response" in
      let metadata = Json.field response "session" in
      update
        original
        "response"
        (update response "session" (update metadata "title" (Json.string "Forged title")))
    in
    let cases =
      [ "create metadata", metadata_response created
      ; "archive metadata", metadata_response archived
      ; "receipt actor", update appended "key" (Json.string "other:append")
      ; "event actor", event_attribution "actor" (Json.string "other")
      ; "event run", event_attribution "run" (Json.string "other")
      ; "watermark", update appended "response" (update response "through" (Json.int 99))
      ; ( "missing event"
        , update
            appended
            "response"
            (update
               response
               "events"
               (`Array [ List.hd_exn (Json.list (Json.field response "events")) ])) )
      ; ( "unknown receipt field"
        , update appended "response" (update response "future" `True) )
      ; "empty mutation", update appended "key" (Json.string "agent:")
      ]
    in
    List.iter cases ~f:(fun (label, json) ->
      let bytes = Json.canonical json in
      let digest = hash bytes in
      Disk.write_new Eio.Path.(fs / root / "history/batches" / (digest ^ ".json")) bytes;
      let head =
        History_storage.Head.create
          ~workspace
          ~sequence:(Json.integer (Json.field json "sequence"))
          ~digest:(Some digest)
        |> Disk.unwrap
        |> History_storage.Head.to_json
        |> Json.canonical
      in
      Disk.replace Eio.Path.(fs / root / "history/HEAD.json") head;
      printf "%s: " label;
      show (Session_store.open_existing ~fs ~root ~workspace)));
  [%expect
    {|
    create metadata: Corrupt_store
    archive metadata: Corrupt_store
    receipt actor: Corrupt_store
    event actor: Corrupt_store
    event run: Corrupt_store
    watermark: Corrupt_store
    missing event: Corrupt_store
    unknown receipt field: Invalid_argument
    empty mutation: Corrupt_store
    |}]
;;
