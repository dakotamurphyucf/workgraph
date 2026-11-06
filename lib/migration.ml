open Core

type t =
  { workspace : Id.Workspace.t
  ; source : string
  ; destination : string
  ; revision : int
  ; planning_head : string option
  ; source_history_head : string option
  ; history_head : string option
  ; history_heads : (string * string) list
  }

let nullable = Option.value_map ~default:`Null ~f:Json.string

let to_json t =
  Json.obj
    [ "workspace_id", Id.Workspace.jsonaf_of_t t.workspace
    ; "source", Json.string t.source
    ; "destination", Json.string t.destination
    ; "planning_revision", Json.int t.revision
    ; "planning_head", nullable t.planning_head
    ; "source_history_head", nullable t.source_history_head
    ; "history_head", nullable t.history_head
    ; ( "history_heads"
      , Json.obj (List.map t.history_heads ~f:(fun (a, b) -> a, Json.string b)) )
    ; "from_release", Json.string "0.6.2"
    ; "source_format", Json.string "5"
    ; "source_history_format", Json.string "1"
    ; "register_in_fresh_registry", `True
    ; "old_api_requests_supported", `False
    ]
;;

let set json key value =
  match json with
  | `Object fields -> Json.obj (List.Assoc.add fields key value ~equal:String.equal)
  | _ -> Json.fail Corrupt_store "migration expected an object"
;;

let read ?(max_bytes = 4 * 1024 * 1024) path =
  match Eio.Path.kind ~follow:false path with
  | `Regular_file -> Disk.read_with_limit path ~max_bytes
  | _ -> Json.fail Corrupt_store "migration requires regular canonical files"
;;

let with_stage_lock ~sw path f =
  let lock = Eio.Path.open_out ~sw ~create:(`If_missing 0o600) path in
  Exn.protect
    ~finally:(fun () -> Eio.Resource.close lock)
    ~f:(fun () ->
      if not (Platform.lock_exclusive lock)
      then Json.fail Conflict "migration stage is still active";
      f ())
;;

let version json expected =
  if not (String.equal (Json.text (Json.field json "version")) expected)
  then
    Json.fail Unsupported_version "migration supports only released 0.6.2 source formats"
;;

let digest value =
  match value with
  | `Null -> None
  | value ->
    let value = Json.text value in
    Session_event.Blob_ref.create ~digest:value ~size_bytes:0 |> Disk.unwrap |> ignore;
    Some value
;;

(* This source decoder is deliberately local to explicit offline conversion.
   Ordinary runtime decoders never admit these older history/session shapes. *)
module Source_v062 = struct
  let session json =
    Json.fields
      json
      ~allowed:
        [ "workspace_id"; "id"; "title"; "actor"; "run"; "parent"; "scopes"; "archived" ];
    let json = set (set json "created_at_unix_ms" `Null) "last_event_at_unix_ms" `Null in
    Session.of_json json |> Disk.unwrap |> ignore;
    json
  ;;

  let batch json ~previous =
    version json "1";
    Json.fields
      json
      ~allowed:
        [ "version"
        ; "workspace_id"
        ; "sequence"
        ; "previous"
        ; "key"
        ; "request_hash"
        ; "change"
        ; "response"
        ];
    let change = Json.field json "change" in
    let response = Json.field json "response" in
    let change, response =
      match Json.text (Json.field change "kind") with
      | "create" ->
        Json.fields change ~allowed:[ "kind"; "session" ];
        Json.fields response ~allowed:[ "durable"; "session"; "through" ];
        ( set change "session" (session (Json.field change "session"))
        , set response "session" (session (Json.field response "session")) )
      | "archive" ->
        Json.fields change ~allowed:[ "kind"; "session_id" ];
        Json.fields response ~allowed:[ "durable"; "session" ];
        change, set response "session" (session (Json.field response "session"))
      | "append" ->
        Json.fields change ~allowed:[ "kind"; "session_id"; "actor"; "run"; "events" ];
        Json.fields response ~allowed:[ "durable"; "session_id"; "through"; "events" ];
        set change "committed_at_unix_ms" `Null, response
      | _ -> Json.fail Unsupported_version "unsupported source history change"
    in
    let target =
      set
        (set
           (set
              (set json "version" (Current_format.value History_batch))
              "previous"
              (nullable previous))
           "change"
           change)
        "response"
        response
    in
    History_storage.Batch.of_json target |> Disk.unwrap |> ignore;
    target
  ;;
end

