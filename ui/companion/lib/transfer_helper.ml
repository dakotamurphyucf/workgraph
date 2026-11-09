open Core
open Workgraph

module Stage = struct
  module Id = Workgraph.Id.Resource

  type status =
    | Incoming
    | Sealed
    | Abandoned

  type source =
    | Retained
    | Cleaned

  type t =
    { id : Id.t
    ; digest : string
    ; size_bytes : int
    ; received : int
    ; status : status
    ; source : source
    ; job : Operation.Id.t option
    ; diagnostic : Problem.t option
    }

  let status_name = function
    | Incoming -> "incoming"
    | Sealed -> "sealed"
    | Abandoned -> "abandoned"
  ;;

  let to_json t =
    Json.obj
      [ "stage_id", Id.jsonaf_of_t t.id
      ; "digest", Json.string t.digest
      ; "size_bytes", Json.int t.size_bytes
      ; "received", Json.int t.received
      ; "status", Json.string (status_name t.status)
      ; ( "source_retained"
        , match t.source with
          | Retained -> `True
          | Cleaned -> `False )
      ; "intention_id", Option.value_map t.job ~default:`Null ~f:Operation.Id.jsonaf_of_t
      ; "diagnostic", Option.value_map t.diagnostic ~default:`Null ~f:Problem.to_json
      ]
  ;;

  let of_json value =
    Json.decode (fun () ->
      Json.fields
        value
        ~allowed:
          [ "stage_id"
          ; "digest"
          ; "size_bytes"
          ; "received"
          ; "status"
          ; "source_retained"
          ; "intention_id"
          ; "diagnostic"
          ];
      let get name = Json.field value name in
      let id = Id.t_of_jsonaf (get "stage_id") in
      let digest = Api_codec.decode Resource_wire.digest (get "digest") |> Disk.unwrap in
      let size_bytes = Json.integer (get "size_bytes") in
      let received = Json.integer (get "received") in
      if size_bytes > Resource.max_blob_bytes || received > size_bytes
      then Json.fail Corrupt_store "invalid staged resource byte counts";
      let status =
        match Json.text (get "status") with
        | "incoming" -> Incoming
        | "sealed" -> Sealed
        | "abandoned" -> Abandoned
        | _ -> Json.fail Corrupt_store "invalid staged resource status"
      in
      let source =
        match get "source_retained" with
        | `True -> Retained
        | `False -> Cleaned
        | _ -> Json.fail Corrupt_store "invalid staged source retention"
      in
      let job =
        match get "intention_id" with
        | `Null -> None
        | v -> Some (Operation.Id.t_of_jsonaf v)
      in
      let diagnostic =
        match get "diagnostic" with
        | `Null -> None
        | v -> Some (Problem_wire.of_json v |> Disk.unwrap)
      in
      (match status, source, job with
       | Incoming, Retained, None
       | Abandoned, _, None
       | Sealed, Retained, _
       | Sealed, Cleaned, Some _ -> ()
       | _ -> Json.fail Corrupt_store "incoherent resource staging ownership");
      (match status with
       | Sealed when received <> size_bytes ->
         Json.fail Corrupt_store "sealed source is incomplete"
       | Incoming | Sealed | Abandoned -> ());
      { id; digest; size_bytes; received; status; source; job; diagnostic })
  ;;
end

module Plan = struct
  type t =
    { intention : Operation.Id.t
    ; connection : Connection_profile.t
    ; context : Operation.Context.t
    ; stage : Stage.Id.t
    ; params : Jsonaf.t
    }

  let validate_params context params =
    Json.fields
      params
      ~allowed:
        [ "workspace_id"
        ; "actor_id"
        ; "run_id"
        ; "mutation_id"
        ; "resource_id"
        ; "expected_revision"
        ; "title"
        ; "filename"
        ; "mime_type"
        ; "ticket_id"
        ];
    let get name = Json.field params name in
    let workspace = Id.Workspace.t_of_jsonaf (get "workspace_id") in
    let actor = Id.Actor.t_of_jsonaf (get "actor_id") in
    let run = Option.map (Json.optional params "run_id") ~f:Id.Run.t_of_jsonaf in
    let writer = Operation.Context.writer context in
    if
      not
        (Option.equal
           Id.Workspace.equal
           (Operation.Context.workspace context)
           (Some workspace)
         && Id.Actor.equal (Writer.actor writer) actor
         && Option.equal Id.Run.equal (Writer.run writer) run)
    then Json.fail Invalid_argument "upload input differs from captured writer/workspace";
    ignore (Id.Resource.t_of_jsonaf (get "resource_id") : Id.Resource.t);
    ignore (Json.integer (get "expected_revision") : int);
    Option.iter (Json.optional params "mutation_id") ~f:(fun value ->
      ignore (Id.Mutation.t_of_jsonaf value : Id.Mutation.t));
    Option.iter (Json.optional params "ticket_id") ~f:(fun value ->
      ignore (Id.Ticket.t_of_jsonaf value : Id.Ticket.t));
    Resource.validate_metadata
      { title = Json.text (get "title")
      ; filename = Json.text (get "filename")
      ; mime_type = Json.text (get "mime_type")
      ; description = ""
      ; targets = []
      ; archived = false
      }
  ;;

  let create ~intention_id ~connection ~context ~stage_id ~params =
    Json.decode (fun () ->
      validate_params context params;
      if String.length (Json.canonical params) > 8192
      then Json.fail Invalid_argument "upload input exceeds 8KiB";
      { intention = intention_id; connection; context; stage = stage_id; params })
  ;;

  let to_json t =
    Json.obj
      [ "format", Json.string "workgraph-ui-resource-upload-plan-1"
      ; "intention_id", Operation.Id.jsonaf_of_t t.intention
      ; "connection", Connection_profile.to_json t.connection
      ; "context", Operation.Context.to_json t.context
      ; "stage_id", Stage.Id.jsonaf_of_t t.stage
      ; "params", t.params
      ]
  ;;

  let of_json value =
    Json.decode (fun () ->
      Json.fields
        value
        ~allowed:
          [ "format"; "intention_id"; "connection"; "context"; "stage_id"; "params" ];
      if
        not
          (String.equal
             (Json.text (Json.field value "format"))
             "workgraph-ui-resource-upload-plan-1")
      then Json.fail Unsupported_version "unsupported resource upload plan format";
      create
        ~intention_id:(Operation.Id.t_of_jsonaf (Json.field value "intention_id"))
        ~connection:
          (Connection_profile.of_json (Json.field value "connection") |> Disk.unwrap)
        ~context:(Operation.Context.of_json (Json.field value "context") |> Disk.unwrap)
        ~stage_id:(Stage.Id.t_of_jsonaf (Json.field value "stage_id"))
        ~params:(Json.field value "params")
      |> Disk.unwrap)
  ;;
