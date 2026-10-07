open Core
open Workgraph

let ok = Disk.unwrap
let workspace = Id.Workspace.of_string "review" |> ok
let actor = Id.Actor.of_string "agent" |> ok
let session = Session_id.of_string "chat" |> ok

let report label result =
  printf "%s: %s\n" label (if Result.is_ok result then "accepted" else "rejected")
;;

let without json field =
  match json with
  | `Object fields ->
    Json.obj (List.filter fields ~f:(fun (name, _) -> not (String.equal name field)))
  | _ -> assert false
;;

let%expect_test "current history head fields are required nullable digests" =
  let registration =
    { Registry.Registration.root = "/tmp/review"
    ; is_open = false
    ; known_head = None
    ; known_history_head = None
    }
  in
  let registry =
    { Registry.empty with registrations = String.Map.singleton "review" registration }
  in
  let encoded = Registry.encode registry |> ok in
  report "empty history registry round trip" (Registry.decode encoded);
  let json = Json.parse encoded |> ok in
  let missing =
    match json with
    | `Object fields ->
      Json.obj
        (List.map fields ~f:(fun (key, value) ->
           if String.equal key "workspaces"
           then
             ( key
             , Json.obj
                 [ "review", without (Json.field value "review") "known_history_head" ] )
           else key, value))
    | _ -> assert false
  in
  report "missing registry history head" (Registry.decode (Json.canonical missing));
  let capture =
    { Export_job.Capture.workspace; revision = 0; head = None; history_head = None }
  in
  let capture_json = Export_job.Capture.to_json capture in
  report
    "empty history capture round trip"
    (Json.decode (fun () -> Export_job.Capture.of_json capture_json));
  report
    "missing capture history head"
    (Json.decode (fun () ->
       Export_job.Capture.of_json (without capture_json "history_head")));
  let job =
    { Export_job.id = "review_export"
    ; kind = Single
    ; destination = "/tmp/review-export"
    ; captures = [ { capture with history_head = Some "broken" } ]
    ; omitted = []
    ; status = Running
    ; attempt = 1
    ; cancel_requested = false
    ; error = None
    }
  in
  report "invalid job history digest" (Json.decode (fun () -> Export_job.validate job));
  let plan =
    { Restore_plan.request_hash = String.make 64 'a'
    ; token = String.make 64 'b'
    ; targets =
        [ { Restore_plan.Target.source = "/tmp/review-export"
          ; root = "/tmp/review-restore"
          ; capture = { capture with history_head = Some "broken" }
          ; manifest_hash = String.make 64 'c'
          }
        ]
    }
  in
  report
    "invalid restore history digest"
    (Json.decode (fun () -> Restore_plan.validate plan));
  [%expect
    {|
    empty history registry round trip: accepted
    missing registry history head: rejected
    empty history capture round trip: accepted
    missing capture history head: rejected
    invalid job history digest: rejected
    invalid restore history digest: rejected
    |}]
;;

let%expect_test "fenced history retains safe close baseline and permits recovery" =
  Eio_main.run (fun env ->
    Eio.Switch.run (fun sw ->
      let fs = Eio.Stdenv.fs env in
      let nonce = Cstruct.create 16 in
      Eio.Flow.read_exact (Eio.Stdenv.secure_random env) nonce;
      let root = "/tmp/workgraph-review-" ^ Json.hash (Cstruct.to_string nonce) in
      Store.create
        ~fs
        ~root
        ~workspace
        ~name:"Review"
        ~creation_token:(String.make 64 'a')
      |> ok;
      Exn.protect
        ~finally:(fun () -> Eio.Path.rmtree Eio.Path.(fs / root))
        ~f:(fun () ->
          let store, _ = Store.open_existing ~sw ~fs ~root |> ok in
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
              Store.with_history store ~f:(fun history ->
                Session_store.create
                  history
                  metadata
                  ~key:"agent:create"
                  ~request_hash:(Json.hash "create"))
              |> ok
              |> ignore;
              let capture = Store.history_capture store |> ok in
              let head = Session_store.Capture.head capture in
              Disk.replace
                Eio.Path.(fs / root / "history/HEAD.json")
                (Session_store.Capture.head_bytes capture ^ "\n");
              report "first guarded capture" (Store.history_capture store);
              report "subsequent guarded capture" (Store.history_capture store);
              printf
                "close baseline preserved: %b\n"
                (Option.equal String.equal head (Store.known_history_head store));
              Store.close store;
              let reopened, _ = Store.open_existing ~sw ~fs ~root |> ok in
              Exn.protect
                ~finally:(fun () -> Store.close reopened)
                ~f:(fun () ->
                  printf
                    "recovered history matches: %b\n"
                    (Option.equal
                       String.equal
                       head
                       (Store.history_capture reopened |> ok |> Session_store.Capture.head)))))));
  [%expect
    {|
    first guarded capture: rejected
    subsequent guarded capture: rejected
    close baseline preserved: true
    recovered history matches: true
    |}]
;;

