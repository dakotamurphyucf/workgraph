open Core

type receipt =
  { request_hash : string
  ; response : Jsonaf.t
  }

type t =
  { fs : Eio.Fs.dir_ty Eio.Path.t
  ; root : string
  ; workspace : Id.Workspace.t
  ; cache_generation : int
  ; lock : Eio.File.rw_ty Eio.Resource.t
  ; history : Session_store.t
  ; mutable heartbeats : Heartbeat.t option
  ; uploads : Upload.t
  ; mutable head : string option
  ; mutable head_bytes : string
  ; mutable sequence : int
  ; mutable receipts : receipt String.Map.t
  ; mutable transactions : (string * string) list
  ; descriptor_bytes : string
  ; mutable retained_bytes : int
  ; mutable closed : bool
  ; mutable fenced : bool
  }

let next_cache_generation = Atomic.make 0
let cache_generation t = t.cache_generation
let root t = t.root
let head t = t.head
let known_history_head t = Session_store.last_committed_head t.history

let has_ancestor t ~digest =
  let suffix = "-" ^ digest ^ ".json" in
  List.exists t.transactions ~f:(fun (name, _) -> String.is_suffix name ~suffix)
;;

let receipt t ~key = Map.find t.receipts key

let lookup_receipt t ~key =
  if t.closed || t.fenced
  then Error (Problem.create Outcome_unknown "recover workspace before receipt lookup")
  else Ok (receipt t ~key)
;;

let path t relative = Eio.Path.(t.fs / t.root / relative)

let require_storage_directories t =
  if t.closed then Json.fail Workspace_closed "workspace is closed";
  if t.fenced then Json.fail Outcome_unknown "workspace requires close and recovery";
  match
    Disk.protect (fun () ->
      List.iter [ ""; "transactions"; "blobs"; ".local" ] ~f:(fun relative ->
        Disk.require_directory (path t relative)))
  with
  | Ok () -> ()
  | Error error ->
    t.fenced <- true;
    raise (Json.Decode_error error)
;;

let head_json sequence digest =
  Storage.Head.create ~sequence ~digest |> Disk.unwrap |> Storage.Head.to_json
;;

let close t =
  if not t.closed
  then (
    t.closed <- true;
    Eio.Resource.close t.lock)
;;

