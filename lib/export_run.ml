open Core

module Control = struct
  type phase =
    | Writing
    | Canceled
    | Publishing

  type t = phase Atomic.t

  let create () = Atomic.make Writing

  let cancel t =
    Atomic.compare_and_set t Writing Canceled
    ||
    match Atomic.get t with
    | Canceled -> true
    | Writing | Publishing -> false
  ;;

  let canceled t =
    match Atomic.get t with
    | Canceled -> true
    | Writing | Publishing -> false
  ;;

  let check t = if canceled t then Json.fail Conflict "export canceled before publication"

  let publish t =
    if not (Atomic.compare_and_set t Writing Publishing)
    then Json.fail Conflict "export canceled before publication"
  ;;
end

let capture snapshot =
  { Export_job.Capture.workspace = Snapshot.workspace snapshot
  ; revision = Snapshot.revision snapshot
  ; history_head = Snapshot.history_head snapshot
  ; head = Snapshot.head snapshot
  }
;;

let same_capture a b =
  Id.Workspace.equal a.Export_job.Capture.workspace b.Export_job.Capture.workspace
  && Int.equal a.revision b.revision
  && Option.equal String.equal a.head b.head
  && Option.equal String.equal a.history_head b.history_head
;;

let validate_snapshots job snapshots =
  if not (List.equal same_capture job.Export_job.captures (List.map snapshots ~f:capture))
  then Json.fail Conflict "snapshot vector differs from durable export job"
;;

let sync_parent path =
  match Eio.Path.split path with
  | Some (parent, _) -> Platform.sync_directory parent
  | None -> assert false
;;

