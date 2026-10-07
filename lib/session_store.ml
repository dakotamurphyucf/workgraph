open Core

type session_state =
  { metadata : Session.t
  ; events : Session_event.t list
  ; by_client : Session_event.t String.Map.t
  ; upper_bound : int
  }

type inventory = (string * string * int) list

module Capture = struct
  type t =
    { workspace : Id.Workspace.t
    ; head : string option
    ; sequence : int
    ; sessions : session_state Session_id.Map.t
    ; files : inventory
    ; activity : Jsonaf.t list
    }

  let workspace t = t.workspace
  let head t = t.head
  let sequence t = t.sequence

  let head_bytes t =
    History_storage.Head.create ~workspace:t.workspace ~sequence:t.sequence ~digest:t.head
    |> Disk.unwrap
    |> History_storage.Head.to_json
    |> Json.canonical
  ;;

  let sessions t = Map.data t.sessions |> List.map ~f:(fun state -> state.metadata)

  let upper_bound t ~session =
    Option.value_map (Map.find t.sessions session) ~default:0 ~f:(fun state ->
      state.upper_bound)
  ;;

  let events t ~session =
    Option.value_map (Map.find t.sessions session) ~default:[] ~f:(fun state ->
      List.rev state.events)
  ;;

  let event t ref_ =
    match Map.find t.sessions ref_.Session.Event_ref.session with
    | None -> Error (Problem.create Not_found "session not found")
    | Some state ->
      (match
         List.find state.events ~f:(fun event ->
           Int.equal (Session_event.ref_ event).sequence ref_.sequence)
       with
       | None -> Error (Problem.create Not_found "event is outside committed capture")
       | Some event -> Ok event)
  ;;

  let portable_files t = t.files
  let activity t = t.activity

  let to_json t =
    Json.obj
      [ "workspace_id", Id.Workspace.jsonaf_of_t t.workspace
      ; "head", Option.value_map t.head ~default:`Null ~f:Json.string
      ; "sequence", Json.int t.sequence
      ; ( "sessions"
        , `Array
            (List.map (Map.to_alist t.sessions) ~f:(fun (id, state) ->
               Json.obj
                 [ "session_id", Session_id.jsonaf_of_t id
                 ; "through", Json.int state.upper_bound
                 ])) )
      ]
  ;;
end

type t =
  { fs : Eio.Fs.dir_ty Eio.Path.t
  ; root : string
  ; workspace : Id.Workspace.t
  ; mutable current : Capture.t
  ; mutable receipts : (string * Jsonaf.t) String.Map.t
  ; mutable retained_bytes : int
  ; mutable head_bytes : string option
  ; mutable fenced : bool
  }

let path t relative = Eio.Path.(t.fs / t.root / relative)