let create ~fs ~root ~workspace ~name ~creation_token =
  Disk.protect (fun () ->
    Disk.absolute root;
    if
      String.length creation_token <> 64
      || not
           (String.for_all creation_token ~f:(fun c ->
              Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
    then Json.fail Invalid_argument "invalid creation token";
    ignore (State.empty ~workspace ~name |> Disk.unwrap : State.t);
    let root_path = Eio.Path.(fs / root) in
    let marker =
      Json.canonical
        (Json.obj
           [ "token", Json.string creation_token
           ; "workspace_id", Id.Workspace.jsonaf_of_t workspace
           ; "name", Json.string name
           ])
    in
    let descriptor =
      Storage.Descriptor.create ~workspace ~name
      |> Disk.unwrap
      |> Storage.Descriptor.to_json
      |> Json.canonical
    in
    let sync_parent () =
      match Eio.Path.split root_path with
      | Some (parent, _) -> Platform.sync_directory parent
      | None -> assert false
    in
    (match Eio.Path.kind ~follow:false root_path with
     | `Directory ->
       List.iter [ "transactions"; "blobs"; ".local" ] ~f:(fun relative ->
         Disk.require_directory Eio.Path.(root_path / relative));
       (match
          Eio.Path.kind ~follow:false Eio.Path.(root_path / ".local" / "creation.json")
        with
        | `Regular_file -> ()
        | _ -> Json.fail Conflict "workspace root belongs to another creation");
       if
         (not
            (String.equal
               (Disk.read Eio.Path.(root_path / ".local" / "creation.json"))
               marker))
         || not
              (String.equal
                 (Disk.read Eio.Path.(root_path / "workspace.json"))
                 descriptor)
       then Json.fail Conflict "workspace root belongs to another creation";
       sync_parent ()
     | `Not_found ->
       (* The durable registry intent owns this token-specific stage. It is never
          opened as a workspace before the complete directory is installed. *)
       let stage = Eio.Path.(fs / (root ^ ".initializing-" ^ creation_token)) in
       Disk.ensure_directory stage;
       List.iter [ "transactions"; "blobs"; ".local" ] ~f:(fun name ->
         Disk.ensure_directory Eio.Path.(stage / name));
       Disk.replace Eio.Path.(stage / "workspace.json") descriptor;
       Disk.replace Eio.Path.(stage / "HEAD.json") (Json.canonical (head_json 0 None));
       Disk.replace Eio.Path.(stage / ".gitignore") ".local/\n";
       Disk.replace Eio.Path.(stage / ".local" / "creation.json") marker;
       Platform.sync_directory stage;
       Platform.rename_exclusive ~src:stage ~dst:root_path;
       sync_parent ()
     | _ -> Json.fail Conflict "workspace root already exists");
    ())
;;

let filename sequence digest = sprintf "%012d-%s.json" sequence digest

let check_digest digest =
  if
    String.length digest <> 64
    || not
         (String.for_all digest ~f:(fun c ->
            Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
  then Json.fail Corrupt_store "invalid digest"
;;

let verify_blob t ~digest ~size_bytes =
  check_digest digest;
  let actual, size = Blob.inspect (path t ("blobs/" ^ digest)) |> Disk.unwrap in
  if not (String.equal actual digest) then Json.fail Corrupt_store "blob digest mismatch";
  Option.iter size_bytes ~f:(fun expected ->
    if not (Int.equal expected size)
    then Json.fail Corrupt_store "blob size differs from metadata");
  size
;;

let read_blob t ~digest =
  Disk.protect (fun () ->
    require_storage_directories t;
    let size = verify_blob t ~digest ~size_bytes:None in
    if size > 65_536
    then Json.fail Invalid_argument "use resource.read_chunk for files over 64KiB";
    let bytes = Disk.read (path t ("blobs/" ^ digest)) in
    if
      not
        (Uutf.String.fold_utf_8
           (fun valid _ -> function
              | `Uchar _ -> valid
              | `Malformed _ -> false)
           true
           bytes)
    then Json.fail Invalid_argument "resource is not UTF-8; use resource.read_chunk";
    bytes)
;;

let read_blob_range t ~digest ~offset ~length =
  Disk.protect (fun () ->
    require_storage_directories t;
    check_digest digest;
    Blob.read_range (path t ("blobs/" ^ digest)) ~offset ~length |> Disk.unwrap)
;;

let extract_search_texts t ~resources =
  Disk.protect (fun () ->
    let rec load remaining acc = function
      | [] -> List.rev acc
      | _ when remaining <= 0 -> List.rev acc
      | resource :: rest ->
        let version = Resource.get_version resource ~revision:None in
        let bytes, total_bytes =
          read_blob_range
            t
            ~digest:version.digest
            ~offset:0
            ~length:(Int.min 65_536 remaining)
          |> Disk.unwrap
        in
        Option.iter version.size_bytes ~f:(fun expected ->
          if not (Int.equal expected total_bytes)
          then Json.fail Corrupt_store "resource text size changed");
        let prefix_bytes, valid =
          Uutf.String.fold_utf_8
            (fun (prefix_bytes, valid) offset -> function
               | `Uchar _ -> prefix_bytes, valid
               | `Malformed invalid ->
                 if
                   offset + String.length invalid = String.length bytes
                   && total_bytes > String.length bytes
                 then Int.min prefix_bytes offset, valid
                 else prefix_bytes, false)
            (String.length bytes, true)
            bytes
        in
        let outcome =
          if valid
          then
            Search.Text.Content { text = String.prefix bytes prefix_bytes; total_bytes }
          else Invalid_utf8
        in
        let extracted =
          { Search.Text.id = resource.id
          ; version = version.revision
          ; digest = version.digest
          ; outcome
          }
        in
        load (remaining - String.length bytes) (extracted :: acc) rest
    in
    load (1024 * 1024) [] (List.take resources 32))
;;

let with_uploads t f =
  Disk.protect (fun () ->
    if t.closed || t.fenced
    then Json.fail Workspace_closed "workspace unavailable for uploads";
    require_storage_directories t;
    f t.uploads |> Disk.unwrap)
;;

let begin_upload t ~id ~actor ~size_bytes ~digest =
  with_uploads t (fun uploads ->
    Upload.begin_upload uploads ~id ~actor ~size_bytes ~digest)
;;

let upload_chunk t ~id ~actor ~offset ~bytes =
  with_uploads t (fun uploads -> Upload.chunk uploads ~id ~actor ~offset ~bytes)
;;

let upload_status t ~id ~actor =
  with_uploads t (fun uploads -> Upload.status uploads ~id ~actor)
;;

let abort_upload t ~id ~actor =
  with_uploads t (fun uploads -> Upload.abort uploads ~id ~actor)
;;

let finish_upload t ~id ~actor =
  with_uploads t (fun uploads -> Upload.finish uploads ~id ~actor ~blobs:(path t "blobs"))
;;

let forget_upload t ~id = Upload.forget t.uploads ~id

let validate_domain_history state capture =
  let sessions = Session_store.Capture.sessions capture in
  State.validate_history
    state
    ~session_exists:(fun id ->
      List.exists sessions ~f:(fun session -> Session_id.equal id (Session.id session)))
    ~event_exists:(fun ref_ -> Result.is_ok (Session_store.Capture.event capture ref_))
  |> Disk.unwrap
;;

let validate_history_state state capture =
  let sessions = Session_store.Capture.sessions capture in
  List.iter sessions ~f:(fun session ->
    State.validate_targets state (Session.scopes session) |> Disk.unwrap;
    List.iter
      (Session_store.Capture.events capture ~session:(Session.id session))
      ~f:(fun event ->
        List.iter (Session_event.resource_versions event) ~f:(fun reference ->
          ignore
            (State.resource_version state reference.id ~revision:(Some reference.revision)
             |> Disk.unwrap
             : Resource.Version.t))));
  validate_domain_history state capture
;;

let open_existing ~sw ~fs ~root =
  Disk.protect (fun () ->
    Disk.absolute root;
    let root_path = Eio.Path.(fs / root) in
    (match Eio.Path.kind ~follow:false root_path with
     | `Directory -> ()
     | _ -> Json.fail Invalid_argument "workspace root must be a directory");
    Disk.ensure_directory Eio.Path.(root_path / ".local");
    let lock_path = Eio.Path.(root_path / ".local/writer.lock") in
    (match Eio.Path.kind ~follow:false lock_path with
     | `Not_found | `Regular_file -> ()
     | _ -> Json.fail Conflict "invalid lock file");
    let lock = Eio.Path.open_out ~sw ~create:(`If_missing 0o600) lock_path in
    let ownership_transferred = ref false in
    Exn.protect
      ~finally:(fun () -> if not !ownership_transferred then Eio.Resource.close lock)
      ~f:(fun () ->
        if not (Platform.lock_exclusive lock)
        then Json.fail Conflict "workspace already open by another writer";
        let result =
          Disk.protect (fun () ->
            (* Git does not retain empty directories. Recreate missing canonical
           directories while locked, but never follow a substituted symlink. *)
            List.iter [ "transactions"; "blobs" ] ~f:(fun relative ->
              let directory = Eio.Path.(root_path / relative) in
              match Eio.Path.kind ~follow:false directory with
              | `Not_found -> Disk.ensure_directory directory
              | _ -> Disk.require_directory directory);
            let descriptor_bytes = Disk.read Eio.Path.(root_path / "workspace.json") in
            let descriptor =
              descriptor_bytes
              |> Json.parse
              |> Disk.unwrap
              |> Storage.Descriptor.of_json
              |> Disk.unwrap
            in
            let workspace = Storage.Descriptor.workspace descriptor in
            let name = Storage.Descriptor.name descriptor in
            let head_bytes = Disk.read Eio.Path.(root_path / "HEAD.json") in
            let stored_head =
              Json.parse head_bytes |> Disk.unwrap |> Storage.Head.of_json |> Disk.unwrap
            in
            let sequence = Storage.Head.sequence stored_head in
            let head = Storage.Head.digest stored_head in
            let rec walk sequence digest total_bytes acc =
              match sequence, digest with
              | 0, None -> acc
              | sequence, Some digest when sequence > 0 ->
                check_digest digest;
                let name = filename sequence digest in
                let bytes = Disk.read Eio.Path.(root_path / "transactions" / name) in
                let total_bytes = total_bytes + String.length bytes in
                if total_bytes > 128 * 1024 * 1024
                then
                  Json.fail Corrupt_store "MVP retained transaction bytes exceed 128 MiB";
                if not (String.equal (Json.hash bytes) digest)
                then Json.fail Corrupt_store "transaction digest mismatch";
                let tx =
                  Json.parse bytes
                  |> Disk.unwrap
                  |> Storage.Transaction.of_json
                  |> Disk.unwrap
                in
                if not (Id.Workspace.equal workspace (Storage.Transaction.workspace tx))
                then Json.fail Corrupt_store "transaction belongs to another workspace";
                if Storage.Transaction.sequence tx <> sequence
                then Json.fail Corrupt_store "transaction sequence mismatch";
                let previous = Storage.Transaction.previous tx in
                walk (sequence - 1) previous total_bytes ((name, bytes, tx) :: acc)
              | _ -> Json.fail Corrupt_store "invalid head chain"
            in
            let transactions = walk sequence head 0 [] in
            let state, receipts =
              List.fold
                transactions
                ~init:(State.empty ~workspace ~name |> Disk.unwrap, String.Map.empty)
                ~f:(fun (state, receipts) (_, _, tx) ->
                  let state =
                    State.replay state (Storage.Transaction.events tx) |> Disk.unwrap
                  in
                  let key = Storage.Transaction.key tx in
                  if Map.mem receipts key
                  then Json.fail Corrupt_store "duplicate mutation receipt";
                  let receipt =
                    { request_hash = Storage.Transaction.request_hash tx
                    ; response = Storage.Transaction.response tx
                    }
                  in
                  state, Map.set receipts ~key ~data:receipt)
            in
            let t =
              { fs
              ; root
              ; workspace
              ; cache_generation = Atomic.fetch_and_add next_cache_generation 1
              ; lock
              ; history = Session_store.open_existing ~fs ~root ~workspace |> Disk.unwrap
              ; heartbeats = None
              ; uploads = Upload.create ~directory:Eio.Path.(root_path / ".local/uploads")
              ; head
              ; head_bytes
              ; sequence
              ; receipts
              ; transactions =
                  List.rev_map transactions ~f:(fun (name, bytes, _) -> name, bytes)
              ; descriptor_bytes
              ; retained_bytes =
                  List.sum
                    (module Int)
                    transactions
                    ~f:(fun (_, bytes, _) -> String.length bytes)
              ; closed = false
              ; fenced = false
              }
            in
            let verified = ref String.Map.empty in
            List.iter (State.blob_references state) ~f:(fun (digest, size_bytes) ->
              match Map.find !verified digest with
              | Some size ->
                Option.iter size_bytes ~f:(fun expected ->
                  if not (Int.equal expected size)
                  then Json.fail Corrupt_store "blob size differs across versions")
              | None ->
                let size = verify_blob t ~digest ~size_bytes in
                verified := Map.set !verified ~key:digest ~data:size);
            if
              Map.fold !verified ~init:0 ~f:(fun ~key:_ ~data:size total -> total + size)
              > 512 * 1024 * 1024
            then Json.fail Corrupt_store "referenced blob storage exceeds 512MiB";
            validate_history_state state (Session_store.capture t.history |> Disk.unwrap);
            t, state)
        in
        match result with
        | Ok value ->
          ownership_transferred := true;
          value
        | Error error -> raise (Json.Decode_error error)))