let run job ~fs ~snapshots ~control =
  Disk.protect (fun () ->
    Export_job.validate job;
    validate_snapshots job snapshots;
    let check_cancelled () = Control.check control in
    let before_publish () = Control.publish control in
    match job.kind, snapshots with
    | Single, [ snapshot ] ->
      ignore
        (Snapshot.write
           snapshot
           ~fs
           ~destination:job.destination
           ~stage:(Export_job.stage job)
           ~check_cancelled
           ~before_publish
         |> Disk.unwrap
         : Jsonaf.t)
    | Single, _ -> assert false
    | All, _ ->
      let stage = Eio.Path.(fs / Export_job.stage job)
      and destination = Eio.Path.(fs / job.destination) in
      (match Eio.Path.kind ~follow:false destination with
       | `Not_found -> ()
       | _ -> Json.fail Conflict "export destination exists");
      check_cancelled ();
      Eio.Path.mkdir ~perm:0o700 stage;
      Disk.ensure_directory Eio.Path.(stage / "workspaces");
      let manifests =
        List.map snapshots ~f:(fun snapshot ->
          let id = Id.Workspace.to_string (Snapshot.workspace snapshot) in
          let target = Export_job.stage job ^ "/workspaces/" ^ id in
          let manifest =
            Snapshot.write
              snapshot
              ~fs
              ~destination:target
              ~stage:(target ^ ".staging")
              ~check_cancelled
              ~before_publish:check_cancelled
            |> Disk.unwrap
          in
          id, Json.string (Json.hash (Json.canonical manifest)))
      in
      let manifest =
        Json.obj
          [ "version", Current_format.value Registry_export
          ; "kind", Json.string "workspace_set"
          ; ("complete", if List.is_empty job.omitted then `True else `False)
          ; "captures", `Array (List.map job.captures ~f:Export_job.Capture.to_json)
          ; "omitted", `Array (List.map job.omitted ~f:Id.Workspace.jsonaf_of_t)
          ; "workspaces", Json.obj manifests
          ]
      in
      Disk.write_new Eio.Path.(stage / "manifest.json") (Json.canonical manifest);
      Platform.sync_directory stage;
      before_publish ();
      Platform.rename_exclusive ~src:stage ~dst:destination;
      (match Disk.protect (fun () -> sync_parent destination) with
       | Ok () -> ()
       | Error e ->
         Json.fail Outcome_unknown ("export-all installed but sync failed: " ^ e.message)))
;;

let verify_capture verified expected =
  if
    (not
       (Id.Workspace.equal
          (Snapshot.Verified.workspace verified)
          expected.Export_job.Capture.workspace))
    || Snapshot.Verified.revision verified <> expected.revision
    || (not
          (Option.equal
             String.equal
             (Snapshot.Verified.history_head verified)
             expected.history_head))
    || not (Option.equal String.equal (Snapshot.Verified.head verified) expected.head)
  then Json.fail Corrupt_store "published export differs from captured revision"
;;

let recover job ~fs =
  let verification =
    Disk.protect (fun () ->
      match job.Export_job.kind, job.captures with
      | Single, [ expected ] ->
        let verified = Snapshot.verify ~fs ~directory:job.destination |> Disk.unwrap in
        verify_capture verified expected;
        sync_parent Eio.Path.(fs / job.destination)
      | Single, _ -> Json.fail Corrupt_store "invalid single job capture"
      | All, captures ->
        let root = Eio.Path.(fs / job.destination) in
        (match Eio.Path.kind ~follow:false root with
         | `Directory -> ()
         | _ -> Json.fail Corrupt_store "export-all destination missing");
        let manifest =
          Disk.read Eio.Path.(root / "manifest.json") |> Json.parse |> Disk.unwrap
        in
        Current_format.validate Registry_export manifest |> Disk.unwrap;
        let names = Eio.Path.read_dir root |> String.Set.of_list in
        if not (Set.equal names (String.Set.of_list [ "manifest.json"; "workspaces" ]))
        then Json.fail Corrupt_store "export-all inventory differs";
        Json.fields
          manifest
          ~allowed:[ "version"; "kind"; "complete"; "captures"; "omitted"; "workspaces" ];
        if not (String.equal (Json.text (Json.field manifest "kind")) "workspace_set")
        then Json.fail Unsupported_version "export-all format unsupported";
        if
          (not
             (List.equal
                same_capture
                captures
                (List.map
                   (Json.list (Json.field manifest "captures"))
                   ~f:Export_job.Capture.of_json)))
          || not
               (List.equal
                  Id.Workspace.equal
                  job.omitted
                  (List.map
                     (Json.list (Json.field manifest "omitted"))
                     ~f:Id.Workspace.t_of_jsonaf))
        then Json.fail Corrupt_store "export-all capture vector differs";
        (match Json.field manifest "complete" with
         | `True when List.is_empty job.omitted -> ()
         | `False when not (List.is_empty job.omitted) -> ()
         | _ -> Json.fail Corrupt_store "export-all completeness differs");
        let workspace_dir = Eio.Path.(root / "workspaces") in
        (match Eio.Path.kind ~follow:false workspace_dir with
         | `Directory -> ()
         | _ -> Json.fail Corrupt_store "invalid export-all workspace directory");
        let ids =
          List.map captures ~f:(fun c ->
            Id.Workspace.to_string c.Export_job.Capture.workspace)
          |> String.Set.of_list
        in
        if not (Set.equal ids (String.Set.of_list (Eio.Path.read_dir workspace_dir)))
        then Json.fail Corrupt_store "export-all workspace inventory differs";
        let members =
          match Json.field manifest "workspaces" with
          | `Object fields -> String.Map.of_alist_exn fields
          | _ -> Json.fail Corrupt_store "invalid export-all members"
        in
        if not (Set.equal ids (Map.key_set members))
        then Json.fail Corrupt_store "export-all manifest members differ";
        List.iter captures ~f:(fun expected ->
          let id = Id.Workspace.to_string expected.Export_job.Capture.workspace in
          let directory = job.destination ^ "/workspaces/" ^ id in
          let verified = Snapshot.verify ~fs ~directory |> Disk.unwrap in
          verify_capture verified expected;
          let expected_hash = Json.text (Map.find_exn members id) in
          let actual_hash, _ =
            File_content.inspect
              Eio.Path.(fs / directory / "manifest.json")
              ~max_bytes:(64 * 1024 * 1024)
            |> Disk.unwrap
          in
          if not (String.equal expected_hash actual_hash)
          then Json.fail Corrupt_store "export-all member manifest checksum differs");
        sync_parent root)
  in
  match verification with
  | Ok () when job.cancel_requested ->
    { job with
      status = Interrupted
    ; error = Some "published output conflicts with durable cancellation intent"
    }
  | Ok () -> { job with status = Completed; error = None }
  | Error error ->
    { job with
      status = (if job.cancel_requested then Canceled else Interrupted)
    ; error = Some (Query_budget.prefix error.message ~max_bytes:4096)
    }
;;