end

module Job = struct
  type link =
    | Not_requested
    | Pending of Problem.t option
    | Committed of Api_response.t

  type published =
    { publication : Api_response.t
    ; link : link
    }

  type phase =
    | Saving_local
    | Prepared_unsent
    | Running of published option
    | Rejected of Problem.t
    | Outcome_unknown of Problem.t
    | Published of published

  type t =
    { plan : Plan.t
    ; native : Transfer.Upload_plan.t
    ; request : Protocol.Request.t
    ; journal : string
    ; input_hash : string
    ; revision : int
    ; phase : phase
    ; diagnostic : Problem.t option
    }

  let rec phase_json = function
    | Saving_local -> Json.obj [ "kind", Json.string "local_save_incomplete" ]
    | Prepared_unsent -> Json.obj [ "kind", Json.string "prepared_unsent" ]
    | Running known ->
      Json.obj
        [ "kind", Json.string "running"
        ; ( "previous"
          , Option.value_map known ~default:`Null ~f:(fun value ->
              phase_json (Published value)) )
        ]
    | Rejected error ->
      Json.obj [ "kind", Json.string "rejected"; "problem", Problem.to_json error ]
    | Outcome_unknown error ->
      Json.obj [ "kind", Json.string "outcome_unknown"; "problem", Problem.to_json error ]
    | Published { publication; link } ->
      let link =
        match link with
        | Not_requested -> Json.obj [ "kind", Json.string "not_requested" ]
        | Pending error ->
          Json.obj
            [ "kind", Json.string "unresolved"
            ; "problem", Option.value_map error ~default:`Null ~f:Problem.to_json
            ]
        | Committed response ->
          Json.obj
            [ "kind", Json.string "committed"; "response", Api_response.to_json response ]
      in
      Json.obj
        [ "kind", Json.string "published"
        ; "publication", Api_response.to_json publication
        ; "link", link
        ]
  ;;

  let to_json t =
    Json.obj
      [ "format", Json.string "workgraph-ui-resource-upload-job-1"
      ; "intention_id", Operation.Id.jsonaf_of_t t.plan.intention
      ; "plan", Plan.to_json t.plan
      ; "native_plan", Transfer.Upload_plan.params t.native
      ; "saved_request", Protocol.Request.to_json t.request
      ; "journal_path", Json.string t.journal
      ; "input_hash", Json.string t.input_hash
      ; "revision", Json.int t.revision
      ; "phase", phase_json t.phase
      ; "diagnostic", Option.value_map t.diagnostic ~default:`Null ~f:Problem.to_json
      ]
  ;;
end

let json_equal a b = String.equal (Json.canonical a) (Json.canonical b)

let null_option value f =
  match value with
  | `Null -> None
  | value -> Some (f value)
;;

let source_name id = Stage.Id.to_string id ^ ".part"
let manifest = "resource-transfer-1.json"
let source_directory root = Eio.Path.(State_root.directory root / "resource-inputs")
let source_path root id = Eio.Path.(source_directory root / source_name id)

let source_filename root id =
  Filename.concat
    (Filename.concat (State_root.path root) "resource-inputs")
    (source_name id)
;;

let input_hash plan stage =
  Json.hash
    (Json.canonical
       (Json.obj
          [ "plan", Plan.to_json plan
          ; "digest", Json.string stage.Stage.digest
          ; "size_bytes", Json.int stage.size_bytes
          ]))
;;

let finish_publication native response =
  let open Result.Let_syntax in
  let finish = Transfer.Upload_plan.finish_request native in
  let%bind _ = Acknowledgement.validate finish ~response in
  let%map _ = Transfer.Upload_plan.link_request native ~publication:response in
  response
;;

let rec decode_phase native value =
  let phase = Json.text (Json.field value "kind") in
  let fields names = Json.fields value ~allowed:("kind" :: names) in
  let problem () = Problem_wire.of_json (Json.field value "problem") |> Disk.unwrap in
  match phase with
  | "local_save_incomplete" ->
    fields [];
    Job.Saving_local
  | "prepared_unsent" ->
    fields [];
    Prepared_unsent
  | "running" ->
    fields [ "previous" ];
    let previous = Json.field value "previous" in
    Running
      (match previous with
       | `Null -> None
       | value ->
         (match Json.text (Json.field value "kind") with
          | "published" ->
            (match decode_phase native value with
             | Published value -> Some value
             | _ -> assert false)
          | _ -> Json.fail Corrupt_store "running previous must be a known publication"))
  | "rejected" ->
    fields [ "problem" ];
    Rejected (problem ())
  | "outcome_unknown" ->
    fields [ "problem" ];
    Outcome_unknown (problem ())
  | "published" ->
    fields [ "publication"; "link" ];
    let publication =
      Api_response.of_json (Json.field value "publication")
      |> Disk.unwrap
      |> fun response -> finish_publication native response |> Disk.unwrap
    in
    let request = Transfer.Upload_plan.link_request native ~publication |> Disk.unwrap in
    let link = Json.field value "link" in
    let link =
      match Json.text (Json.field link "kind"), request with
      | "not_requested", None ->
        Json.fields link ~allowed:[ "kind" ];
        Job.Not_requested
      | "unresolved", Some _ ->
        Json.fields link ~allowed:[ "kind"; "problem" ];
        Pending
          (null_option (Json.field link "problem") (fun value ->
             Problem_wire.of_json value |> Disk.unwrap))
      | "committed", Some request ->
        Json.fields link ~allowed:[ "kind"; "response" ];
        let response = Api_response.of_json (Json.field link "response") |> Disk.unwrap in
        ignore
          (Acknowledgement.validate request ~response |> Disk.unwrap : Acknowledgement.t);
        Committed response
      | _ ->
        Json.fail
          Corrupt_store
          "saved publication/link state differs from native upload plan"
    in
    Published { publication; link }
  | _ -> Json.fail Corrupt_store "unknown resource upload phase"
;;

let job_of_json root (stages : Stage.t Stage.Id.Map.t) value =
  Json.decode (fun () ->
    Json.fields
      value
      ~allowed:
        [ "format"
        ; "intention_id"
        ; "plan"
        ; "native_plan"
        ; "saved_request"
        ; "journal_path"
        ; "input_hash"
        ; "revision"
        ; "phase"
        ; "diagnostic"
        ];
    let get key = Json.field value key in
    if not (String.equal (Json.text (get "format")) "workgraph-ui-resource-upload-job-1")
    then Json.fail Unsupported_version "unsupported resource upload job format";
    let plan = Plan.of_json (get "plan") |> Disk.unwrap in
    if
      not
        (Operation.Id.equal
           plan.intention
           (Operation.Id.t_of_jsonaf (get "intention_id")))
    then Json.fail Corrupt_store "resource intention identity differs";
    let stage =
      match Map.find stages plan.stage with
      | Some stage -> stage
      | None -> Json.fail Corrupt_store "saved upload source descriptor is missing"
    in
    if not (Option.equal Operation.Id.equal stage.job (Some plan.intention))
    then Json.fail Corrupt_store "saved upload stage owner differs";
    let native =
      Transfer.Upload_plan.prepare
        ~fs:(State_root.directory root)
        ~params:(get "native_plan")
      |> Disk.unwrap
    in
    let native_params = Transfer.Upload_plan.params native in
    let original =
      match plan.params with
      | `Object fields -> fields
      | _ -> assert false
    in
    List.iter original ~f:(fun (name, value) ->
      if not (json_equal value (Json.field native_params name))
      then Json.fail Corrupt_store "saved native upload differs from original capture");
    if
      not
        (String.equal (Json.text (Json.field native_params "digest")) stage.digest
         && Int.equal
              (Json.integer (Json.field native_params "size_bytes"))
              stage.size_bytes
         && String.equal
              (Json.text (Json.field native_params "file"))
              (source_filename root stage.id))
    then Json.fail Corrupt_store "saved native upload differs from private sealed source";
    let request = Protocol.Request.of_json (get "saved_request") |> Disk.unwrap in
    if
      not
        (String.equal (Protocol.Request.method_ request) "resource.upload"
         && json_equal (Protocol.Request.params request) native_params)
    then Json.fail Corrupt_store "saved native request differs from frozen upload plan";
    let journal =
      Request_journal.path request ~directory:(State_root.journal_directory root)
      |> Disk.unwrap
    in
    if not (String.equal journal (Json.text (get "journal_path")))
    then Json.fail Corrupt_store "saved upload journal path differs";
    let hash = input_hash plan stage in
    if not (String.equal hash (Json.text (get "input_hash")))
    then Json.fail Corrupt_store "saved upload full input hash differs";
    let revision = Json.integer (get "revision") in
    if revision < 1 then Json.fail Corrupt_store "saved upload revision must be positive";
    { Job.plan
    ; native
    ; request
    ; journal
    ; input_hash = hash
    ; revision
    ; phase = decode_phase native (get "phase")
    ; diagnostic =
        null_option (get "diagnostic") (fun v -> Problem_wire.of_json v |> Disk.unwrap)
    })
;;

type flight_kind =
  | Start
  | Retry
  | Recover
[@@deriving equal]

type flight =
  { id : Operation.Id.t
  ; kind : flight_kind
  ; admission : (unit, Problem.t) Result.t Eio.Promise.t
  ; finished : unit Eio.Promise.t
  }

type t =
  { sw : Eio.Switch.t
  ; env : Eio_unix.Stdenv.base
  ; root : State_root.t
  ; client : Connection_profile.t -> (Client.t, Problem.t) Result.t
  ; mutex : Eio.Mutex.t
  ; mutable stages : Stage.t Stage.Id.Map.t
  ; mutable jobs : Job.t Operation.Id.Map.t
  ; mutable dirty : bool
  ; mutable flight : flight option
  }

let snapshot t =
  Json.obj
    [ "format", Json.string "workgraph-ui-resource-transfers-1"
    ; "stages", `Array (Map.data t.stages |> List.map ~f:Stage.to_json)
    ; "jobs", `Array (Map.data t.jobs |> List.map ~f:Job.to_json)
    ]
;;

let synchronize t =
  t.dirty <- true;
  match State_root.save t.root ~name:manifest ~value:(snapshot t) with
  | Ok () -> t.dirty <- false
  | Error error -> raise (Json.Decode_error error)
;;

let ensure_synced t = if t.dirty then synchronize t
let locked t f = Eio.Mutex.use_rw ~protect:true t.mutex (fun () -> Disk.protect f)

let stage t id =
  match Map.find t.stages id with
  | Some value -> value
  | None -> Json.fail Not_found "staged input not found"
;;

let job t id =
  match Map.find t.jobs id with
  | Some value -> value
  | None -> Json.fail Not_found "upload intention not found"
;;

let set_stage t stage = t.stages <- Map.set t.stages ~key:stage.Stage.id ~data:stage
let set_job t job = t.jobs <- Map.set t.jobs ~key:job.Job.plan.intention ~data:job

let next_job value phase diagnostic =
  { value with Job.phase; diagnostic; revision = value.Job.revision + 1 }
;;

let private_source t id = source_path t.root id

let local t id f =
  Local_file.protect ~operation:"resource staging" ~path:(source_filename t.root id) f
  |> Disk.unwrap
;;

let retained_bytes t =
  Map.fold t.stages ~init:0 ~f:(fun ~key:_ ~data sum ->
    match data.Stage.source with
    | Retained -> sum + data.size_bytes
    | Cleaned -> sum)
;;

let incoming_count t =
  Map.count t.stages ~f:(fun stage ->
    Option.is_none stage.Stage.job
    &&
    match stage.status with
    | Incoming | Sealed -> true
    | Abandoned -> false)
;;

let source_file t stage =
  let path = private_source t stage.Stage.id in
  match Eio.Path.kind ~follow:false path with
  | `Regular_file -> path
  | _ ->
    Json.fail
      Local_io
      "private staged source is unavailable or nonregular; exact receipts remain \
       recoverable"
;;

let load_store ~sw ~env ~root ~client =
  Disk.protect (fun () ->
    let directory = source_directory root in
    Disk.ensure_directory directory;
    let stat = Eio.Path.stat ~follow:false directory in
    (match stat.kind with
     | `Directory when stat.perm land 0o077 = 0 -> ()
     | _ -> Json.fail Invalid_argument "resource staging directory must be private");
    let t =
      { sw
      ; env
      ; root
      ; client
      ; mutex = Eio.Mutex.create ()
      ; stages = Stage.Id.Map.empty
      ; jobs = Operation.Id.Map.empty
      ; dirty = false
      ; flight = None
      }
    in
    (match State_root.read root ~name:manifest |> Disk.unwrap with
     | None -> ()
     | Some value ->
       Json.fields value ~allowed:[ "format"; "stages"; "jobs" ];
       if
         not
           (String.equal
              (Json.text (Json.field value "format"))
              "workgraph-ui-resource-transfers-1")
       then Json.fail Unsupported_version "unsupported resource transfers format";
       let stages = Json.list (Json.field value "stages") in
       if List.length stages > 1000
       then Json.fail Corrupt_store "staged resource retention exceeds1000";
       List.iter stages ~f:(fun value ->
         let value = Stage.of_json value |> Disk.unwrap in
         if Map.mem t.stages value.id
         then Json.fail Corrupt_store "duplicate staged input identity";
         set_stage t value);
       let jobs = Json.list (Json.field value "jobs") in
       if List.length jobs > 100
       then Json.fail Corrupt_store "resource intention retention exceeds100";
       List.iter jobs ~f:(fun value ->
         let value = job_of_json root t.stages value |> Disk.unwrap in
         if Map.mem t.jobs value.plan.intention
         then Json.fail Corrupt_store "duplicate resource intention identity";
         set_job t value);
       Map.iter t.stages ~f:(fun stage ->
         Option.iter stage.job ~f:(fun id ->
           match Map.find t.jobs id with
           | Some job when Stage.Id.equal job.plan.stage stage.id -> ()
           | _ -> Json.fail Corrupt_store "resource stage/job mapping differs")));
    Map.iter t.stages ~f:(fun source ->
      match source.Stage.source, source.job with
      | Cleaned, Some id ->
        (match (job t id).Job.phase with
         | Published _ | Running (Some _) -> ()
         | Saving_local | Prepared_unsent | Running None | Rejected _ | Outcome_unknown _
           ->
           Json.fail
             Corrupt_store
             "source was cleaned without a retained verified publication")
      | Retained, _ | Cleaned, None -> ());
    if retained_bytes t > 134217728 || incoming_count t > 2
    then Json.fail Corrupt_store "retained resource sources exceed capacity";
    Map.iteri t.jobs ~f:(fun ~key:_ ~data ->
      match data.Job.phase with
      | Running previous ->
        let error =
          Problem.create
            Outcome_unknown
            "companion restarted after upload admission; inspect exact receipts before \
             explicit retry"
        in
        let phase =
          match previous with
          | None -> Job.Outcome_unknown error
          | Some previous -> Published { previous with link = Pending (Some error) }
        in
        set_job t (next_job data phase None);
        t.dirty <- true
      | Saving_local | Prepared_unsent | Rejected _ | Outcome_unknown _ | Published _ ->
        ());
    ensure_synced t;
    t)