;;

let commit t ~prepared ~key ~request_hash =
  let attempted_head = ref false in
  let result =
    Disk.protect (fun () ->
      if t.closed then Json.fail Workspace_closed "workspace is closed";
      if t.fenced then Json.fail Outcome_unknown "workspace requires close and recovery";
      require_storage_directories t;
      if not (Id.Workspace.equal t.workspace (State.workspace (State.candidate prepared)))
      then Json.fail Conflict "prepared transaction belongs to another workspace";
      if not (String.equal (Disk.read (path t "HEAD.json")) t.head_bytes)
      then (
        t.fenced <- true;
        Json.fail Conflict "workspace head changed externally");
      if not (String.equal (Disk.read (path t "workspace.json")) t.descriptor_bytes)
      then (
        t.fenced <- true;
        Json.fail Conflict "workspace identity changed externally");
      if State.revision (State.candidate prepared) <> t.sequence + 1
      then Json.fail Conflict "stale prepared transaction";
      if t.sequence >= 100_000
      then Json.fail Invalid_argument "MVP transaction limit is 100000";
      validate_domain_history
        (State.candidate prepared)
        (Session_store.capture t.history |> Disk.unwrap);
      let sequence = t.sequence + 1 in
      let response =
        Json.obj
          [ "workspace_revision", Json.int sequence
          ; "durable", `True
          ; "result", State.result prepared
          ]
      in
      let tx =
        Json.obj
          [ "version", Json.int 1
          ; ( "workspace_id"
            , Id.Workspace.jsonaf_of_t (State.workspace (State.candidate prepared)) )
          ; "sequence", Json.int sequence
          ; "previous", Option.value_map t.head ~default:`Null ~f:Json.string
          ; "key", Json.string key
          ; "request_hash", Json.string request_hash
          ; "events", State.events prepared
          ; "response", response
          ]
      in
      ignore (Storage.Transaction.of_json tx |> Disk.unwrap : Storage.Transaction.t);
      if Map.mem t.receipts key
      then Json.fail Idempotency_conflict "receipt already committed";
      let bytes = Json.canonical tx in
      if String.length bytes > 4 * 1024 * 1024
      then Json.fail Invalid_argument "transaction exceeds 4 MiB";
      if t.retained_bytes + String.length bytes > 128 * 1024 * 1024
      then Json.fail Invalid_argument "MVP retained transaction bytes exceed 128 MiB";
      List.iter (State.blobs prepared) ~f:(fun (digest, bytes) ->
        let target = path t ("blobs/" ^ digest) in
        match Eio.Path.kind ~follow:false target with
        | `Not_found -> Disk.replace target bytes
        | `Regular_file ->
          ignore (verify_blob t ~digest ~size_bytes:(Some (String.length bytes)) : int)
        | _ -> Json.fail Corrupt_store "invalid blob path");
      List.iter (State.required_blobs prepared) ~f:(fun (digest, size_bytes) ->
        ignore (verify_blob t ~digest ~size_bytes : int));
      let digest = Json.hash bytes in
      let name = filename sequence digest in
      let target = path t ("transactions/" ^ name) in
      (match Eio.Path.kind ~follow:false target with
       | `Not_found -> Disk.replace target bytes
       | `Regular_file ->
         if not (String.equal (Disk.read target) bytes)
         then Json.fail Corrupt_store "transaction collision"
       | _ -> Json.fail Corrupt_store "invalid transaction path");
      let head_bytes = Json.canonical (head_json sequence (Some digest)) in
      attempted_head := true;
      t.fenced <- true;
      Disk.replace (path t "HEAD.json") head_bytes;
      t.head <- Some digest;
      t.head_bytes <- head_bytes;
      t.sequence <- sequence;
      t.transactions <- (name, bytes) :: t.transactions;
      t.retained_bytes <- t.retained_bytes + String.length bytes;
      t.receipts <- Map.set t.receipts ~key ~data:{ request_hash; response };
      t.fenced <- false;
      response)
  in
  match result with
  | Ok response -> Ok response
  | Error error when !attempted_head ->
    t.fenced <- true;
    Error
      (Problem.create
         Outcome_unknown
         ("recover workspace before retrying: " ^ error.message))
  | Error error -> Error error