let require_directories t =
  Disk.require_directory (path t "");
  Disk.require_directory (path t "blobs");
  match Eio.Path.kind ~follow:false (path t "history") with
  | `Not_found -> ()
  | `Directory ->
    (match Eio.Path.kind ~follow:false (path t "history/batches") with
     | `Not_found when t.current.sequence = 0 -> ()
     | _ -> Disk.require_directory (path t "history/batches"))
  | _ -> Json.fail Corrupt_store "history must be real directory"
;;

let require_open t =
  if t.fenced
  then
    Json.fail Outcome_unknown "history owner fenced; reopen workspace before proceeding";
  (match Disk.protect (fun () -> require_directories t) with
   | Ok () -> ()
   | Error error ->
     t.fenced <- true;
     raise (Json.Decode_error error));
  let actual =
    match Eio.Path.kind ~follow:false (path t "history/HEAD.json") with
    | `Not_found -> None
    | `Regular_file -> Some (Disk.read (path t "history/HEAD.json"))
    | _ ->
      t.fenced <- true;
      Json.fail Conflict "history HEAD changed externally"
  in
  if not (Option.equal String.equal actual t.head_bytes)
  then (
    t.fenced <- true;
    Json.fail
      Conflict
      "history HEAD changed externally; reopen before mutation or capture")
;;

let check_digest digest =
  ignore
    (Disk.unwrap (Session_event.Blob_ref.create ~digest ~size_bytes:0)
     : Session_event.Blob_ref.t)
;;

let get_exn t session =
  match Map.find t.current.sessions session with
  | Some state -> state
  | None -> Json.fail Not_found "session not found"
;;

let validate_receipt ~key ~request_hash =
  check_digest request_hash;
  (match String.split key ~on:':' with
   | [ actor; mutation ] ->
     ignore (Id.Actor.of_string actor |> Disk.unwrap : Id.Actor.t);
     ignore (Id.Actor.of_string mutation |> Disk.unwrap : Id.Actor.t)
   | _ -> Json.fail Invalid_argument "history receipt requires actor:mutation");
  if
    String.is_empty key
    || String.length key > 256
    || not
         (String.for_all key ~f:(fun c ->
            Char.is_alphanum c || List.mem [ '_'; '-'; ':' ] c ~equal:Char.equal))
  then Json.fail Invalid_argument "invalid history receipt key"
;;

let lookup_receipt t ~key ~request_hash =
  Disk.protect (fun () ->
    require_open t;
    validate_receipt ~key ~request_hash;
    match Map.find t.receipts key with
    | None -> None
    | Some (hash, response) ->
      if not (String.equal hash request_hash)
      then Json.fail Idempotency_conflict "history key reused with different request";
      Some response)
;;

let verify_blob t ref_ =
  let digest, size =
    Blob.inspect (path t ("blobs/" ^ ref_.Session_event.Blob_ref.digest)) |> Disk.unwrap
  in
  if (not (String.equal digest ref_.digest)) || size <> ref_.size_bytes
  then Json.fail Corrupt_store "history blob identity differs from metadata"
;;

let blob_inventory event =
  List.map (Session_event.blob_references event) ~f:(fun ref_ ->
    "blobs/" ^ ref_.digest, ref_.digest, ref_.size_bytes)
;;

let add_files files additions =
  List.fold additions ~init:files ~f:(fun files ((name, digest, size) as entry) ->
    match List.find files ~f:(fun (existing, _, _) -> String.equal name existing) with
    | None -> entry :: files
    | Some (_, existing_digest, existing_size) ->
      if (not (String.equal digest existing_digest)) || size <> existing_size
      then Json.fail Corrupt_store "inconsistent history inventory";
      files)
;;

let apply capture change =
  match Json.text (Json.field change "kind") with
  | "create" ->
    Json.fields change ~allowed:[ "kind"; "session" ];
    let metadata = Session.of_json (Json.field change "session") |> Disk.unwrap in
    if not (Id.Workspace.equal capture.Capture.workspace (Session.workspace metadata))
    then Json.fail Corrupt_store "session belongs to another workspace";
    if Session.archived metadata || Map.mem capture.sessions (Session.id metadata)
    then Json.fail Corrupt_store "duplicate or archived session create";
    Option.iter (Session.parent metadata) ~f:(fun ref_ ->
      ignore (Disk.unwrap (Capture.event capture ref_) : Session_event.t));
    { capture with
      sessions =
        Map.add_exn
          capture.sessions
          ~key:(Session.id metadata)
          ~data:{ metadata; events = []; by_client = String.Map.empty; upper_bound = 0 }
    }
  | "archive" ->
    Json.fields change ~allowed:[ "kind"; "session_id" ];
    let id = Session_id.t_of_jsonaf (Json.field change "session_id") in
    let state =
      match Map.find capture.sessions id with
      | Some state -> state
      | None -> Json.fail Corrupt_store "archive session missing"
    in
    { capture with
      sessions =
        Map.set
          capture.sessions
          ~key:id
          ~data:{ state with metadata = Session.archive state.metadata }
    }
  | "append" ->
    Json.fields change ~allowed:[ "kind"; "session_id"; "actor"; "run"; "events" ];
    ignore (Id.Actor.t_of_jsonaf (Json.field change "actor") : Id.Actor.t);
    (match Json.field change "run" with
     | `Null -> ()
     | json -> ignore (Id.Run.t_of_jsonaf json : Id.Run.t));
    let id = Session_id.t_of_jsonaf (Json.field change "session_id") in
    let state =
      match Map.find capture.sessions id with
      | Some state -> state
      | None -> Json.fail Corrupt_store "append session missing"
    in
    if Session.archived state.metadata
    then Json.fail Corrupt_store "append to archived session";
    let events =
      Json.list (Json.field change "events")
      |> List.map ~f:(fun json -> Session_event.of_json json |> Disk.unwrap)
    in
    let state =
      List.fold events ~init:state ~f:(fun state event ->
        let ref_ = Session_event.ref_ event in
        if
          (not (Session_id.equal ref_.session id))
          || ref_.sequence <> state.upper_bound + 1
          || Map.mem state.by_client (Session_event.client_id event)
        then Json.fail Corrupt_store "history event sequence/client identity inconsistent";
        { state with
          events = event :: state.events
        ; upper_bound = ref_.sequence
        ; by_client =
            Map.add_exn state.by_client ~key:(Session_event.client_id event) ~data:event
        })
    in
    { capture with
      sessions = Map.set capture.sessions ~key:id ~data:state
    ; files = add_files capture.files (List.concat_map events ~f:blob_inventory)
    }
  | _ -> Json.fail Unsupported_version "unsupported history change kind"
