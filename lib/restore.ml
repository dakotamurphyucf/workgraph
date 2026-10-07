open Core

let manifest_hash verified =
  Json.hash (Json.canonical (Snapshot.Verified.manifest verified))
;;

let target verified ~source ~root =
  Disk.absolute root;
  { Restore_plan.Target.source
  ; root
  ; capture =
      { Export_job.Capture.workspace = Snapshot.Verified.workspace verified
      ; revision = Snapshot.Verified.revision verified
      ; history_head = Snapshot.Verified.history_head verified
      ; head = Snapshot.Verified.head verified
      }
  ; manifest_hash = manifest_hash verified
  }
;;

let inspect ~fs ~source ~root =
  Disk.protect (fun () ->
    let verified = Snapshot.verify ~fs ~directory:source |> Disk.unwrap in
    target verified ~source ~root)
;;

let inspect_all ~fs ~source ~roots =
  Disk.protect (fun () ->
    Disk.absolute source;
    let directory = Eio.Path.(fs / source) in
    let check_directory path expected =
      (match Eio.Path.kind ~follow:false path with
       | `Directory -> ()
       | _ -> Json.fail Corrupt_store "expected real export-all directory");
      if not (Set.equal (String.Set.of_list (Eio.Path.read_dir path)) expected)
      then Json.fail Corrupt_store "export-all directory inventory differs"
    in
    check_directory directory (String.Set.of_list [ "manifest.json"; "workspaces" ]);
    let manifest =
      Disk.read Eio.Path.(directory / "manifest.json") |> Json.parse |> Disk.unwrap
    in
    Json.fields
      manifest
      ~allowed:[ "version"; "kind"; "complete"; "captures"; "omitted"; "workspaces" ];
    if
      Json.integer (Json.field manifest "version") <> 1
      || not (String.equal (Json.text (Json.field manifest "kind")) "workspace_set")
    then Json.fail Unsupported_version "unsupported export-all format";
    (match Json.field manifest "complete", Json.list (Json.field manifest "omitted") with
     | `True, [] -> ()
     | _ -> Json.fail Invalid_argument "restore-all requires a complete export");
    let captures =
      List.map (Json.list (Json.field manifest "captures")) ~f:Export_job.Capture.of_json
    in
    let members =
      match Json.field manifest "workspaces" with
      | `Object entries -> String.Map.of_alist_exn entries
      | _ -> Json.fail Corrupt_store "invalid export-all members"
    in
    let ids =
      List.map captures ~f:(fun c ->
        Id.Workspace.to_string c.Export_job.Capture.workspace)
      |> String.Set.of_list
    in
    if Set.length ids <> List.length captures || not (Set.equal ids (Map.key_set members))
    then Json.fail Corrupt_store "export-all captures and members differ";
    if not (Set.equal ids (Map.key_set roots))
    then
      Json.fail
        Invalid_argument
        "restore-all requires exactly one root per exported workspace";
    check_directory Eio.Path.(directory / "workspaces") ids;
    List.map captures ~f:(fun capture ->
      let id = Id.Workspace.to_string capture.workspace in
      let source = source ^ "/workspaces/" ^ id in
      let verified = Snapshot.verify ~fs ~directory:source |> Disk.unwrap in
      let actual_hash, _ =
        File_content.inspect
          Eio.Path.(fs / source / "manifest.json")
          ~max_bytes:(64 * 1024 * 1024)
        |> Disk.unwrap
      in
      if
        (not (String.equal actual_hash (Json.text (Map.find_exn members id))))
        || Snapshot.Verified.revision verified <> capture.revision
        || (not
              (Id.Workspace.equal
                 (Snapshot.Verified.workspace verified)
                 capture.workspace))
        || (not
              (Option.equal
                 String.equal
                 (Snapshot.Verified.history_head verified)
                 capture.history_head))
        || not (Option.equal String.equal (Snapshot.Verified.head verified) capture.head)
      then Json.fail Corrupt_store "export-all member differs from captured manifest";
      target verified ~source ~root:(Map.find_exn roots id)))
;;

let install plan ~sw ~fs ~attempt =
  Disk.protect (fun () ->
    Restore_plan.validate plan;
    if
      String.length attempt <> 64
      || not
           (String.for_all attempt ~f:(fun c ->
              Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
    then Json.fail Invalid_argument "invalid restore staging token";
    let marker = Json.canonical (Restore_plan.to_json plan) in
    let sync_parent path =
      match Eio.Path.split path with
      | Some (parent, _) -> Platform.sync_directory parent
      | None -> assert false
    in
    List.iter plan.targets ~f:(fun target ->
      let root = Eio.Path.(fs / target.root) in
      let replay root ~verified =
        let store, state = Store.open_existing ~sw ~fs ~root |> Disk.unwrap in
        Exn.protect
          ~finally:(fun () -> Store.close store)
          ~f:(fun () ->
            let expected = target.capture in
            if
              (not (Id.Workspace.equal (State.workspace state) expected.workspace))
              || State.revision state <> expected.revision
              || (not
                    (Option.equal
                       String.equal
                       (Store.history_capture store
                        |> Disk.unwrap
                        |> Session_store.Capture.head)
                       expected.history_head))
              || not (Option.equal String.equal (Store.head store) expected.head)
            then Json.fail Corrupt_store "restored state differs from captured revision";
            Option.iter verified ~f:(fun verified ->
              let snapshot = Store.capture store ~state |> Disk.unwrap in
              Snapshot.validate_canonical verified ~snapshot |> Disk.unwrap))
      in
      match Eio.Path.kind ~follow:false root with
      | `Directory ->
        (match Eio.Path.kind ~follow:false Eio.Path.(root / ".local/restore.json") with
         | `Regular_file -> ()
         | _ -> Json.fail Conflict "existing restore root has no ownership marker");
        if not (String.equal (Disk.read Eio.Path.(root / ".local/restore.json")) marker)
        then Json.fail Conflict "existing restore root belongs to another operation";
        replay target.root ~verified:None;
        sync_parent root
      | `Not_found ->
        let verified = Snapshot.verify ~fs ~directory:target.source |> Disk.unwrap in
        if not (String.equal (manifest_hash verified) target.manifest_hash)
        then Json.fail Conflict "restore source changed after admission";
        let stage = target.root ^ ".restoring-" ^ plan.token ^ "-" ^ attempt in
        Snapshot.copy_portable verified ~fs ~destination:stage |> Disk.unwrap;
        replay stage ~verified:(Some verified);
        let stage_path = Eio.Path.(fs / stage) in
        Disk.write_new Eio.Path.(stage_path / ".local/restore.json") marker;
        Platform.sync_directory stage_path;
        Platform.rename_exclusive ~src:stage_path ~dst:root;
        (match Disk.protect (fun () -> sync_parent root) with
         | Ok () -> ()
         | Error error ->
           Json.fail
             Outcome_unknown
             ("restore installed but parent sync failed: " ^ error.message))
      | _ -> Json.fail Conflict "restore destination already exists"))
;;