;;

let with_history t ~f =
  Disk.protect (fun () ->
    if t.closed then Json.fail Workspace_closed "workspace is closed";
    if t.fenced then Json.fail Outcome_unknown "workspace requires close and recovery";
    require_storage_directories t;
    if
      (not (String.equal (Disk.read (path t "HEAD.json")) t.head_bytes))
      || not (String.equal (Disk.read (path t "workspace.json")) t.descriptor_bytes)
    then (
      t.fenced <- true;
      Json.fail Conflict "workspace storage changed externally");
    f t.history |> Disk.unwrap)
;;

let history_capture t = with_history t ~f:Session_store.capture

let capture t ~state =
  Disk.protect (fun () ->
    if t.closed || t.fenced
    then Json.fail Workspace_closed "workspace unavailable for capture";
    require_storage_directories t;
    if State.revision state <> t.sequence
    then Json.fail Conflict "capture state differs from durable head";
    if
      (not (String.equal (Disk.read (path t "HEAD.json")) t.head_bytes))
      || not (String.equal (Disk.read (path t "workspace.json")) t.descriptor_bytes)
    then Json.fail Conflict "workspace storage changed externally";
    Snapshot.create
      ~state
      ~source_root:t.root
      ~descriptor:t.descriptor_bytes
      ~head_bytes:t.head_bytes
      ~transactions:t.transactions
    |> Disk.unwrap
    |> fun snapshot ->
    Snapshot.with_history snapshot (history_capture t |> Disk.unwrap) |> Disk.unwrap)