;;

let validate_response capture ~change ~response =
  match Json.text (Json.field change "kind") with
  | "create" | "archive" ->
    let id =
      match Json.text (Json.field change "kind") with
      | "create" -> Session_id.t_of_jsonaf (Json.field (Json.field change "session") "id")
      | "archive" -> Session_id.t_of_jsonaf (Json.field change "session_id")
      | _ -> assert false
    in
    let state = Map.find_exn capture.Capture.sessions id in
    if
      not
        (String.equal
           (Json.canonical (Json.field response "session"))
           (Json.canonical (Session.to_json state.metadata)))
    then Json.fail Corrupt_store "history receipt metadata differs from committed state"
  | "append" ->
    let id = Session_id.t_of_jsonaf (Json.field change "session_id") in
    let through = Capture.upper_bound capture ~session:id in
    if Json.integer (Json.field response "through") <> through
    then Json.fail Corrupt_store "history receipt watermark differs from committed state";
    let refs =
      Json.list (Json.field response "events")
      |> List.map ~f:(fun json -> Session.Event_ref.of_json json |> Disk.unwrap)
    in
    List.iter refs ~f:(fun ref_ ->
      ignore (Capture.event capture ref_ |> Disk.unwrap : Session_event.t));
    List.iter
      (Json.list (Json.field change "events"))
      ~f:(fun json ->
        let ref_ = Session.Event_ref.of_json (Json.field json "ref") |> Disk.unwrap in
        if not (List.mem refs ref_ ~equal:Session.Event_ref.equal)
        then Json.fail Corrupt_store "history receipt omits a newly committed event")
  | _ -> Json.fail Unsupported_version "unsupported history receipt change"
;;

