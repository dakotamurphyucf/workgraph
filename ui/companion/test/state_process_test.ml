open Core
open Workgraph
open Workgraph_ui

let rec remove path =
  match Eio.Path.kind ~follow:false path with
  | `Not_found -> ()
  | `Directory ->
    List.iter (Eio.Path.read_dir path) ~f:(fun name -> remove Eio.Path.(path / name));
    Eio.Path.rmdir path
  | _ -> Eio.Path.unlink path
;;

let child env mode path =
  Eio.Switch.run (fun sw ->
    match
      State_root.acquire
        ~sw
        ~fs:(Eio.Stdenv.fs env)
        ~random:(Eio.Stdenv.secure_random env)
        ~path
    with
    | Error error ->
      Eio.Flow.copy_string (Problem.wire_name error.kind ^ "\n") (Eio.Stdenv.stdout env)
    | Ok root ->
      if String.equal mode "crash-send"
      then (
        let store =
          Operation_store.create ~root ~random:(Eio.Stdenv.secure_random env)
          |> Disk.unwrap
        in
        let connection =
          Connection_profile.create
            ~id:(Connection_profile.Id.of_string "local" |> Disk.unwrap)
            ~generation:Connection_profile.Generation.initial
            ~label:"Local"
            ~socket:"/tmp/not-contacted.sock"
          |> Disk.unwrap
        in
        let params =
          Json.parse
            {|{"workspace_id":"demo","actor_id":"writer","mutation_id":"saved","ticket_id":"task","title":"Task"}|}
          |> Disk.unwrap
        in
        let input =
          Operation.Preparation.create
            ~intention_id:"crash"
            ~connection
            ~context:
              (Operation.Context.create
                 ~workspace:(Some (Id.Workspace.of_string "demo" |> Disk.unwrap))
                 ~project:None
                 ~writer:
                   (Writer.create
                      ~actor:(Id.Actor.of_string "writer" |> Disk.unwrap)
                      ~run:None))
            ~method_:"ticket.create"
            ~params
          |> Disk.unwrap
        in
        let operation =
          Operation_store.prepare store input ~materialize:(fun () ->
            Protocol.Request.create ~id:"exact" ~method_:"ticket.create" ~params)
          |> Disk.unwrap
          |> Operation_store.operation
        in
        ignore
          (Operation_store.admit store ~id:(Operation.id operation) ~retry:false
           |> Disk.unwrap
           : Operation.t));
      Eio.Flow.copy_string "locked\n" (Eio.Stdenv.stdout env);
      if String.equal mode "hold" || String.equal mode "crash-send"
      then
        ignore
          (Eio.Buf_read.line (Eio.Buf_read.of_flow (Eio.Stdenv.stdin env) ~max_size:32)
           : string))
;;

let main env =
  let fs = Eio.Stdenv.fs env in
  let random = Eio.Stdenv.secure_random env in
  let bytes = Cstruct.create 32 in
  Eio.Flow.read_exact random bytes;
  let parent = "/tmp/workgraph-ui-process-" ^ Json.hash (Cstruct.to_string bytes) in
  Eio.Path.mkdir ~perm:0o700 Eio.Path.(fs / parent);
  Exn.protect
    ~finally:(fun () -> remove Eio.Path.(fs / parent))
    ~f:(fun () ->
      let path = Filename.concat parent "state" in
      let alias = Filename.concat parent "alias" in
      Eio.Switch.run (fun sw ->
        let source, sink = Eio_unix.pipe sw in
        let input, command = Eio_unix.pipe sw in
        let process =
          Eio.Process.spawn
            ~sw
            (Eio.Stdenv.process_mgr env)
            ~stdin:input
            ~stdout:sink
            [ Stdlib.Sys.executable_name; "crash-send"; path ]
        in
        assert (
          String.equal
            (Eio.Buf_read.line (Eio.Buf_read.of_flow source ~max_size:128))
            "locked");
        Eio.Path.symlink ~link_to:path Eio.Path.(fs / alias);
        let probe target =
          Eio.Process.parse_out
            (Eio.Stdenv.process_mgr env)
            Eio.Buf_read.line
            [ Stdlib.Sys.executable_name; "probe"; target ]
        in
        assert (String.equal (probe path) "Conflict");
        assert (String.equal (probe alias) "Conflict");
        assert (String.equal (probe (Filename.concat parent "other")) "locked");
        let original = Eio.Path.stat ~follow:false Eio.Path.(fs / path / ".owner.lock") in
        Eio.Process.signal process Stdlib.Sys.sigkill;
        (match Eio.Process.await process with
         | `Signaled _ -> ()
         | `Exited _ -> failwith "expected abrupt termination");
        Eio.Flow.close command;
        let root = State_root.acquire ~sw ~fs ~random ~path:alias |> Disk.unwrap in
        let after =
          Eio.Path.stat ~follow:false Eio.Path.(State_root.directory root / ".owner.lock")
        in
        assert (Int64.equal original.ino after.ino && Int64.equal original.dev after.dev);
        let store = Operation_store.create ~root ~random |> Disk.unwrap in
        let listing = Operation_store.list store ~offset:0 ~limit:10 |> Disk.unwrap in
        let item = Json.field listing "items" |> Json.list |> List.hd_exn in
        assert (String.equal (Json.field item "state_kind" |> Json.text) "outcome_unknown");
        printf
          "same root + alias contend; distinct root independent; permanent guard \
           survives SIGKILL; send admission reloads unknown\n");
      let blocked = Filename.concat parent "symlink-guard" in
      Eio.Path.mkdir ~perm:0o700 Eio.Path.(fs / blocked);
      Eio.Path.save
        ~create:(`Exclusive 0o600)
        Eio.Path.(fs / parent / "target")
        "unchanged";
      Eio.Path.symlink
        ~link_to:(Filename.concat parent "target")
        Eio.Path.(fs / blocked / ".owner.lock");
      Eio.Switch.run (fun sw ->
        match State_root.acquire ~sw ~fs ~random ~path:blocked with
        | Error error -> assert (Problem.equal_kind error.kind Conflict)
        | Ok _ -> failwith "symlink guard admitted");
      assert (String.equal (Eio.Path.load Eio.Path.(fs / parent / "target")) "unchanged");
      printf "symlink guard rejected without touching its target\n")
;;

let () =
  Eio_main.run (fun env ->
    match Array.to_list (Sys.get_argv ()) with
    | [ _; mode; path ] -> child env mode path
    | [ _ ] -> main env
    | _ -> failwith "unexpected test arguments")
;;