let with_workspace f =
  Eio_main.run (fun env ->
    Eio.Switch.run (fun sw ->
      let fs = Eio.Stdenv.fs env in
      let nonce = Cstruct.create 16 in
      Eio.Flow.read_exact (Eio.Stdenv.secure_random env) nonce;
      let directory =
        "/tmp/workgraph-directory-review-" ^ Json.hash (Cstruct.to_string nonce)
      in
      Eio.Path.mkdir ~perm:0o700 Eio.Path.(fs / directory);
      Exn.protect
        ~finally:(fun () -> Eio.Path.rmtree Eio.Path.(fs / directory))
        ~f:(fun () ->
          let root = directory ^ "/workspace" in
          Store.create
            ~fs
            ~root
            ~workspace
            ~name:"Review"
            ~creation_token:(String.make 64 'a')
          |> ok;
          f ~sw ~fs ~directory ~root)))
;;

let show_kind label result =
  match result with
  | Ok _ -> printf "%s: accepted\n" label
  | Error error ->
    printf "%s: %s\n" label (Sexp.to_string (Problem.sexp_of_kind error.Problem.kind))
;;

let%expect_test
    "opening canonical directories rejects symlinks and restores empty Git directories"
  =
  List.iter [ "transactions"; "blobs" ] ~f:(fun relative ->
    with_workspace (fun ~sw ~fs ~directory ~root ->
      let source = Eio.Path.(fs / root / relative) in
      let external_root = directory ^ "/external" in
      Eio.Path.rename source Eio.Path.(fs / external_root);
      Eio.Path.symlink ~link_to:external_root source;
      show_kind relative (Store.open_existing ~sw ~fs ~root);
      Eio.Path.unlink source;
      Eio.Path.rename Eio.Path.(fs / external_root) source;
      let store, _ = Store.open_existing ~sw ~fs ~root |> ok in
      Exn.protect
        ~finally:(fun () -> Store.close store)
        ~f:(fun () ->
          show_kind "successful open retains lock" (Store.open_existing ~sw ~fs ~root))));
  with_workspace (fun ~sw ~fs ~directory:_ ~root ->
    List.iter [ "transactions"; "blobs" ] ~f:(fun relative ->
      Eio.Path.rmdir Eio.Path.(fs / root / relative));
    let store, state = Store.open_existing ~sw ~fs ~root |> ok in
    Exn.protect
      ~finally:(fun () -> Store.close store)
      ~f:(fun () ->
        printf "empty revision recovered: %d\n" (State.revision state);
        List.iter [ "transactions"; "blobs" ] ~f:(fun relative ->
          Disk.require_directory Eio.Path.(fs / root / relative))));
  [%expect
    {|
    transactions: Corrupt_store
    successful open retains lock: Conflict
    blobs: Corrupt_store
    successful open retains lock: Conflict
    empty revision recovered: 0
    |}]
;;

let%expect_test "live canonical directory substitution fences before publication" =
  with_workspace (fun ~sw ~fs ~directory ~root ->
    let store, state = Store.open_existing ~sw ~fs ~root |> ok in
    Exn.protect
      ~finally:(fun () -> Store.close store)
      ~f:(fun () ->
        let prepared =
          let command =
            Domain_command.decode
              ~method_:"ticket.create"
              ~params:
                (Json.obj [ "ticket_id", Json.string "one"; "title", Json.string "One" ])
            |> ok
          in
          State.prepare state command ~actor ~timestamp:"review" |> ok
        in
        let transactions = Eio.Path.(fs / root / "transactions") in
        let external_root = directory ^ "/external" in
        Eio.Path.rename transactions Eio.Path.(fs / external_root);
        Eio.Path.symlink ~link_to:external_root transactions;
        let commit () =
          Store.commit store ~prepared ~key:"agent:one" ~request_hash:(Json.hash "one")
        in
        show_kind "substituted directory" (commit ());
        printf
          "external files written: %d\n"
          (List.length (Eio.Path.read_dir Eio.Path.(fs / external_root)));
        Eio.Path.unlink transactions;
        Eio.Path.rename Eio.Path.(fs / external_root) transactions;
        show_kind "restored directory without recovery" (commit ());
        Store.close store;
        let reopened, recovered = Store.open_existing ~sw ~fs ~root |> ok in
        Store.close reopened;
        printf "recovered revision: %d\n" (State.revision recovered)));
  [%expect
    {|
    substituted directory: Corrupt_store
    external files written: 0
    restored directory without recovery: Outcome_unknown
    recovered revision: 0
    |}]
;;

let%expect_test "history batch directory symlinks fail live capture and reopen" =
  with_workspace (fun ~sw ~fs ~directory ~root ->
    let store, _ = Store.open_existing ~sw ~fs ~root |> ok in
    Exn.protect
      ~finally:(fun () -> Store.close store)
      ~f:(fun () ->
        let metadata =
          Session.create ~workspace ~id:session ~title:"History" ~actor ~scopes:[] ()
          |> ok
        in
        Store.with_history store ~f:(fun history ->
          Session_store.create
            history
            metadata
            ~key:"agent:create"
            ~request_hash:(Json.hash "create"))
        |> ok
        |> ignore;
        let batches = Eio.Path.(fs / root / "history/batches") in
        let external_root = directory ^ "/external" in
        Eio.Path.rename batches Eio.Path.(fs / external_root);
        Eio.Path.symlink ~link_to:external_root batches;
        show_kind "live history capture" (Store.history_capture store);
        show_kind "subsequent history capture" (Store.history_capture store);
        Store.close store;
        show_kind "history reopen" (Store.open_existing ~sw ~fs ~root)));
  [%expect
    {|
    live history capture: Corrupt_store
    subsequent history capture: Outcome_unknown
    history reopen: Corrupt_store
    |}]
;;