let audit capture ~change ~key ~sequence ~digest =
  let actor =
    match String.lsplit2 key ~on:':' with
    | Some (actor, _) -> Id.Actor.of_string actor |> Disk.unwrap
    | None -> Json.fail Corrupt_store "history receipt lacks actor prefix"
  in
  let kind, id, fields =
    match Json.text (Json.field change "kind") with
    | "create" ->
      let session = Session.of_json (Json.field change "session") |> Disk.unwrap in
      "Session_created", Session.id session, []
    | "archive" ->
      "Session_archived", Session_id.t_of_jsonaf (Json.field change "session_id"), []
    | "append" ->
      let id = Session_id.t_of_jsonaf (Json.field change "session_id") in
      let events = Json.list (Json.field change "events") in
      let sequences =
        List.map events ~f:(fun json ->
          Json.integer (Json.field (Json.field json "ref") "sequence"))
      in
      ( "Session_appended"
      , id
      , [ "appended_events", Json.int (List.length events)
        ; ( "first_sequence"
          , Option.value_map (List.hd sequences) ~default:`Null ~f:Json.int )
        ; ( "last_sequence"
          , Option.value_map (List.last sequences) ~default:`Null ~f:Json.int )
        ; "through", Json.int (Capture.upper_bound capture ~session:id)
        ] )
    | _ -> Json.fail Unsupported_version "unsupported history audit kind"
  in
  let state = Map.find_exn capture.Capture.sessions id in
  let entry =
    Json.obj
      [ "revision", Json.int sequence
      ; "batch_digest", Json.string digest
      ; "actor", Id.Actor.jsonaf_of_t actor
      ; "timestamp", Json.string ""
      ; ( "targets"
        , `Array (List.map (Session.scopes state.metadata) ~f:Entity_ref.jsonaf_of_t) )
      ; ( "changes"
        , `Array
            [ `Array
                [ Json.string kind
                ; Json.obj (("session_id", Session_id.jsonaf_of_t id) :: fields)
                ]
            ] )
      ]
  in
  { capture with activity = entry :: capture.activity }
;;

let empty workspace =
  { Capture.workspace
  ; head = None
  ; sequence = 0
  ; sessions = Session_id.Map.empty
  ; files = []
  ; activity = []
  }
;;

let parse_head workspace bytes =
  let head =
    Json.parse bytes |> Disk.unwrap |> History_storage.Head.of_json |> Disk.unwrap
  in
  if not (Id.Workspace.equal workspace (History_storage.Head.workspace head))
  then Json.fail Corrupt_store "history HEAD workspace mismatch";
  History_storage.Head.sequence head, History_storage.Head.digest head
;;

let batch_name digest = "history/batches/" ^ digest ^ ".json"

let recover t ~sequence ~head =
  let rec collect sequence head batches bytes_seen =
    if sequence = 0
    then (
      if Option.is_some head
      then Json.fail Corrupt_store "history chain extends below zero";
      batches, bytes_seen)
    else (
      match head with
      | None -> Json.fail Corrupt_store "history chain interrupted"
      | Some digest ->
        check_digest digest;
        let name = batch_name digest in
        let bytes = Disk.read_with_limit (path t name) ~max_bytes:(4 * 1024 * 1024) in
        if not (String.equal digest (Json.hash bytes))
        then Json.fail Corrupt_store "history batch hash mismatch";
        let json =
          Json.parse bytes
          |> Disk.unwrap
          |> History_storage.Batch.of_json
          |> Disk.unwrap
          |> History_storage.Batch.to_json
        in
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
        if Json.integer (Json.field json "version") <> 1
        then Json.fail Unsupported_version "unsupported history batch version";
        if
          Json.integer (Json.field json "sequence") <> sequence
          || not
               (Id.Workspace.equal
                  t.workspace
                  (Id.Workspace.t_of_jsonaf (Json.field json "workspace_id")))
        then Json.fail Corrupt_store "history chain identity mismatch";
        let previous =
          match Json.field json "previous" with
          | `Null -> None
          | value -> Some (Json.text value)
        in
        let bytes_seen = bytes_seen + String.length bytes in
        if bytes_seen > 64 * 1024 * 1024
        then Json.fail Corrupt_store "history metadata exceeds 64MiB";
        collect (sequence - 1) previous ((digest, bytes, json) :: batches) bytes_seen)
  in
  let batches, bytes_seen = collect sequence head [] 0 in
  let capture, receipts =
    List.fold
      batches
      ~init:(empty t.workspace, String.Map.empty)
      ~f:(fun (capture, receipts) (digest, bytes, json) ->
        let key = Json.text (Json.field json "key") in
        let request_hash = Json.text (Json.field json "request_hash") in
        validate_receipt ~key ~request_hash;
        if Map.mem receipts key then Json.fail Corrupt_store "duplicate history receipt";
        let response = Json.field json "response" in
        (match Json.field response "durable" with
         | `True -> ()
         | _ -> Json.fail Corrupt_store "history response is not durable");
        let capture = apply capture (Json.field json "change") in
        validate_response capture ~change:(Json.field json "change") ~response;
        let capture =
          audit
            capture
            ~change:(Json.field json "change")
            ~key
            ~sequence:(capture.sequence + 1)
            ~digest
        in
        let capture =
          { capture with
            head = Some digest
          ; sequence = capture.sequence + 1
          ; files =
              add_files capture.files [ batch_name digest, digest, String.length bytes ]
          }
        in
        capture, Map.add_exn receipts ~key ~data:(request_hash, response))
  in
  List.iter (Map.data capture.sessions) ~f:(fun state ->
    List.iter state.events ~f:(fun event ->
      List.iter (Session_event.blob_references event) ~f:(verify_blob t);
      Option.iter (Session_event.searchable_text event) ~f:(fun ref_ ->
        History_text.validate (path t ("blobs/" ^ ref_.digest)) |> Disk.unwrap)));
  capture, receipts, bytes_seen
;;

let open_existing ~fs ~root ~workspace =
  Disk.protect (fun () ->
    Disk.absolute root;
    let t =
      { fs
      ; root
      ; workspace
      ; current = empty workspace
      ; receipts = String.Map.empty
      ; retained_bytes = 0
      ; head_bytes = None
      ; fenced = false
      }
    in
    let history = path t "history" in
    require_directories t;
    (match Eio.Path.kind ~follow:false history with
     | `Not_found -> ()
     | `Directory ->
       (match Eio.Path.kind ~follow:false (path t "history/HEAD.json") with
        | `Not_found -> ()
        | `Regular_file ->
          let head_bytes = Disk.read (path t "history/HEAD.json") in
          let sequence, head = parse_head workspace head_bytes in
          t.head_bytes <- Some head_bytes;
          let capture, receipts, retained_bytes = recover t ~sequence ~head in
          t.current <- capture;
          t.receipts <- receipts;
          t.retained_bytes <- retained_bytes
        | _ -> Json.fail Corrupt_store "history HEAD must be regular file")
     | _ -> Json.fail Corrupt_store "history must be real directory");
    t)
;;

let last_committed_head t = Capture.head t.current

let capture t =
  Disk.protect (fun () ->
    require_open t;
    t.current)
;;

let capture_at t ~head =
  Disk.protect (fun () ->
    require_open t;
    match head with
    | None -> empty t.workspace
    | Some digest ->
      if
        not
          (List.exists t.current.files ~f:(fun (name, _, _) ->
             String.equal name (batch_name digest)))
      then Json.fail Conflict "history capture head is not an ancestor";
      let json = Json.parse (Disk.read (path t (batch_name digest))) |> Disk.unwrap in
      let sequence = Json.integer (Json.field json "sequence") in
      let capture, _, _ = recover t ~sequence ~head in
      capture)
;;

let get t ~session =
  Disk.protect (fun () ->
    require_open t;
    (get_exn t session).metadata)
;;

let install_content t = function
  | Session_event.Content.Blob ref_ ->
    verify_blob t ref_;
    ref_
  | Session_event.Content.Inline bytes ->
    let digest = Json.hash bytes in
    let ref_ =
      Session_event.Blob_ref.create ~digest ~size_bytes:(String.length bytes)
      |> Disk.unwrap
    in
    let destination = path t ("blobs/" ^ digest) in
    (match Eio.Path.kind ~follow:false destination with
     | `Not_found -> Disk.write_new destination bytes
     | `Regular_file -> verify_blob t ref_
     | _ -> Json.fail Corrupt_store "history blob destination is unsafe");
    ref_
;;

let commit t ~key ~request_hash ~change ~response =
  require_open t;
  let sequence = t.current.sequence + 1 in
  if sequence > 1_000_000
  then Json.fail Blocked "history capacity exhausted (1000000 commits); nothing deleted";
  let candidate = apply t.current change in
  validate_response candidate ~change ~response;
  let json =
    History_storage.Batch.create
      ~workspace:t.workspace
      ~sequence
      ~previous:t.current.head
      ~key
      ~request_hash
      ~change
      ~response
    |> Disk.unwrap
    |> History_storage.Batch.to_json
  in
  let bytes = Json.canonical json in
  if
    String.length bytes > 4 * 1024 * 1024
    || t.retained_bytes + String.length bytes > 64 * 1024 * 1024
  then Json.fail Blocked "history metadata capacity exhausted; nothing deleted";
  let digest = Json.hash bytes in
  let candidate = audit candidate ~change ~key ~sequence ~digest in
  let candidate =
    { candidate with
      head = Some digest
    ; sequence
    ; files = add_files candidate.files [ batch_name digest, digest, String.length bytes ]
    }
  in
  t.fenced <- true;
  Disk.ensure_directory (path t "history");
  Disk.ensure_directory (path t "history/batches");
  let batch = path t (batch_name digest) in
  (match Eio.Path.kind ~follow:false batch with
   | `Not_found -> Disk.write_new batch bytes
   | `Regular_file ->
     if not (String.equal bytes (Disk.read batch))
     then Json.fail Corrupt_store "orphan history batch differs"
   | _ -> Json.fail Corrupt_store "history batch path unsafe");
  Disk.replace (path t "history/HEAD.json") (Capture.head_bytes candidate);
  t.head_bytes <- Some (Capture.head_bytes candidate);
  t.current <- candidate;
  t.receipts <- Map.add_exn t.receipts ~key ~data:(request_hash, response);
  t.retained_bytes <- t.retained_bytes + String.length bytes;
  t.fenced <- false;
  response
;;

let response fields = Json.obj (("durable", `True) :: fields)

let create t metadata ~key ~request_hash =
  Disk.protect (fun () ->
    match Disk.unwrap (lookup_receipt t ~key ~request_hash) with
    | Some response -> response
    | None ->
      if not (Id.Workspace.equal t.workspace (Session.workspace metadata))
      then Json.fail Invalid_argument "session workspace mismatch";
      if Map.mem t.current.sessions (Session.id metadata)
      then Json.fail Conflict "session ID already exists";
      Option.iter (Session.parent metadata) ~f:(fun ref_ ->
        ignore (Disk.unwrap (Capture.event t.current ref_) : Session_event.t));
      commit
        t
        ~key
        ~request_hash
        ~change:
          (Json.obj [ "kind", Json.string "create"; "session", Session.to_json metadata ])
        ~response:
          (response [ "session", Session.to_json metadata; "through", Json.int 0 ]))
;;

let archive t ~session ~key ~request_hash =
  Disk.protect (fun () ->
    match Disk.unwrap (lookup_receipt t ~key ~request_hash) with
    | Some response -> response
    | None ->
      let metadata = Session.archive (get_exn t session).metadata in
      commit
        t
        ~key
        ~request_hash
        ~change:
          (Json.obj
             [ "kind", Json.string "archive"
             ; "session_id", Session_id.jsonaf_of_t session
             ])
        ~response:(response [ "session", Session.to_json metadata ]))
;;

let append t ~session ~actor ?run ~inputs ~key ~request_hash () =
  Disk.protect (fun () ->
    match Disk.unwrap (lookup_receipt t ~key ~request_hash) with
    | Some response -> response
    | None ->
      if not (String.is_prefix key ~prefix:(Id.Actor.to_string actor ^ ":"))
      then Json.fail Invalid_argument "history key must be actor scoped";
      let state = get_exn t session in
      if Session.archived state.metadata then Json.fail Conflict "session archived";
      if List.is_empty inputs || List.length inputs > 128
      then Json.fail Invalid_argument "append requires 1..128 events";
      let inline_bytes =
        List.sum
          (module Int)
          inputs
          ~f:(fun input ->
            List.sum
              (module Int)
              (Session_event.Input.contents input)
              ~f:(function
                | Session_event.Content.Inline bytes -> String.length bytes
                | Session_event.Content.Blob _ -> 0))
      in
      if inline_bytes > 16 * 1024 * 1024
      then Json.fail Invalid_argument "append inline bytes exceed 16MiB";
      let seen = ref state.by_client in
      let upper_bound = ref state.upper_bound in
      let pending = ref [] in
      (* Validate all conflicts and references before any IO. *)
      List.iter inputs ~f:(fun input ->
        let id = Session_event.Input.client_id input in
        match Map.find !seen id with
        | Some event ->
          if
            not
              (String.equal
                 (Session_event.identity_hash event)
                 (Session_event.Input.identity_hash input))
          then
            Json.fail Idempotency_conflict "client event ID reused with changed content"
        | None ->
          incr upper_bound;
          let ref_ =
            Session.Event_ref.create ~session ~sequence:!upper_bound |> Disk.unwrap
          in
          let preview =
            Session_event.commit input ~ref_ ~actor ~run ~install:(function
              | Session_event.Content.Inline bytes ->
                Session_event.Blob_ref.create
                  ~digest:(Json.hash bytes)
                  ~size_bytes:(String.length bytes)
                |> Disk.unwrap
              | Session_event.Content.Blob ref_ -> ref_)
          in
          seen := Map.add_exn !seen ~key:id ~data:preview;
          pending := (input, ref_) :: !pending);
      let events =
        List.rev_map !pending ~f:(fun (input, ref_) ->
          List.iter
            (Session_event.attachments
               (Map.find_exn !seen (Session_event.Input.client_id input)))
            ~f:(verify_blob t);
          let event =
            Session_event.commit input ~ref_ ~actor ~run ~install:(install_content t)
          in
          Option.iter (Session_event.searchable_text event) ~f:(fun ref_ ->
            History_text.validate (path t ("blobs/" ^ ref_.digest)) |> Disk.unwrap);
          event)
      in
      let refs =
        List.map inputs ~f:(fun input ->
          Session_event.ref_ (Map.find_exn !seen (Session_event.Input.client_id input))
          |> Session.Event_ref.to_json)
      in
      commit
        t
        ~key
        ~request_hash
        ~change:
          (Json.obj
             [ "kind", Json.string "append"
             ; "session_id", Session_id.jsonaf_of_t session
             ; "actor", Id.Actor.jsonaf_of_t actor
             ; "run", Option.value_map run ~default:`Null ~f:Id.Run.jsonaf_of_t
             ; "events", `Array (List.map events ~f:Session_event.to_json)
             ])
        ~response:
          (response
             [ "session_id", Session_id.jsonaf_of_t session
             ; "through", Json.int !upper_bound
             ; "events", `Array refs
             ]))
;;

let read_blob_range t ref_ ~offset ~length =
  Disk.protect (fun () ->
    require_open t;
    verify_blob t ref_;
    Blob.read_range
      (path t ("blobs/" ^ ref_.Session_event.Blob_ref.digest))
      ~offset
      ~length
    |> Disk.unwrap)
;;

let read_capture_blob capture ~fs ~root ref_ ~offset ~length =
  Disk.protect (fun () ->
    if
      not
        (List.exists capture.Capture.files ~f:(fun (name, digest, size) ->
           String.equal name ("blobs/" ^ ref_.Session_event.Blob_ref.digest)
           && String.equal digest ref_.digest
           && size = ref_.size_bytes))
    then Json.fail Not_found "blob is outside immutable history capture";
    let path = Eio.Path.(fs / root / "blobs" / ref_.digest) in
    let digest, size = Blob.inspect path |> Disk.unwrap in
    if (not (String.equal digest ref_.digest)) || size <> ref_.size_bytes
    then Json.fail Corrupt_store "capture blob digest mismatch";
    Blob.read_range path ~offset ~length |> Disk.unwrap)
;;