;;

let begin_stage t ~id ~digest ~size_bytes =
  locked t (fun () ->
    ensure_synced t;
    ignore
      (Api_codec.decode Resource_wire.digest (Json.string digest) |> Disk.unwrap : string);
    if size_bytes < 0 || size_bytes > Resource.max_blob_bytes
    then Json.fail Invalid_argument "resource stage size must be0..64MiB";
    let stage =
      match Map.find t.stages id with
      | Some value ->
        if not (String.equal value.digest digest && Int.equal value.size_bytes size_bytes)
        then
          Json.fail
            Idempotency_conflict
            "stage identity reused with different complete bytes";
        (match value.status, value.job with
         | Abandoned, _ -> Json.fail Conflict "abandoned stage identity cannot be reused"
         | _, Some _ -> Json.fail Conflict "stage is retained by an upload intention"
         | (Incoming | Sealed), None -> ());
        value
      | None ->
        if
          Map.length t.stages >= 1000
          || incoming_count t >= 2
          || retained_bytes t + size_bytes > 134217728
        then
          Json.fail
            Conflict
            "resource staging capacity is full; inspect retained sources and clean only \
             known unprepared inputs";
        if
          not
            (match Eio.Path.kind ~follow:false (private_source t id) with
             | `Not_found -> true
             | _ -> false)
        then
          Json.fail
            Conflict
            "private staged source already exists without this descriptor";
        let value =
          { Stage.id
          ; digest
          ; size_bytes
          ; received = 0
          ; status = Incoming
          ; source = Retained
          ; job = None
          ; diagnostic = None
          }
        in
        set_stage t value;
        synchronize t;
        value
    in
    local t id (fun () ->
      match Eio.Path.kind ~follow:false (private_source t id) with
      | `Not_found when stage.received = 0 -> Disk.write_new (private_source t id) ""
      | `Regular_file -> ()
      | _ -> Json.fail Local_io "staged input source is missing or nonregular");
    stage)
;;

let inspect_stage t ~id =
  locked t (fun () ->
    ensure_synced t;
    stage t id)
;;

let list_stages t ~offset ~limit =
  locked t (fun () ->
    ensure_synced t;
    if offset < 0 || limit < 1 || limit > 100
    then
      Json.fail Invalid_argument "stage page requires nonnegative offset and limit1..100";
    let rows = List.drop (Map.data t.stages) offset in
    let selected = List.take rows limit in
    let remaining = List.length rows - List.length selected in
    Json.obj
      [ "items", `Array (List.map selected ~f:Stage.to_json)
      ; "offset", Json.int offset
      ; "remaining", Json.int remaining
      ; ( "next_offset"
        , if remaining = 0 then `Null else Json.int (offset + List.length selected) )
      ; "retained_bytes", Json.int (retained_bytes t)
      ; "maximum_retained_bytes", Json.int 134217728
      ; "incoming_count", Json.int (incoming_count t)
      ])
;;

let append_stage t ~id ~byte_offset ~bytes =
  locked t (fun () ->
    ensure_synced t;
    let value = stage t id in
    (match value.status, value.source, value.job with
     | Incoming, Retained, None -> ()
     | _ -> Json.fail Conflict "only an unprepared incoming stage accepts bytes");
    let count = String.length bytes in
    if
      count < 1
      || count > Upload.max_chunk_bytes
      || byte_offset < 0
      || byte_offset > value.received
      || byte_offset > value.size_bytes - count
    then Json.fail Invalid_argument "stage chunk is gapped or outside byte bounds";
    local t id (fun () ->
      let path = source_file t value in
      let existing, total =
        Blob.read_range path ~offset:byte_offset ~length:count |> Disk.unwrap
      in
      if total > value.size_bytes || total < value.received
      then
        Json.fail Local_io "private staged source size differs from its retained prefix";
      if not (String.equal existing (String.prefix bytes (String.length existing)))
      then Json.fail Conflict "retried stage bytes differ from retained bytes";
      if String.length existing < count
      then
        Eio.Path.with_open_out path ~create:`Never (fun file ->
          Eio.File.pwrite_all
            file
            ~file_offset:(Optint.Int63.of_int byte_offset)
            [ Cstruct.of_string bytes ];
          Eio.File.sync file)
      else Eio.Path.with_open_out path ~create:`Never Eio.File.sync);
    let value =
      { value with
        received = Int.max value.received (byte_offset + count)
      ; diagnostic = None
      }
    in
    set_stage t value;
    synchronize t;
    value)
;;

let seal_stage t ~id =
  locked t (fun () ->
    ensure_synced t;
    let value = stage t id in
    (match value.status, value.source, value.job with
     | (Incoming | Sealed), Retained, None -> ()
     | _ -> Json.fail Conflict "only an unprepared retained input can be sealed");
    if value.received <> value.size_bytes
    then Json.fail Invalid_argument "staged file is incomplete";
    let digest, size =
      local t id (fun () ->
        let path = source_file t value in
        Eio.Domain_manager.run (Eio.Stdenv.domain_mgr t.env) (fun () ->
          Blob.inspect path |> Disk.unwrap))
    in
    if not (String.equal digest value.digest && Int.equal size value.size_bytes)
    then Json.fail Conflict "complete staged file SHA256/size differs from declared input";
    local t id (fun () ->
      Eio.Path.with_open_out (source_file t value) ~create:`Never Eio.File.sync);
    let value = { value with status = Sealed; diagnostic = None } in
    set_stage t value;
    synchronize t;
    value)
;;

let remove_source t value =
  let result =
    Local_file.protect
      ~operation:"clean resource staging"
      ~path:(source_filename t.root value.Stage.id)
      (fun () ->
         (match Eio.Path.kind ~follow:false (private_source t value.id) with
          | `Not_found -> ()
          | `Regular_file -> Eio.Path.unlink (private_source t value.id)
          | _ -> Json.fail Local_io "staged source cleanup refused nonregular file");
         Platform.sync_directory (source_directory t.root))
  in
  match result with
  | Ok () ->
    set_stage t { value with source = Cleaned; diagnostic = None };
    synchronize t
  | Error diagnostic ->
    set_stage t { value with diagnostic = Some diagnostic };
    synchronize t;
    raise (Json.Decode_error diagnostic)
;;

let abandon_stage t ~id =
  locked t (fun () ->
    ensure_synced t;
    let value = stage t id in
    if Option.is_some value.job
    then
      Json.fail
        Conflict
        "prepared upload source cannot be abandoned; preserve its saved identity";
    let value = { value with status = Abandoned } in
    set_stage t value;
    synchronize t;
    match value.source with
    | Retained -> remove_source t value
    | Cleaned -> ())
;;

let publish_prepared t value =
  match value.Job.phase with
  | Saving_local ->
    ignore
      (Request_journal.save
         value.request
         ~fs:(State_root.directory t.root)
         ~random:(Eio.Stdenv.secure_random t.env)
         ~destination:value.journal
       |> Disk.unwrap
       : Request_journal.Saved.t);
    let value = next_job value Prepared_unsent None in
    set_job t value;
    synchronize t;
    value
  | Prepared_unsent | Running _ | Rejected _ | Outcome_unknown _ | Published _ -> value
;;

let prepare t plan =
  locked t (fun () ->
    ensure_synced t;
    let source = stage t plan.Plan.stage in
    let hash = input_hash plan source in
    match Map.find t.jobs plan.intention with
    | Some value ->
      if
        not
          (String.equal value.input_hash hash
           && json_equal (Plan.to_json value.plan) (Plan.to_json plan))
      then
        Json.fail
          Idempotency_conflict
          "upload intention already has different complete input";
      publish_prepared t value
    | None ->
      if Map.length t.jobs >= 100
      then
        Json.fail
          Conflict
          "resource upload intention retention is full; preserve existing recovery \
           records";
      (match source.status, source.source, source.job with
       | Sealed, Retained, None -> ()
       | _ -> Json.fail Conflict "upload requires one unprepared sealed private source");
      let digest, size =
        local t source.id (fun () ->
          let path = source_file t source in
          Eio.Domain_manager.run (Eio.Stdenv.domain_mgr t.env) (fun () ->
            Blob.inspect path |> Disk.unwrap))
      in
      if not (String.equal digest source.digest && Int.equal size source.size_bytes)
      then Json.fail Conflict "sealed source changed before publication preparation";
      let request =
        Protocol.Request.create
          ~id:("ui-resource-upload-" ^ Operation.Id.to_string plan.intention)
          ~method_:"resource.upload"
          ~params:plan.params
        |> Disk.unwrap
      in
      (* Full plan/source equality was checked before missing identity generation. *)
      let request =
        Cli_mutation_identity.ensure
          request
          ~random:(Eio.Stdenv.secure_random t.env)
          ~allow_generate:true
        |> Disk.unwrap
      in
      let params =
        match Protocol.Request.params request with
        | `Object fields ->
          Json.obj (("file", Json.string (source_filename t.root source.id)) :: fields)
        | _ -> assert false
      in
      let fs = State_root.directory t.root in
      let native =
        local t source.id (fun () ->
          Eio.Domain_manager.run (Eio.Stdenv.domain_mgr t.env) (fun () ->
            Transfer.Upload_plan.prepare ~fs ~params |> Disk.unwrap))
      in
      let native_params = Transfer.Upload_plan.params native in
      if
        not
          (String.equal (Json.text (Json.field native_params "digest")) source.digest
           && Int.equal
                (Json.integer (Json.field native_params "size_bytes"))
                source.size_bytes)
      then Json.fail Conflict "native upload source changed during preparation";
      let request = Protocol.Request.with_params request native_params |> Disk.unwrap in
      let journal =
        Request_journal.path request ~directory:(State_root.journal_directory t.root)
        |> Disk.unwrap
      in
      let value =
        { Job.plan
        ; native
        ; request
        ; journal
        ; input_hash = hash
        ; revision = 1
        ; phase = Saving_local
        ; diagnostic = None
        }
      in
      (* Atomic mapping first, then exact journal, then prepared acknowledgment. An
       interrupted local save reuses this materialization; it never regenerates. *)
      set_stage t { source with job = Some plan.intention };
      set_job t value;
      synchronize t;
      publish_prepared t value)
;;

let prior_publication = function
  | Job.Published value | Running (Some value) -> Some value
  | Saving_local | Prepared_unsent | Running None | Rejected _ | Outcome_unknown _ -> None
;;

let cleanup_published t value =
  match value.Job.phase with
  | Published _ ->
    let source = stage t value.plan.stage in
    (match source.source with
     | Cleaned -> value
     | Retained ->
       (match Json.decode (fun () -> remove_source t source) with
        | Ok () -> value
        | Error diagnostic ->
          let value = next_job value value.phase (Some diagnostic) in
          set_job t value;
          synchronize t;
          value))
  | Saving_local | Prepared_unsent | Running _ | Rejected _ | Outcome_unknown _ -> value
;;

let create ~sw ~env ~root ~client =
  Result.bind (load_store ~sw ~env ~root ~client) ~f:(fun t ->
    (* Only durably loaded verified publications may release retained source
       capacity. Unknown finish outcomes remain untouched across restart. *)
    locked t (fun () ->
      List.iter (Map.data t.jobs) ~f:(fun value ->
        ignore (cleanup_published t value : Job.t));
      t))
;;

let record t id phase diagnostic =
  locked t (fun () ->
    let previous = job t id in
    let value = next_job previous phase diagnostic in
    set_job t value;
    synchronize t;
    cleanup_published t value)
;;

let validate_finish native response =
  Api_response.of_json response |> Result.bind ~f:(finish_publication native)
;;

let upload_phase native = function
  | Error problem -> Error problem
  | Ok (Transfer.Upload_result.Link_failed { publication; error }) ->
    Result.map (validate_finish native publication) ~f:(fun publication ->
      Job.Published { publication; link = Pending (Some error) })
  | Ok (Complete response) ->
    Json.decode (fun () ->
      let response = Api_response.of_json response |> Disk.unwrap in
      let data = Api_response.data response in
      let nested = Json.optional data "ticket_link" in
      let publication =
        match nested, data with
        | None, _ -> response
        | Some _, `Object fields ->
          Api_response.of_json
            (Json.obj
               [ ( "data"
                 , Json.obj
                     (List.filter fields ~f:(fun (name, _) ->
                        not (String.equal name "ticket_link" || String.equal name "atomic")))
                 )
               ; "meta", Api_response.meta response
               ])
          |> Disk.unwrap
        | Some _, _ -> Json.fail Outcome_unknown "invalid native upload result"
      in
      let publication = finish_publication native publication |> Disk.unwrap in
      let request =
        Transfer.Upload_plan.link_request native ~publication |> Disk.unwrap
      in
      let link =
        match request, nested with
        | None, None -> Job.Not_requested
        | Some request, Some raw ->
          let response = Api_response.of_json raw |> Disk.unwrap in
          ignore
            (Acknowledgement.validate request ~response |> Disk.unwrap
             : Acknowledgement.t);
          Committed response
        | _ -> Json.fail Outcome_unknown "native upload completion/link identity differs"
      in
      Job.Published { publication; link })
;;

let uncertain previous error =
  match prior_publication previous with
  | None -> Job.Outcome_unknown error
  | Some previous -> Published previous
;;

(* Read the current owner state under the publication mutex: the invocation's
   starting snapshot may predate a verified finish or a completed link. A later
   timeout must never undo either fact, even if cleanup was interrupted. *)
let fence_latest t id error =
  locked t (fun () ->
    let latest = job t id in
    let value = next_job latest (uncertain latest.phase error) (Some error) in
    set_job t value;
    synchronize t;
    value)
;;

let receipt t client request =
  let open Result.Let_syntax in
  let%bind entry =
    Request_journal.Entry.create request ~fs:(State_root.directory t.root)
  in
  let%bind lookup = Acknowledgement.receipt_request entry in
  let%bind result = Client.invoke client lookup in
  let%bind response = Api_response.of_json result in
  Acknowledgement.receipt request ~entry ~response
;;

let recover_phase t client value =
  let open Result.Let_syntax in
  let finish = Transfer.Upload_plan.finish_request value.Job.native in
  let%bind received = receipt t client finish in
  let%bind publication =
    match received with
    | Some (Acknowledgement.Committed response) ->
      Result.map (finish_publication value.native response) ~f:Option.some
    | Some (Observed _) ->
      Error (Problem.create Outcome_unknown "finish receipt is not a durable publication")
    | None ->
      Ok (Option.map (prior_publication value.phase) ~f:(fun known -> known.publication))
  in
  match publication with
  | None -> Ok value.phase
  | Some publication ->
    let%bind link = Transfer.Upload_plan.link_request value.native ~publication in
    (match link with
     | None -> Ok (Job.Published { publication; link = Not_requested })
     | Some request ->
       let previous =
         Option.bind (prior_publication value.phase) ~f:(fun previous ->
           match previous.link with
           | Committed value -> Some value
           | Not_requested | Pending _ -> None)
       in
       (match receipt t client request with
        | Ok (Some (Committed response)) ->
          Ok (Job.Published { publication; link = Committed response })
        | Ok (Some (Observed _)) ->
          let diagnostic =
            Problem.create Outcome_unknown "link receipt is not committed"
          in
          (match previous with
           | Some _ -> Error diagnostic
           | None -> Ok (Job.Published { publication; link = Pending (Some diagnostic) }))
        | Ok None ->
          Ok
            (Job.Published
               { publication
               ; link =
                   (match previous with
                    | Some response -> Committed response
                    | None -> Pending None)
               })
        | Error error ->
          (match previous with
           | Some _ -> Error error
           | None -> Ok (Job.Published { publication; link = Pending (Some error) }))))
;;

let eligible phase kind =
  match kind, phase with
  | Recover, (Job.Prepared_unsent | Outcome_unknown _ | Published _ | Rejected _) -> true
  | Start, Prepared_unsent
  | Retry, Outcome_unknown _
  | Retry, Published { link = Pending _; _ } -> true
  | (Start | Retry | Recover), (Saving_local | Running _) -> false
  | (Start | Retry), (Prepared_unsent | Outcome_unknown _ | Published _ | Rejected _) ->
    false
;;

let run t id kind =
  let launched =
    locked t (fun () ->
      ensure_synced t;
      let value = job t id in
      match t.flight with
      | Some flight
        when Operation.Id.equal flight.id id && equal_flight_kind flight.kind kind ->
        `Existing flight
      | Some _ -> Json.fail Conflict "one resource helper invocation is already active"
      | None when not (eligible value.phase kind) -> `Terminal value
      | None ->
        let admission, admit = Eio.Promise.create () in
        let finished, finish = Eio.Promise.create () in
        let flight = { id; kind; admission; finished } in
        t.flight <- Some flight;
        Eio.Fiber.fork ~sw:t.sw (fun () ->
          let barrier_started = ref false in
          let settled = ref false in
          let settle value =
            if not !settled
            then (
              settled := true;
              Eio.Promise.resolve admit value)
          in
          Exn.protect
            ~finally:(fun () ->
              t.flight <- None;
              Eio.Promise.resolve finish ())
            ~f:(fun () ->
              let result =
                try
                  Eio.Time.Timeout.run_exn
                    (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock t.env) 300.)
                    (fun () ->
                       (* Once per bounded explicit helper invocation. All internal
                   Transfer exchanges keep this same qualified captured client. *)
                       match t.client value.plan.connection with
                       | Error error ->
                         settle (Error error);
                         Error error
                       | Ok client ->
                         (match kind with
                          | Recover ->
                            settle (Ok ());
                            (match recover_phase t client value with
                             | Ok phase -> record t id phase None |> Result.map ~f:ignore
                             | Error error ->
                               record t id value.phase (Some error)
                               |> Result.bind ~f:(fun _ -> Error error))
                          | Start | Retry ->
                            barrier_started := true;
                            let barrier =
                              record
                                t
                                id
                                (Job.Running (prior_publication value.phase))
                                None
                            in
                            (match barrier with
                             | Error error ->
                               (* No native exchange ran, but the local Running write
                           itself may have published. Keep an explicit fenced
                           unknown instead of stranding a sendable local phase. *)
                               ignore
                                 (fence_latest t id error : (Job.t, Problem.t) Result.t);
                               settle (Error error);
                               Error error
                             | Ok _ ->
                               settle (Ok ());
                               let fs = State_root.directory t.root in
                               let native = value.native in
                               let result =
                                 Eio.Domain_manager.run
                                   (Eio.Stdenv.domain_mgr t.env)
                                   (fun () ->
                                      Transfer.upload_with_link native ~client ~fs)
                                 |> upload_phase native
                               in
                               (match result with
                                | Ok phase ->
                                  record t id phase None |> Result.map ~f:ignore
                                | Error error ->
                                  fence_latest t id error |> Result.map ~f:ignore))))
                with
                | Eio.Time.Timeout ->
                  let error =
                    Problem.create
                      Outcome_unknown
                      "resource helper invocation reached its absolute300s deadline; \
                       preserve exact identity"
                  in
                  if !barrier_started
                  then ignore (fence_latest t id error : (Job.t, Problem.t) Result.t);
                  settle (Error error);
                  Error error
              in
              match result with
              | Ok () -> settle (Ok ())
              | Error error -> settle (Error error)));
        `Existing flight)
  in
  match launched with
  | Error error -> Error error
  | Ok (`Terminal value) -> Ok value
  | Ok (`Existing flight) ->
    (match Eio.Promise.await flight.admission with
     | Error error ->
       (* Failed local/qualification admission is terminal only after the owner
          releases its flight. A following explicit call must not see stale busy. *)
       Eio.Promise.await flight.finished;
       Error error
     | Ok () ->
       if equal_flight_kind kind Recover then Eio.Promise.await flight.finished;
       locked t (fun () ->
         ensure_synced t;
         job t id))
;;

let start t ~id = run t id Start
let retry_exact t ~id = run t id Retry
let recover t ~id = run t id Recover

let inspect t ~id =
  locked t (fun () ->
    ensure_synced t;
    job t id)
;;

let list t ~offset ~limit =
  locked t (fun () ->
    ensure_synced t;
    if offset < 0 || limit < 1 || limit > 100
    then
      Json.fail Invalid_argument "upload page requires nonnegative offset and limit1..100";
    let rows = List.drop (Map.data t.jobs) offset in
    let selected = List.take rows limit in
    let remaining = List.length rows - List.length selected in
    Json.obj
      [ "items", `Array (List.map selected ~f:Job.to_json)
      ; "offset", Json.int offset
      ; "remaining", Json.int remaining
      ; ( "next_offset"
        , if remaining = 0 then `Null else Json.int (offset + List.length selected) )
      ])
;;