;;

let capture_at t ~revision =
  Disk.protect (fun () ->
    if t.closed || t.fenced
    then Json.fail Workspace_closed "workspace unavailable for capture";
    require_storage_directories t;
    if revision < 0 || revision > t.sequence
    then Json.fail Conflict "captured revision is no longer in this workspace";
    if
      (not (String.equal (Disk.read (path t "HEAD.json")) t.head_bytes))
      || not (String.equal (Disk.read (path t "workspace.json")) t.descriptor_bytes)
    then Json.fail Conflict "workspace storage changed externally";
    let descriptor = Json.parse t.descriptor_bytes |> Disk.unwrap in
    let workspace = Id.Workspace.t_of_jsonaf (Json.field descriptor "workspace_id") in
    let initial =
      State.empty ~workspace ~name:(Json.text (Json.field descriptor "name"))
      |> Disk.unwrap
    in
    let chronological = List.take (List.rev t.transactions) revision in
    let state =
      List.fold chronological ~init:initial ~f:(fun state (_, bytes) ->
        let tx = Json.parse bytes |> Disk.unwrap in
        State.replay state (Json.field tx "events") |> Disk.unwrap)
    in
    let digest =
      Option.map (List.last chronological) ~f:(fun (_, bytes) -> Json.hash bytes)
    in
    Snapshot.create
      ~state
      ~source_root:t.root
      ~descriptor:t.descriptor_bytes
      ~head_bytes:(Json.canonical (head_json revision digest))
      ~transactions:(List.rev chronological)
    |> Disk.unwrap)