let overlap left right =
  String.equal left right
  || String.is_prefix left ~prefix:(right ^ "/")
  || String.is_prefix right ~prefix:(left ^ "/")
;;

let canonical_destination destination =
  Disk.absolute destination;
  let parent = Platform.realpath (Filename.dirname destination) in
  let name = Filename.basename destination in
  if List.mem [ ""; "."; ".." ] name ~equal:String.equal
  then Json.fail Invalid_argument "migration requires a named destination";
  Filename.concat parent name
;;

let run ~sw ~fs ~random ~source ~destination =
  let staged = ref None in
  let cleanup_ready = ref false in
  let published = ref false in
  let result =
    Disk.protect (fun () ->
      Disk.absolute source;
      let source = Platform.realpath source in
      let destination = canonical_destination destination in
      if overlap source destination
      then Json.fail Invalid_argument "migration roots must not overlap";
      let src = Eio.Path.(fs / source) in
      let dst = Eio.Path.(fs / destination) in
      Disk.require_directory src;
      (match Eio.Path.kind ~follow:false dst with
       | `Not_found -> ()
       | _ -> Json.fail Conflict "migration destination already exists");
      let descriptor_bytes = read Eio.Path.(src / "workspace.json") in
      let descriptor_json = Json.parse descriptor_bytes |> Disk.unwrap in
      version descriptor_json "5";
      Json.fields descriptor_json ~allowed:[ "version"; "workspace_id"; "name" ];
      let descriptor =
        Storage.Descriptor.create
          ~workspace:
            (Id.Workspace.t_of_jsonaf (Json.field descriptor_json "workspace_id"))
          ~name:(Json.text (Json.field descriptor_json "name"))
        |> Disk.unwrap
      in
      let workspace = Storage.Descriptor.workspace descriptor in
      Disk.ensure_directory Eio.Path.(src / ".local");
      let guard = Eio.Path.(src / ".local/writer.lock") in
      (match Eio.Path.kind ~follow:false guard with
       | `Not_found | `Regular_file -> ()
       | _ -> Json.fail Conflict "source writer guard is unsafe");
      let lock = Eio.Path.open_out ~sw ~create:(`If_missing 0o600) guard in
      Exn.protect
        ~finally:(fun () -> Eio.Resource.close lock)
        ~f:(fun () ->
          if not (Platform.lock_exclusive lock)
          then Json.fail Conflict "stop the source daemon before migration";
          if not (String.equal descriptor_bytes (read Eio.Path.(src / "workspace.json")))
          then Json.fail Conflict "source descriptor changed during migration admission";
          Disk.require_directory Eio.Path.(src / "transactions");
          Disk.require_directory Eio.Path.(src / "blobs");
          let head_bytes = read Eio.Path.(src / "HEAD.json") in
          let head =
            Json.parse head_bytes |> Disk.unwrap |> Storage.Head.of_json |> Disk.unwrap
          in
          let rec planning sequence predecessor total acc =
            match sequence, predecessor with
            | 0, None -> acc
            | sequence, Some hash when sequence > 0 ->
              let name = sprintf "%012d-%s.json" sequence hash in
              let bytes = read Eio.Path.(src / "transactions" / name) in
              if not (String.equal (Json.hash bytes) hash)
              then Json.fail Corrupt_store "source transaction digest mismatch";
              let total = total + String.length bytes in
              if total > Admission.Limit.maximum Planning_transaction_bytes
              then Json.fail Corrupt_store "source planning metadata exceeds capacity";
              let json = Json.parse bytes |> Disk.unwrap in
              version json "5";
              version (Json.field json "events") "5";
              let tx = Storage.Transaction.of_json json |> Disk.unwrap in
              if
                (not (Id.Workspace.equal workspace (Storage.Transaction.workspace tx)))
                || Storage.Transaction.sequence tx <> sequence
              then Json.fail Corrupt_store "source planning identity mismatch";
              planning
                (sequence - 1)
                (Storage.Transaction.previous tx)
                total
                (("transactions/" ^ name, bytes, tx) :: acc)
            | _ -> Json.fail Corrupt_store "source planning chain interrupted"
          in
          let transactions =
            planning (Storage.Head.sequence head) (Storage.Head.digest head) 0 []
          in
          let state, _ =
            List.fold
              transactions
              ~init:
                ( State.empty ~workspace ~name:(Storage.Descriptor.name descriptor)
                  |> Disk.unwrap
                , String.Set.empty )
              ~f:(fun (state, keys) (_, _, tx) ->
                let key = Storage.Transaction.key tx in
                if Set.mem keys key
                then Json.fail Corrupt_store "duplicate source planning receipt";
                ( State.replay state (Storage.Transaction.events tx) |> Disk.unwrap
                , Set.add keys key ))
          in
          let history_head_path = Eio.Path.(src / "history/HEAD.json") in
          let source_history_bytes = ref None in
          let history_head =
            match Eio.Path.kind ~follow:false Eio.Path.(src / "history") with
            | `Not_found -> None
            | `Directory ->
              (match Eio.Path.kind ~follow:false history_head_path with
               | `Not_found -> None
               | `Regular_file ->
                 let bytes = read history_head_path in
                 source_history_bytes := Some bytes;
                 let head =
                   History_storage.Head.of_json (Json.parse bytes |> Disk.unwrap)
                   |> Disk.unwrap
                 in
                 if
                   not
                     (Id.Workspace.equal workspace (History_storage.Head.workspace head))
                 then Json.fail Corrupt_store "source history workspace mismatch";
                 Some head
               | _ -> Json.fail Corrupt_store "unsafe source history HEAD")
            | _ -> Json.fail Corrupt_store "unsafe source history directory"
          in
          Option.iter history_head ~f:(fun _ ->
            Disk.require_directory Eio.Path.(src / "history/batches"));
          let rec history sequence predecessor total acc =
            match sequence, predecessor with
            | 0, None -> acc
            | sequence, Some hash when sequence > 0 ->
              let bytes = read Eio.Path.(src / "history/batches" / (hash ^ ".json")) in
              if not (String.equal (Json.hash bytes) hash)
              then Json.fail Corrupt_store "source history digest mismatch";
              let total = total + String.length bytes in
              if total > Admission.Limit.maximum History_batch_bytes
              then Json.fail Corrupt_store "source history metadata exceeds capacity";
              let json = Json.parse bytes |> Disk.unwrap in
              version json "1";
              if
                Json.integer (Json.field json "sequence") <> sequence
                || not
                     (Id.Workspace.equal
                        workspace
                        (Id.Workspace.t_of_jsonaf (Json.field json "workspace_id")))
              then Json.fail Corrupt_store "source history identity mismatch";
              history
                (sequence - 1)
                (digest (Json.field json "previous"))
                total
                ((hash, json) :: acc)
            | _ -> Json.fail Corrupt_store "source history chain interrupted"
          in
          let batches =
            Option.value_map history_head ~default:[] ~f:(fun h ->
              history
                (History_storage.Head.sequence h)
                (History_storage.Head.digest h)
                0
                [])
          in
          let mappings, rewritten, new_head, _ =
            List.fold
              batches
              ~init:([], [], None, 0)
              ~f:(fun (maps, files, previous, total) (old, json) ->
                let json = Source_v062.batch json ~previous in
                let bytes = Json.canonical json in
                let total = total + String.length bytes in
                if
                  String.length bytes > 4 * 1024 * 1024
                  || total > Admission.Limit.maximum History_batch_bytes
                then
                  Json.fail
                    Blocked
                    "timestamp migration exceeds target history metadata capacity";
                let hash = Json.hash bytes in
                ( (old, hash) :: maps
                , ("history/batches/" ^ hash ^ ".json", bytes) :: files
                , Some hash
                , total ))
          in
          let source_history_head =
            Option.bind history_head ~f:History_storage.Head.digest
          in
          let report =
            { workspace
            ; source
            ; destination
            ; revision = State.revision state
            ; planning_head = Storage.Head.digest head
            ; source_history_head
            ; history_head = new_head
            ; history_heads = List.rev mappings
            }
          in
          let files =
            [ "workspace.json", Storage.Descriptor.to_json descriptor |> Json.canonical
            ; "HEAD.json", head_bytes
            ; ".gitignore", ".local/\n"
            ]
            @ List.map transactions ~f:(fun (name, bytes, _) -> name, bytes)
            @ List.rev rewritten
            @ Option.to_list
                (Option.map history_head ~f:(fun h ->
                   let head =
                     History_storage.Head.create
                       ~workspace
                       ~sequence:(History_storage.Head.sequence h)
                       ~digest:new_head
                     |> Disk.unwrap
                   in
                   ( "history/HEAD.json"
                   , History_storage.Head.to_json head |> Json.canonical )))
          in
          let blobs =
            List.concat_map batches ~f:(fun (_, json) ->
              let change = Json.field json "change" in
              if String.equal (Json.text (Json.field change "kind")) "append"
              then
                Json.list (Json.field change "events")
                |> List.concat_map ~f:(fun json ->
                  Session_event.of_json json
                  |> Disk.unwrap
                  |> Session_event.blob_references
                  |> List.map ~f:(fun ref_ ->
                    ref_.Session_event.Blob_ref.digest, Some ref_.size_bytes))
              else [])
            @ State.blob_references state
            |> String.Map.of_alist_multi
          in
          let bytes = Cstruct.create 32 in
          Eio.Flow.read_exact random bytes;
          let token = Json.hash (Cstruct.to_string bytes) in
          let stage = destination ^ ".migrating-" ^ token in
          let stage_path = Eio.Path.(fs / stage) in
          let names =
            List.map files ~f:fst
            @ List.map (Map.keys blobs) ~f:(fun hash -> "blobs/" ^ hash)
            @ [ ".local/writer.lock"; ".local/migration.lock"; ".local/migration.json" ]
          in
          let marker =
            Json.obj
              [ "version", Json.string "1"
              ; "stage", Json.string stage
              ; "owner_token", Json.string token
              ; "report", to_json report
              ; "target_workspace_format", Current_format.value Workspace
              ; "target_history_format", Current_format.value History_batch
              ; "source_descriptor_sha256", Json.string (Json.hash descriptor_bytes)
              ; "source_head_sha256", Json.string (Json.hash head_bytes)
              ; ( "source_history_head_sha256"
                , nullable (Option.map !source_history_bytes ~f:Json.hash) )
              ; "files", `Array (List.map names ~f:Json.string)
              ]
          in
          let marker_bytes = Json.canonical marker in
          if String.length marker_bytes > 64 * 1024 * 1024
          then Json.fail Blocked "migration ownership inventory exceeds 64MiB";
          Eio.Path.mkdir ~perm:0o700 stage_path;
          staged := Some (stage, token);
          Disk.ensure_directory Eio.Path.(stage_path / ".local");
          with_stage_lock
            ~sw
            Eio.Path.(stage_path / ".local/migration.lock")
            (fun () ->
               Disk.write_new Eio.Path.(stage_path / ".local/migration.json") marker_bytes;
               cleanup_ready := true;
               List.iter [ "transactions"; "blobs" ] ~f:(fun name ->
                 Disk.ensure_directory Eio.Path.(stage_path / name));
               if Option.is_some history_head
               then (
                 Disk.ensure_directory Eio.Path.(stage_path / "history");
                 Disk.ensure_directory Eio.Path.(stage_path / "history/batches"));
               Map.iteri blobs ~f:(fun ~key:hash ~data:sizes ->
                 let actual, size =
                   Blob.copy
                     Eio.Path.(src / "blobs" / hash)
                     ~dst:Eio.Path.(stage_path / "blobs" / hash)
                   |> Disk.unwrap
                 in
                 if
                   (not (String.equal hash actual))
                   || List.exists sizes ~f:(fun expected ->
                     Option.value_map expected ~default:false ~f:(fun expected ->
                       expected <> size))
                 then Json.fail Corrupt_store "source blob identity mismatch");
               let ordinary, heads =
                 List.partition_tf files ~f:(fun (name, _) ->
                   not
                     (List.mem
                        [ "HEAD.json"; "history/HEAD.json" ]
                        name
                        ~equal:String.equal))
               in
               List.iter (ordinary @ heads) ~f:(fun (name, bytes) ->
                 Disk.write_new Eio.Path.(stage_path / name) bytes);
               let store, actual =
                 Store.open_existing ~sw ~fs ~root:stage |> Disk.unwrap
               in
               Exn.protect
                 ~finally:(fun () -> Store.close store)
                 ~f:(fun () ->
                   if
                     State.revision actual <> report.revision
                     || not
                          (Option.equal
                             String.equal
                             (Store.head store)
                             report.planning_head)
                   then Json.fail Corrupt_store "migrated planning capture differs";
                   let capture = Store.history_capture store |> Disk.unwrap in
                   if
                     not
                       (Option.equal
                          String.equal
                          (Session_store.Capture.head capture)
                          report.history_head)
                   then Json.fail Corrupt_store "migrated history capture differs");
               let current_history_bytes =
                 match Eio.Path.kind ~follow:false history_head_path with
                 | `Not_found -> None
                 | `Regular_file -> Some (read history_head_path)
                 | _ -> Json.fail Conflict "source history HEAD changed during migration"
               in
               if
                 (not
                    (String.equal
                       descriptor_bytes
                       (read Eio.Path.(src / "workspace.json"))))
                 || (not (String.equal head_bytes (read Eio.Path.(src / "HEAD.json"))))
                 || not
                      (Option.equal
                         String.equal
                         !source_history_bytes
                         current_history_bytes)
               then Json.fail Conflict "source changed during migration";
               Platform.sync_directory stage_path;
               Platform.rename_exclusive ~src:stage_path ~dst;
               published := true;
               match
                 Disk.protect (fun () ->
                   Platform.sync_directory Eio.Path.(fs / Filename.dirname destination))
               with
               | Ok () -> report
               | Error error ->
                 Json.fail
                   Outcome_unknown
                   ("migration published at "
                    ^ destination
                    ^ " but parent sync failed: "
                    ^ error.message))))
  in
  match result, !staged with
  | Error error, Some (stage, token) when not !published ->
    let suffix =
      if !cleanup_ready
      then "; owned stage: " ^ stage ^ "; cleanup owner token: " ^ token
      else
        "; partial stage: "
        ^ stage
        ^ "; ownership marker incomplete; automatic cleanup unavailable"
    in
    Error { error with message = error.message ^ suffix }
  | (Error _ as result), Some _ -> result
  | result, None | (Ok _ as result), Some _ -> result
;;

let cleanup ~fs ~stage ~owner_token =
  Disk.protect (fun () ->
    Disk.absolute stage;
    let stage = Platform.realpath stage in
    let root = Eio.Path.(fs / stage) in
    Disk.require_directory root;
    Disk.require_directory Eio.Path.(root / ".local");
    let marker =
      read ~max_bytes:(64 * 1024 * 1024) Eio.Path.(root / ".local/migration.json")
      |> Json.parse_with_limit ~max_bytes:(64 * 1024 * 1024)
      |> Disk.unwrap
    in
    version marker "1";
    Json.fields
      marker
      ~allowed:
        [ "version"
        ; "stage"
        ; "owner_token"
        ; "report"
        ; "target_workspace_format"
        ; "target_history_format"
        ; "source_descriptor_sha256"
        ; "source_head_sha256"
        ; "source_history_head_sha256"
        ; "files"
        ];
    let destination = Json.text (Json.field (Json.field marker "report") "destination") in
    let source = Json.text (Json.field (Json.field marker "report") "source") in
    if
      (not (String.equal stage (Json.text (Json.field marker "stage"))))
      || (not (String.equal owner_token (Json.text (Json.field marker "owner_token"))))
      || (not (String.equal stage (destination ^ ".migrating-" ^ owner_token)))
      || overlap (Platform.realpath stage) source
    then Json.fail Conflict "migration cleanup ownership mismatch";
    (match Eio.Path.kind ~follow:false Eio.Path.(root / ".local/migration.lock") with
     | `Regular_file -> ()
     | _ -> Json.fail Conflict "migration stage lock is missing or unsafe");
    Eio.Switch.run (fun sw ->
      with_stage_lock
        ~sw
        Eio.Path.(root / ".local/migration.lock")
        (fun () ->
           let allowed =
             Json.list (Json.field marker "files")
             |> List.map ~f:Json.text
             |> String.Set.of_list
           in
           let directories =
             String.Set.of_list
               [ ".local"
               ; ".local/uploads"
               ; "transactions"
               ; "blobs"
               ; "history"
               ; "history/batches"
               ]
           in
           let rec inventory relative (files, dirs) =
             let path = Eio.Path.(root / relative) in
             match Eio.Path.kind ~follow:false path with
             | `Regular_file when Set.mem allowed relative -> relative :: files, dirs
             | `Directory when String.is_empty relative || Set.mem directories relative ->
               let files, dirs =
                 List.fold
                   (Eio.Path.read_dir path)
                   ~init:(files, relative :: dirs)
                   ~f:(fun acc name ->
                     inventory
                       (if String.is_empty relative then name else relative ^ "/" ^ name)
                       acc)
               in
               files, dirs
             | _ -> Json.fail Conflict "migration cleanup found an unexpected entry"
           in
           let files, dirs = inventory "" ([], []) in
           List.iter files ~f:(fun name -> Eio.Path.unlink Eio.Path.(root / name));
           List.iter dirs ~f:(fun name -> Eio.Path.rmdir Eio.Path.(root / name));
           Platform.sync_directory Eio.Path.(fs / Filename.dirname stage))))
;;
