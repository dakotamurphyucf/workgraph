open Core
open Workgraph

let ok = Disk.unwrap
let workspace = Id.Workspace.of_string "branch" |> ok
let actor = Id.Actor.of_string "agent" |> ok
let session = Session_id.of_string "chat" |> ok

let feed capture ?cursor () =
  Change_feed.read
    ~workspace
    ~revision:(Session_store.Capture.sequence capture)
    ~activity:(Session_store.Capture.activity capture)
    ~params:
      (Json.obj
         ([ "workspace_id", Id.Workspace.jsonaf_of_t workspace
          ; "source", Json.string "history"
          ]
          @ Option.to_list (Option.map cursor ~f:(fun value -> "cursor", value))))
;;

let append store text =
  let input =
    Session_event.Input.create
      ~client_id:"message"
      ~role:"assistant"
      ~kind:"message"
      ~phase:"completed"
      ~payload:(Inline text)
      ~attachments:[]
      ()
    |> ok
  in
  Store.with_history store ~f:(fun journal ->
    Session_store.append
      journal
      ~session
      ~actor
      ~inputs:[ input ]
      ~key:"agent:append"
      ~request_hash:(Json.hash text)
      ())
  |> ok
  |> ignore
;;

let summary capture =
  Session_store.Capture.activity capture
  |> List.map ~f:(function
    | `Object fields ->
      Json.obj
        (List.filter fields ~f:(fun (key, _) -> not (String.equal key "batch_digest")))
    | _ -> assert false)
  |> fun events -> Json.canonical (`Array events)
;;

let%expect_test
    "restored payload-only branch rejects cursor and recovery preserves lineage"
  =
  Eio_main.run (fun env ->
    Eio.Switch.run (fun sw ->
      let fs = Eio.Stdenv.fs env in
      let nonce = Cstruct.create 16 in
      Eio.Flow.read_exact (Eio.Stdenv.secure_random env) nonce;
      let base = "/tmp/workgraph-lineage-" ^ Json.hash (Cstruct.to_string nonce) in
      Eio.Path.mkdir ~perm:0o700 Eio.Path.(fs / base);
      Exn.protect
        ~finally:(fun () -> Eio.Path.rmtree Eio.Path.(fs / base))
        ~f:(fun () ->
          let root = base ^ "/original" in
          Store.create
            ~fs
            ~root
            ~workspace
            ~name:"Branch"
            ~creation_token:(String.make 64 'a')
          |> ok;
          let store, state = Store.open_existing ~sw ~fs ~root |> ok in
          Exn.protect
            ~finally:(fun () -> Store.close store)
            ~f:(fun () ->
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
              let destination = base ^ "/export" in
              Store.export store ~state ~destination |> ok |> ignore;
              append store "original body";
              let original = Store.history_capture store |> ok in
              let cursor =
                feed original () |> ok |> fun json -> Json.field json "cursor"
              in
              let verified = Snapshot.verify ~fs ~directory:destination |> ok in
              let restored_root = base ^ "/restored" in
              Snapshot.copy_portable verified ~fs ~destination:restored_root |> ok;
              let restored, _ = Store.open_existing ~sw ~fs ~root:restored_root |> ok in
              Exn.protect
                ~finally:(fun () -> Store.close restored)
                ~f:(fun () ->
                  append restored "replacement body";
                  let replacement = Store.history_capture restored |> ok in
                  printf
                    "audit summaries match: %b\n"
                    (String.equal (summary original) (summary replacement));
                  match feed replacement ~cursor () with
                  | Ok _ -> print_endline "unexpected acceptance"
                  | Error error -> print_s [%sexp (error.kind : Problem.kind)]);
              Store.close store;
              let recovered, _ = Store.open_existing ~sw ~fs ~root |> ok in
              Exn.protect
                ~finally:(fun () -> Store.close recovered)
                ~f:(fun () ->
                  let capture = Store.history_capture recovered |> ok in
                  let response = feed capture ~cursor () |> ok in
                  printf
                    "recovered cursor items: %d\n"
                    (Json.field response "items" |> Json.list |> List.length))))));
  [%expect
    {|
    audit summaries match: true
    Conflict
    recovered cursor items: 0
    |}]
;;