;;

let capture_at_history t ~revision ~history_head =
  Result.bind (capture_at t ~revision) ~f:(fun snapshot ->
    Result.bind
      (with_history t ~f:(fun history ->
         Session_store.capture_at history ~head:history_head))
      ~f:(Snapshot.with_history snapshot))
;;

let export t ~state ~destination =
  Result.bind (capture t ~state) ~f:(fun snapshot ->
    Snapshot.write
      snapshot
      ~fs:t.fs
      ~destination
      ~stage:(destination ^ ".exporting")
      ~check_cancelled:ignore
      ~before_publish:ignore)
;;

let heartbeat_cache t =
  match t.heartbeats with
  | Some cache -> Ok cache
  | None ->
    Result.map (Heartbeat.open_existing ~fs:t.fs ~root:t.root) ~f:(fun cache ->
      t.heartbeats <- Some cache;
      cache)
;;

let heartbeat t ~run ~actor ~now_unix_ms =
  with_history t ~f:(fun _ ->
    Result.bind (heartbeat_cache t) ~f:(fun cache ->
      Heartbeat.observe cache ~run ~actor ~now_unix_ms))
;;

let heartbeat_get t ~run =
  with_history t ~f:(fun _ ->
    Result.bind (heartbeat_cache t) ~f:(fun cache -> Heartbeat.get cache ~run))
;;

let flush_heartbeats t =
  with_history t ~f:(fun _ ->
    match t.heartbeats with
    | None -> Ok ()
    | Some cache -> Heartbeat.flush cache)
;;

let heartbeat_observations t =
  with_history t ~f:(fun _ -> Result.map (heartbeat_cache t) ~f:Heartbeat.observations)
;;
