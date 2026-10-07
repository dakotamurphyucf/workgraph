open Core
open Workgraph

let () =
  Eio_main.run (fun env ->
    Eio.Switch.run (fun sw ->
      let root =
        match Array.to_list (Sys.get_argv ()) with
        | [ _; root ] -> root
        | _ -> failwith "fresh absolute root required"
      in
      let fs = Eio.Stdenv.fs env in
      let workspace = Id.Workspace.of_string "owner" |> Disk.unwrap in
      Store.create ~fs ~root ~workspace ~name:"Owner" ~creation_token:(String.make 64 'a')
      |> Disk.unwrap;
      let store, state = Store.open_existing ~sw ~fs ~root |> Disk.unwrap in
      let prepare state =
        let command =
          Domain_command.decode
            ~method_:"ticket.create"
            ~params:
              (Json.obj
                 [ "ticket_id", Json.string "ticket"; "title", Json.string "Test" ])
          |> Disk.unwrap
        in
        State.prepare
          state
          command
          ~actor:(Id.Actor.of_string "agent" |> Disk.unwrap)
          ~timestamp:"fixture"
        |> Disk.unwrap
      in
      let reject expected result =
        match result with
        | Error error when Problem.equal_kind expected error.Problem.kind -> ()
        | Error error -> failwith error.message
        | Ok _ -> failwith "invalid store input committed"
      in
      let other =
        State.empty
          ~workspace:(Id.Workspace.of_string "other" |> Disk.unwrap)
          ~name:"Other"
        |> Disk.unwrap
      in
      reject
        Conflict
        (Store.commit
           store
           ~prepared:(prepare other)
           ~key:"agent:wrong"
           ~request_hash:(String.make 64 '0'));
      reject
        Corrupt_store
        (Store.commit
           store
           ~prepared:(prepare state)
           ~key:"other:wrong"
           ~request_hash:(String.make 64 '0'));
      if not (List.is_empty (Eio.Path.read_dir Eio.Path.(fs / root / "transactions")))
      then failwith "failed validation wrote transactions";
      ignore
        (Store.commit
           store
           ~prepared:(prepare state)
           ~key:"agent:valid"
           ~request_hash:(String.make 64 '0')
         |> Disk.unwrap
         : Jsonaf.t);
      Store.close store;
      let store, state = Store.open_existing ~sw ~fs ~root |> Disk.unwrap in
      if State.revision state <> 1 then failwith "valid commit did not recover";
      let command =
        Domain_command.decode
          ~method_:"comment.add"
          ~params:
            (Json.obj
               [ "ticket_id", Json.string "ticket"; "body", Json.string "Duplicate key" ])
        |> Disk.unwrap
      in
      let prepared =
        State.prepare
          state
          command
          ~actor:(Id.Actor.of_string "agent" |> Disk.unwrap)
          ~timestamp:"fixture"
        |> Disk.unwrap
      in
      reject
        Idempotency_conflict
        (Store.commit
           store
           ~prepared
           ~key:"agent:valid"
           ~request_hash:(String.make 64 '0'));
      Store.close store;
      Eio.Flow.copy_string
        "store ownership and receipt validation passed\n"
        (Eio.Stdenv.stdout env)))
;;
