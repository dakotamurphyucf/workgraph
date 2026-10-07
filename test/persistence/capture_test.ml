open Core
open Workgraph

let ok = Disk.unwrap
let actor = Id.Actor.of_string "agent" |> ok
let workspace = Id.Workspace.of_string "portable" |> ok
let session = Session_id.of_string "chat" |> ok

let%expect_test "export pins independent journal head and restores shared blobs" =
  Eio_main.run (fun env ->
    Eio.Switch.run (fun sw ->
      let fs = Eio.Stdenv.fs env in
      let nonce = Cstruct.create 16 in
      Eio.Flow.read_exact (Eio.Stdenv.secure_random env) nonce;
      let base = "/tmp/workgraph-capture-" ^ Json.hash (Cstruct.to_string nonce) in
      Eio.Path.mkdir ~perm:0o700 Eio.Path.(fs / base);
      Exn.protect
        ~finally:(fun () -> Eio.Path.rmtree Eio.Path.(fs / base))
        ~f:(fun () ->
          let root = base ^ "/source" in
          Store.create
            ~fs
            ~root
            ~workspace
            ~name:"Portable"
            ~creation_token:(String.make 64 'a')
          |> ok;
          let store, state = Store.open_existing ~sw ~fs ~root |> ok in
          Exn.protect
            ~finally:(fun () -> Store.close store)
            ~f:(fun () ->
              let resource =
                Domain_command.Resource_put
                  { id = Id.Resource.of_string "note" |> ok
                  ; expected_revision = 0
                  ; title = "Shared content"
                  ; text = "one exact preserved message"
                  ; filename = Some "note.txt"
                  ; mime_type = Some "text/plain"
                  }
              in
              let prepared =
                State.prepare state resource ~actor ~timestamp:"fixture" |> ok
              in
              Store.commit
                store
                ~prepared
                ~key:"agent:resource"
                ~request_hash:(Json.hash "resource")
              |> ok
              |> ignore;
              let state = State.candidate prepared in
              let metadata =
                Session.create
                  ~workspace
                  ~id:session
                  ~title:"Conversation"
                  ~actor
                  ~scopes:[ Entity_ref.Workspace ]
                  ()
                |> ok
              in
              Store.with_history store ~f:(fun journal ->
                Session_store.create
                  journal
                  metadata
                  ~key:"agent:create"
                  ~request_hash:(Json.hash "create"))
              |> ok
              |> ignore;
              let input id bytes =
                Session_event.Input.create
                  ~client_id:id
                  ~role:"assistant"
                  ~kind:"message"
                  ~phase:"completed"
                  ~payload:(Inline bytes)
                  ~searchable_text:(Inline bytes)
                  ~attachments:[]
                  ()
                |> ok
              in
              let append id bytes =
                Store.with_history store ~f:(fun journal ->
                  Session_store.append
                    journal
                    ~session
                    ~actor
                    ~inputs:[ input id bytes ]
                    ~key:("agent:" ^ id)
                    ~request_hash:(Json.hash id)
                    ())
                |> ok
                |> ignore
              in
              append "first" "one exact preserved message";
              let snapshot = Store.capture store ~state |> ok in
              append "second" "later message";
              let retried =
                Store.capture_at_history
                  store
                  ~revision:(Snapshot.revision snapshot)
                  ~history_head:(Snapshot.history_head snapshot)
                |> ok
              in
              print_s
                [%sexp
                  (Option.equal
                     String.equal
                     (Snapshot.history_head snapshot)
                     (Snapshot.history_head retried)
                   : bool)];
              let destination = base ^ "/export" in
              Snapshot.write
                retried
                ~fs
                ~destination
                ~stage:(base ^ "/stage")
                ~check_cancelled:ignore
                ~before_publish:ignore
              |> ok
              |> ignore;
              let verified = Snapshot.verify ~fs ~directory:destination |> ok in
              let restored_root = base ^ "/restored" in
              Snapshot.copy_portable verified ~fs ~destination:restored_root |> ok;
              let restored, restored_state =
                Store.open_existing ~sw ~fs ~root:restored_root |> ok
              in
              Exn.protect
                ~finally:(fun () -> Store.close restored)
                ~f:(fun () ->
                  let restored_snapshot =
                    Store.capture restored ~state:restored_state |> ok
                  in
                  Snapshot.validate_canonical verified ~snapshot:restored_snapshot |> ok;
                  let capture = Store.history_capture restored |> ok in
                  print_s
                    [%sexp
                      (( State.revision restored_state
                       , Session_store.Capture.upper_bound capture ~session )
                       : int * int)];
                  let event =
                    Session_store.Capture.event
                      capture
                      (Session.Event_ref.create ~session ~sequence:1 |> ok)
                    |> ok
                  in
                  let bytes, total =
                    Session_store.read_capture_blob
                      capture
                      ~fs
                      ~root:restored_root
                      (Session_event.payload event)
                      ~offset:0
                      ~length:100
                    |> ok
                  in
                  print_s [%sexp ((bytes, total) : string * int)])))));
  [%expect
    {|
    true
    (1 1)
    ("one exact preserved message" 27)
    |}]
;;

let%expect_test "heartbeat coalesces disk writes and never consumes a planning revision" =
  Eio_main.run (fun env ->
    Eio.Switch.run (fun sw ->
      let fs = Eio.Stdenv.fs env in
      let nonce = Cstruct.create 16 in
      Eio.Flow.read_exact (Eio.Stdenv.secure_random env) nonce;
      let root = "/tmp/workgraph-heartbeat-" ^ Json.hash (Cstruct.to_string nonce) in
      Store.create
        ~fs
        ~root
        ~workspace
        ~name:"Heartbeat"
        ~creation_token:(String.make 64 'b')
      |> ok;
      Exn.protect
        ~finally:(fun () -> Eio.Path.rmtree Eio.Path.(fs / root))
        ~f:(fun () ->
          let store, state = Store.open_existing ~sw ~fs ~root |> ok in
          let run = Id.Run.of_string "worker" |> ok in
          Exn.protect
            ~finally:(fun () -> Store.close store)
            ~f:(fun () ->
              let first = Store.heartbeat store ~run ~actor ~now_unix_ms:1000L |> ok in
              let second = Store.heartbeat store ~run ~actor ~now_unix_ms:1001L |> ok in
              print_endline (Json.canonical (Json.field first "durable"));
              print_endline (Json.canonical (Json.field second "durable"));
              (match Store.heartbeat store ~run ~actor ~now_unix_ms:999L with
               | Ok _ -> print_endline "unexpected success"
               | Error error -> print_s [%sexp (error.kind : Problem.kind)]);
              Store.flush_heartbeats store |> ok;
              print_endline
                (Json.canonical
                   (Store.heartbeat_get store ~run
                    |> ok
                    |> fun json -> Json.field json "durable"));
              print_s [%sexp (Snapshot.revision (Store.capture store ~state |> ok) : int)]))));
  [%expect
    {|
    true
    false
    Conflict
    true
    0
    |}]
;;
