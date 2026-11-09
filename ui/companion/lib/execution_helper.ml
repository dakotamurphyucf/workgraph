open Core
open Workgraph

let encode codec value = Api_codec.encode codec value |> Disk.unwrap

let path directory =
  ignore
    (Api_codec.decode (Api_codec.text ~max_bytes:4096) (Json.string directory)
     |> Disk.unwrap
     : string);
  if String.mem directory '\000' then Json.fail Invalid_argument "stage path contains NUL";
  Disk.absolute directory
;;

let digest value =
  Api_codec.decode Resource_wire.digest (Json.string value) |> Disk.unwrap
;;

let boolean value = if value then `True else `False

let text_option = function
  | None -> `Null
  | Some value -> Json.string value
;;

module Plan = struct
  type origin =
    | New of
        { context : Operation.Context.t
        ; capture_digest : string
        ; params : Jsonaf.t
        }
    | External of { intent_digest : string }

  type t =
    { id : Operation.Id.t
    ; connection : Connection_profile.t
    ; directory : string
    ; origin : origin
    }

  let create ~intention_id ~connection ~context ~directory ~capture_digest ~params =
    Json.decode (fun () ->
      path directory;
      let capture_digest = digest capture_digest in
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
          ; "ticket_id"
          ];
      let workspace = Id.Workspace.t_of_jsonaf (Json.field params "workspace_id") in
      let actor = Id.Actor.t_of_jsonaf (Json.field params "actor_id") in
      let run = Option.map (Json.optional params "run_id") ~f:Id.Run.t_of_jsonaf in
      ignore (Id.Resource.t_of_jsonaf (Json.field params "resource_id") : Id.Resource.t);
      ignore (Json.integer (Json.field params "expected_revision") : int);
      let title =
        Api_codec.decode (Api_codec.text ~max_bytes:512) (Json.field params "title")
        |> Disk.unwrap
      in
      if String.is_empty title
      then Json.fail Invalid_argument "publication title is empty";
      Option.iter (Json.optional params "ticket_id") ~f:(fun value ->
        ignore (Id.Ticket.t_of_jsonaf value : Id.Ticket.t));
      let writer = Operation.Context.writer context in
      if
        not
          (Option.equal
             Id.Workspace.equal
             (Some workspace)
             (Operation.Context.workspace context)
           && Id.Actor.equal actor (Writer.actor writer)
           && Option.equal Id.Run.equal run (Writer.run writer))
      then
        Json.fail
          Invalid_argument
          "publication attribution differs from captured workspace/writer";
      let mutation = Json.text (Json.field params "mutation_id") in
      if not (String.equal mutation (Operation.Id.to_string intention_id))
      then
        Json.fail
          Invalid_argument
          "new publication mutation identity must equal the retained intention";
      { id = intention_id
      ; connection
      ; directory
      ; origin = New { context; capture_digest; params }
      })
  ;;

  let external_binding ~intention_id ~connection ~directory ~intent_digest =
    Json.decode (fun () ->
      path directory;
      let intent_digest = digest intent_digest in
      { id = intention_id; connection; directory; origin = External { intent_digest } })
  ;;

  let to_json t =
    let common =
      [ "intention_id", Operation.Id.jsonaf_of_t t.id
      ; "connection", Connection_profile.to_json t.connection
      ; "directory", Json.string t.directory
      ]
    in
    Json.obj
      (common
       @
       match t.origin with
       | New { context; capture_digest; params } ->
         [ "kind", Json.string "ui_prepared"
         ; "context", Operation.Context.to_json context
         ; "capture_digest", Json.string capture_digest
         ; "params", params
         ]
       | External { intent_digest } ->
         [ "kind", Json.string "operator_bound_external"
         ; "intent_digest", Json.string intent_digest
         ])
  ;;

  let of_json value =
    Json.decode (fun () ->
      let common = [ "kind"; "intention_id"; "connection"; "directory" ] in
      let id = Operation.Id.t_of_jsonaf (Json.field value "intention_id") in
      let connection =
        Connection_profile.of_json (Json.field value "connection") |> Disk.unwrap
      in
      let directory = Json.text (Json.field value "directory") in
      match Json.text (Json.field value "kind") with
      | "ui_prepared" ->
        Json.fields value ~allowed:(common @ [ "context"; "capture_digest"; "params" ]);
        create
          ~intention_id:id
          ~connection
          ~directory
          ~context:(Operation.Context.of_json (Json.field value "context") |> Disk.unwrap)
          ~capture_digest:(Json.text (Json.field value "capture_digest"))
          ~params:(Json.field value "params")
        |> Disk.unwrap
      | "operator_bound_external" ->
        Json.fields value ~allowed:(common @ [ "intent_digest" ]);
        external_binding
          ~intention_id:id
          ~connection
          ~directory
          ~intent_digest:(Json.text (Json.field value "intent_digest"))
        |> Disk.unwrap
      | _ -> Json.fail Invalid_argument "unknown execution publication binding origin")
  ;;
end

module Inspection = struct
  type t = Jsonaf.t

  let to_json t = t
end

let capture_json capture = encode Execution_capture.codec capture
let capture_bytes capture = Json.canonical (capture_json capture)
let capture_digest capture = Json.hash (capture_bytes capture)

let output_summary output =
  Json.obj
    [ "digest", Json.string (Json.hash (Execution_capture.Output.bytes output))
    ; "size_bytes", Json.int (String.length (Execution_capture.Output.bytes output))
    ; "observed_bytes", Json.int64 (Execution_capture.Output.observed_bytes output)
    ; "observed_sha256", Json.string (Execution_capture.Output.observed_sha256 output)
    ; "eof", boolean (Execution_capture.Output.eof output)
    ; "truncated", boolean (Execution_capture.Output.truncated output)
    ]
;;

let owned_stage ~fs ~directory =
  let stage = Execution_stage.load ~fs ~directory |> Disk.unwrap in
  if Option.is_none (Execution_stage.owner_token stage)
  then Json.fail Invalid_argument "stage has no native ownership marker";
  stage
;;

let stage_summary stage ~publication_intent =
  let common command =
    [ "directory", Json.string (Execution_stage.directory stage)
    ; "command", encode Execution_capture.Command.codec command
    ; "owner_token", text_option (Execution_stage.owner_token stage)
    ; "publication_intent", Json.string publication_intent
    ]
  in
  match Execution_stage.state stage with
  | Unfinished command -> Json.obj (("kind", Json.string "unfinished") :: common command)
  | Finished capture ->
    let encoded = capture_json capture in
    Json.obj
      (common (Execution_capture.command capture)
       @ [ "kind", Json.string "finished"
         ; ( "capture"
           , Json.obj
               [ "digest", Json.string (capture_digest capture)
               ; "size_bytes", Json.int (String.length (Json.canonical encoded))
               ] )
         ; ( "outcome"
           , encode Execution_capture.Outcome.codec (Execution_capture.outcome capture) )
         ; "started_unix_ms", Json.field encoded "started_unix_ms"
         ; "finished_unix_ms", Json.field encoded "finished_unix_ms"
         ; "elapsed_ms", Json.field encoded "elapsed_ms"
         ; ( "source_before"
           , Source_provenance.coverage (Execution_capture.source_before capture) )
         ; ( "source_after"
           , Source_provenance.coverage (Execution_capture.source_after capture) )
         ; "stdout", output_summary (Execution_capture.stdout capture)
         ; "stderr", output_summary (Execution_capture.stderr capture)
         ])
;;

module Job = struct
  type link =
    | Not_requested
    | Linked of Api_response.t
    | Rejected of Problem.t
    | Unknown of Problem.t option

  type publication =
    { publication : Api_response.t
    ; link : link
    }

  type state =
    | Saving_local of Problem.t
    | Prepared_unsent
    | Running of publication option
    | Published of publication
    | Outcome_unknown of Problem.t
    | Failed_unsent of Problem.t

  type t =
    { plan : Plan.t
    ; input_hash : string
    ; revision : int
    ; intent : string option
    ; state : state
    ; diagnostic : Problem.t option
    }

  let link_json = function
    | Not_requested -> Json.obj [ "kind", Json.string "not_requested" ]
    | Linked response ->
      Json.obj [ "kind", Json.string "linked"; "receipt", Api_response.to_json response ]
    | Rejected problem ->
      Json.obj [ "kind", Json.string "rejected"; "problem", Problem.to_json problem ]
    | Unknown problem ->
      Json.obj
        [ "kind", Json.string "unknown"
        ; "problem", Option.value_map problem ~default:`Null ~f:Problem.to_json
        ]
  ;;

  let publication_json value =
    [ "publication", Api_response.to_json value.publication
    ; "link", link_json value.link
    ]
  ;;

  let state_json = function
    | Saving_local diagnostic ->
      Json.obj
        [ "kind", Json.string "local_save_incomplete"
        ; "diagnostic", Problem.to_json diagnostic
        ]
    | Prepared_unsent -> Json.obj [ "kind", Json.string "prepared_unsent" ]
    | Running previous ->
      Json.obj
        [ "kind", Json.string "running"
        ; ( "previous"
          , Option.value_map previous ~default:`Null ~f:(fun p ->
              Json.obj (publication_json p)) )
        ]
    | Published p -> Json.obj (("kind", Json.string "published") :: publication_json p)
    | Outcome_unknown diagnostic ->
      Json.obj
        [ "kind", Json.string "outcome_unknown"
        ; "diagnostic", Problem.to_json diagnostic
        ]
    | Failed_unsent diagnostic ->
      Json.obj
        [ "kind", Json.string "failed_unsent"; "diagnostic", Problem.to_json diagnostic ]
  ;;

  let request t =
    Option.map t.intent ~f:(fun bytes ->
      Json.parse bytes |> Disk.unwrap |> Protocol.Request.of_json |> Disk.unwrap)
  ;;

  let to_json t =
    Json.obj
      [ "plan", Plan.to_json t.plan
      ; "input_hash", Json.string t.input_hash
      ; "revision", Json.int t.revision
      ; ( "saved_request"
        , match t.intent with
          | None -> `Null
          | Some _ -> Json.string (Filename.concat t.plan.directory "publication.json") )
      ; ( "native_request"
        , Option.value_map (request t) ~default:`Null ~f:Protocol.Request.to_json )
      ; ( "intent_digest"
        , Option.value_map t.intent ~default:`Null ~f:(fun bytes ->
            Json.string (Json.hash bytes)) )
      ; "state", state_json t.state
      ; "diagnostic", Option.value_map t.diagnostic ~default:`Null ~f:Problem.to_json
      ]
  ;;

  let summary t =
    let known =
      match t.state with
      | Published p | Running (Some p) -> Some p
      | Saving_local _ | Prepared_unsent
      | Running None
      | Outcome_unknown _ | Failed_unsent _ -> None
    in
    let state_kind = Json.field (state_json t.state) "kind" in
    Json.obj
      [ "plan", Plan.to_json t.plan
      ; "revision", Json.int t.revision
      ; "state_kind", state_kind
      ; "publication_known", boolean (Option.is_some known)
      ; ( "link_kind"
        , Option.value_map known ~default:`Null ~f:(fun known ->
            Json.field (link_json known.link) "kind") )
      ; "diagnostic", Option.value_map t.diagnostic ~default:`Null ~f:Problem.to_json
      ]
  ;;

  let storage t =
    Json.obj
      [ "format", Json.string "workgraph-ui-execution-1"
      ; "plan", Plan.to_json t.plan
      ; "input_hash", Json.string t.input_hash
      ; "revision", Json.int t.revision
      ; "intent", text_option t.intent
      ; "state_text", Json.string (Json.canonical (state_json t.state))
      ; "diagnostic", Option.value_map t.diagnostic ~default:`Null ~f:Problem.to_json
      ]
  ;;
end

let native_plan ~fs ~directory bytes =
  let request =
    Json.parse bytes |> Disk.unwrap |> Protocol.Request.of_json |> Disk.unwrap
  in
  if not (String.equal (Protocol.Request.method_ request) "resource.upload")
  then Json.fail Corrupt_store "saved execution intent is not resource.upload";
  let params = Protocol.Request.params request in
  let native = Transfer.Upload_plan.prepare ~fs ~params |> Disk.unwrap in
  if
    not
      (String.equal
         (Json.canonical params)
         (Json.canonical (Transfer.Upload_plan.params native)))
  then Json.fail Corrupt_store "saved execution intent is not complete";
  if
    not
      (String.equal
         (Json.text (Json.field params "file"))
         (Filename.concat directory "capture.json"))
  then Json.fail Corrupt_store "execution upload source differs from bound stage";
  native
;;

let validate_native_binding plan native =
  match plan.Plan.origin with
  | External _ -> ()
  | New { params; capture_digest; _ } ->
    let complete = Transfer.Upload_plan.params native in
    List.iter
      (match params with
       | `Object fields -> fields
       | _ -> assert false)
      ~f:(fun (name, value) ->
        if
          not
            (String.equal
               (Json.canonical value)
               (Json.canonical (Json.field complete name)))
        then
          Json.fail
            Idempotency_conflict
            "saved native intent differs from bound preparation");
    if
      Option.is_none (Json.optional params "ticket_id")
      && Option.is_some (Json.optional complete "ticket_id")
    then Json.fail Idempotency_conflict "saved native intent adds a ticket link";
    if
      not
        (String.equal (Json.text (Json.field complete "digest")) capture_digest
         && String.equal
              (Json.text (Json.field complete "filename"))
              "execution-capture.json"
         && String.equal (Json.text (Json.field complete "mime_type")) "application/json"
        )
    then
      Json.fail
        Idempotency_conflict
        "saved native intent captures different content/metadata"
;;

let validate_publication native response =
  let finish = Transfer.Upload_plan.finish_request native in
  (match Acknowledgement.validate finish ~response |> Disk.unwrap with
   | Committed _ -> ()
   | Observed _ -> Json.fail Outcome_unknown "execution finish was not durable");
  ignore
    (Transfer.Upload_plan.link_request native ~publication:response |> Disk.unwrap
     : Protocol.Request.t option);
  response
;;

let decode_publication native value =
  Json.fields value ~allowed:[ "publication"; "link" ];
  let publication =
    Api_response.of_json (Json.field value "publication")
    |> Disk.unwrap
    |> validate_publication native
  in
  let link_value = Json.field value "link" in
  let link_request =
    Transfer.Upload_plan.link_request native ~publication |> Disk.unwrap
  in
  let problem () =
    Problem_wire.of_json (Json.field link_value "problem") |> Disk.unwrap
  in
  let link =
    match Json.text (Json.field link_value "kind"), link_request with
    | "not_requested", None ->
      Json.fields link_value ~allowed:[ "kind" ];
      Job.Not_requested
    | "linked", Some request ->
      Json.fields link_value ~allowed:[ "kind"; "receipt" ];
      let response =
        Api_response.of_json (Json.field link_value "receipt") |> Disk.unwrap
      in
      (match Acknowledgement.validate request ~response |> Disk.unwrap with
       | Committed _ -> Job.Linked response
       | Observed _ -> Json.fail Corrupt_store "saved link is not committed")
    | "rejected", Some _ ->
      Json.fields link_value ~allowed:[ "kind"; "problem" ];
      let rejected = problem () in
      (match rejected.kind with
       | Outcome_unknown | Local_io | Storage_unavailable ->
         Json.fail Corrupt_store "uncertain link cannot be recorded as rejected"
       | Invalid_argument
       | Not_found
       | Conflict
       | Blocked
       | Dependency_cycle
       | Already_claimed
       | Stale_claim
       | Idempotency_conflict
       | Corrupt_store
       | Workspace_closed
       | Unsupported_version -> Job.Rejected rejected)
    | "unknown", Some _ ->
      Json.fields link_value ~allowed:[ "kind"; "problem" ];
      Job.Unknown
        (match Json.field link_value "problem" with
         | `Null -> None
         | _ -> Some (problem ()))
    | _ -> Json.fail Corrupt_store "saved link differs from original upload plan"
  in
  { Job.publication; link }
;;

let job_of_storage ~fs value =
  Json.decode (fun () ->
    Json.fields
      value
      ~allowed:
        [ "format"
        ; "plan"
        ; "input_hash"
        ; "revision"
        ; "intent"
        ; "state_text"
        ; "diagnostic"
        ];
    if
      not
        (String.equal (Json.text (Json.field value "format")) "workgraph-ui-execution-1")
    then Json.fail Unsupported_version "unsupported execution helper storage";
    let plan = Plan.of_json (Json.field value "plan") |> Disk.unwrap in
    let input_hash = Json.text (Json.field value "input_hash") in
    if not (String.equal input_hash (Json.hash (Json.canonical (Plan.to_json plan))))
    then Json.fail Corrupt_store "execution input hash differs";
    let revision = Json.integer (Json.field value "revision") in
    if revision < 1 then Json.fail Corrupt_store "execution revision must be positive";
    let intent =
      match Json.field value "intent" with
      | `Null -> None
      | v -> Some (Json.text v)
    in
    let native =
      Option.map intent ~f:(fun bytes ->
        let native = native_plan ~fs ~directory:plan.directory bytes in
        validate_native_binding plan native;
        native)
    in
    let raw = Json.parse (Json.text (Json.field value "state_text")) |> Disk.unwrap in
    let kind = Json.text (Json.field raw "kind") in
    let diagnostic () =
      Problem_wire.of_json (Json.field raw "diagnostic") |> Disk.unwrap
    in
    let publication value =
      match native with
      | None -> Json.fail Corrupt_store "known execution publication lacks intent"
      | Some native -> decode_publication native value
    in
    let state =
      match kind with
      | "local_save_incomplete" ->
        Json.fields raw ~allowed:[ "kind"; "diagnostic" ];
        Job.Saving_local (diagnostic ())
      | "prepared_unsent" ->
        Json.fields raw ~allowed:[ "kind" ];
        Job.Prepared_unsent
      | "running" ->
        Json.fields raw ~allowed:[ "kind"; "previous" ];
        Job.Running
          (match Json.field raw "previous" with
           | `Null -> None
           | v -> Some (publication v))
      | "published" ->
        Json.fields raw ~allowed:[ "kind"; "publication"; "link" ];
        Job.Published
          (publication
             (Json.obj
                [ "publication", Json.field raw "publication"
                ; "link", Json.field raw "link"
                ]))
      | "outcome_unknown" ->
        Json.fields raw ~allowed:[ "kind"; "diagnostic" ];
        Job.Outcome_unknown (diagnostic ())
      | "failed_unsent" ->
        Json.fields raw ~allowed:[ "kind"; "diagnostic" ];
        Job.Failed_unsent (diagnostic ())
      | _ -> Json.fail Corrupt_store "unknown execution state"
    in
    (match plan.origin, state with
     | Plan.External _, Job.Prepared_unsent ->
       Json.fail Corrupt_store "external intent cannot prove publication unsent"
     | ( Plan.External _
       , (Saving_local _ | Running _ | Published _ | Outcome_unknown _ | Failed_unsent _)
       )
     | New _, _ -> ());
    (match state, intent with
     | (Job.Prepared_unsent | Running _ | Published _ | Outcome_unknown _), None ->
       Json.fail Corrupt_store "execution state requires saved intent"
     | (Saving_local _ | Failed_unsent _), _
     | (Prepared_unsent | Running _ | Published _ | Outcome_unknown _), Some _ -> ());
    (match plan.origin, intent with
     | Plan.External { intent_digest }, Some bytes
       when not (String.equal intent_digest (Json.hash bytes)) ->
       Json.fail Corrupt_store "external binding intent digest differs"
     | Plan.External _, _ | New _, _ -> ());
    let diagnostic =
      match Json.field value "diagnostic" with
      | `Null -> None
      | v -> Some (Problem_wire.of_json v |> Disk.unwrap)
    in
    { Job.plan; input_hash; revision; intent; state; diagnostic })
;;

type invocation =
  | Start
  | Retry
  | Recover
[@@deriving equal]

type flight =
  { id : Operation.Id.t
  ; kind : invocation
  ; admitted : (unit, Problem.t) Result.t Eio.Promise.t
  }

type t =
  { sw : Eio.Switch.t
  ; env : Eio_unix.Stdenv.base
  ; root : State_root.t
  ; mutex : Eio.Mutex.t
  ; client : Connection_profile.t -> (Client.t, Problem.t) Result.t
  ; qualification : Daemon_qualification.t
  ; mutable jobs : Job.t Operation.Id.Map.t
  ; mutable dirty : bool
  ; mutable flight : flight option
  ; mutable reading : bool
  }

let locked t f = Eio.Mutex.use_rw ~protect:true t.mutex (fun () -> Json.decode f)
let name id = "execution-" ^ Operation.Id.to_string id ^ ".json"

let save t job =
  State_root.save t.root ~name:(name job.Job.plan.id) ~value:(Job.storage job)
;;

let lookup t id =
  match Map.find t.jobs id with
  | None -> Json.fail Not_found "execution publication not found"
  | Some job -> job
;;

let synchronize t =
  if t.dirty
  then (
    List.iter (Map.data t.jobs) ~f:(fun job -> save t job |> Disk.unwrap);
    t.dirty <- false)
;;

let put t job =
  t.jobs <- Map.set t.jobs ~key:job.Job.plan.id ~data:job;
  t.dirty <- true;
  synchronize t
;;

let next (job : Job.t) state diagnostic =
  { job with Job.revision = job.revision + 1; state; diagnostic }
;;

let prior = function
  | Job.Published p | Running (Some p) -> Some p
  | Saving_local _ | Prepared_unsent | Running None | Outcome_unknown _ | Failed_unsent _
    -> None
;;

let uncertainty job diagnostic =
  match prior job.Job.state with
  | Some p -> Job.Published p
  | None -> Outcome_unknown diagnostic
;;

let create ~sw ~env ~root ~client =
  Json.decode (fun () ->
    let t =
      { sw
      ; env
      ; root
      ; client
      ; qualification = Daemon_qualification.create ~clock:(Eio.Stdenv.mono_clock env)
      ; mutex = Eio.Mutex.create ()
      ; jobs = Operation.Id.Map.empty
      ; dirty = false
      ; flight = None
      ; reading = false
      }
    in
    List.iter
      (State_root.names root |> Disk.unwrap)
      ~f:(fun filename ->
        if String.is_prefix filename ~prefix:"execution-"
        then (
          let job =
            State_root.read root ~name:filename
            |> Disk.unwrap
            |> Option.value_exn
            |> job_of_storage ~fs:(Eio.Stdenv.fs env)
            |> Disk.unwrap
          in
          if
            Map.length t.jobs >= 100
            || Map.mem t.jobs job.plan.id
            || not (String.equal filename (name job.plan.id))
          then Json.fail Corrupt_store "execution helper identity/retention mismatch";
          if
            Map.exists t.jobs ~f:(fun saved ->
              String.equal saved.plan.directory job.plan.directory)
          then Json.fail Corrupt_store "execution stage has multiple bindings";
          let job =
            match job.state with
            | Job.Running previous ->
              let diagnostic =
                Problem.create
                  Outcome_unknown
                  "companion restarted after publication admission; inspect/recover or \
                   retry the exact intent explicitly"
              in
              next
                job
                (match previous with
                 | Some p -> Published p
                 | None -> Outcome_unknown diagnostic)
                (Some diagnostic)
            | Saving_local _
            | Prepared_unsent
            | Published _
            | Outcome_unknown _
            | Failed_unsent _ -> job
          in
          t.jobs <- Map.set t.jobs ~key:job.plan.id ~data:job;
          save t job |> Disk.unwrap));
    t)
;;

let isolated t f =
  let admitted =
    locked t (fun () ->
      if t.reading
      then Json.fail Blocked "one local evidence inspection is already active";
      t.reading <- true)
  in
  Result.bind admitted ~f:(fun () ->
    Exn.protect
      ~finally:(fun () -> t.reading <- false)
      ~f:(fun () -> Eio.Domain_manager.run (Eio.Stdenv.domain_mgr t.env) f))
;;

let intent_bytes ~fs ~directory =
  let native = Execution_publication.load ~fs ~directory |> Disk.unwrap in
  let saved = Execution_publication.saved_request native in
  let bytes =
    Local_file.read Eio.Path.(fs / saved) ~operation:"read exact execution intent"
  in
  ignore (native_plan ~fs ~directory bytes : Transfer.Upload_plan.t);
  bytes
;;

let inspect_stage t ~directory =
  let bound = locked t (fun () -> Map.data t.jobs) in
  Result.bind bound ~f:(fun jobs ->
    isolated t (fun () ->
      Local_file.protect ~operation:"inspect execution stage" ~path:directory (fun () ->
        path directory;
        let fs = Eio.Stdenv.fs t.env in
        let stage = Execution_stage.load ~fs ~directory |> Disk.unwrap in
        let publication_intent =
          match
            Eio.Path.kind
              ~follow:false
              Eio.Path.(fs / Filename.concat directory "publication.json")
          with
          | `Not_found -> "absent"
          | _ ->
            let bytes = intent_bytes ~fs ~directory in
            if
              List.exists jobs ~f:(fun job ->
                String.equal job.Job.plan.directory directory
                && Option.value_map job.intent ~default:false ~f:(String.equal bytes))
            then "helper_bound"
            else "external"
        in
        stage_summary stage ~publication_intent)))
;;

let inspect_output t ~directory ~capture_digest:expected ~stream ~selection =
  isolated t (fun () ->
    Local_file.protect
      ~operation:"inspect retained execution output"
      ~path:directory
      (fun () ->
         path directory;
         ignore (digest expected : string);
         let stage =
           Execution_stage.load ~fs:(Eio.Stdenv.fs t.env) ~directory |> Disk.unwrap
         in
         let capture =
           match Execution_stage.state stage with
           | Unfinished _ -> Json.fail Conflict "execution stage is unfinished"
           | Finished c -> c
         in
         if not (String.equal expected (capture_digest capture))
         then Json.fail Conflict "execution capture changed; inspect stage explicitly";
         let output =
           Execution_inspect.create capture ~stream ~selection
           |> Disk.unwrap
           |> Execution_inspect.to_json
         in
         match output with
         | `Object fields ->
           Json.obj
             (("directory", Json.string directory)
              :: ("capture_digest", Json.string expected)
              :: fields)
         | _ -> assert false))
;;

let inspect_intent t ~directory =
  isolated t (fun () ->
    Local_file.protect
      ~operation:"inspect saved execution intent"
      ~path:directory
      (fun () ->
         path directory;
         let fs = Eio.Stdenv.fs t.env in
         ignore (owned_stage ~fs ~directory : Execution_stage.t);
         let bytes = intent_bytes ~fs ~directory in
         Json.obj
           [ "directory", Json.string directory
           ; "intent_digest", Json.string (Json.hash bytes)
           ; "saved_request", Json.string (Filename.concat directory "publication.json")
           ; "request", Json.parse bytes |> Disk.unwrap
           ; "original_endpoint_recorded", `False
           ]))
;;

let materialize t plan =
  let fs = Eio.Stdenv.fs t.env in
  let seed = Cstruct.create 32 in
  Eio.Flow.read_exact (Eio.Stdenv.secure_random t.env) seed;
  let seed = Cstruct.to_string seed in
  Eio.Domain_manager.run (Eio.Stdenv.domain_mgr t.env) (fun () ->
    Local_file.protect
      ~operation:"bind execution publication"
      ~path:plan.Plan.directory
      (fun () ->
         let stage = owned_stage ~fs ~directory:plan.directory in
         match plan.origin with
         | External { intent_digest } ->
           let bytes = intent_bytes ~fs ~directory:plan.directory in
           if not (String.equal intent_digest (Json.hash bytes))
           then
             Json.fail
               Idempotency_conflict
               "external intent bytes changed since inspection";
           bytes
         | New { capture_digest = expected; params; _ } ->
           let capture =
             match Execution_stage.state stage with
             | Unfinished _ -> Json.fail Conflict "only a finished stage may be published"
             | Finished c -> c
           in
           if not (String.equal expected (capture_digest capture))
           then Json.fail Conflict "execution capture differs from the reviewed stage";
           let saved = Filename.concat plan.directory "publication.json" in
           (match Eio.Path.kind ~follow:false Eio.Path.(fs / saved) with
            | `Not_found ->
              ignore
                (Execution_publication.prepare
                   stage
                   ~fs
                   ~random:(Eio.Flow.string_source seed)
                   ~params
                 |> Disk.unwrap
                 : Execution_publication.t)
            | _ -> ());
           let bytes = intent_bytes ~fs ~directory:plan.directory in
           let native = native_plan ~fs ~directory:plan.directory bytes in
           validate_native_binding plan native;
           bytes))
;;

let prepare t plan =
  locked t (fun () ->
    synchronize t;
    let input_hash = Json.hash (Json.canonical (Plan.to_json plan)) in
    let existing = Map.find t.jobs plan.Plan.id in
    if Option.is_none existing
    then (
      let canonical =
        Eio.Domain_manager.run (Eio.Stdenv.domain_mgr t.env) (fun () ->
          Local_file.protect
            ~operation:"resolve execution stage"
            ~path:plan.directory
            (fun () -> Platform.realpath plan.directory))
        |> Disk.unwrap
      in
      if not (String.equal canonical plan.directory)
      then Json.fail Invalid_argument ("use the canonical stage directory: " ^ canonical));
    let job =
      match existing with
      | Some job ->
        if not (String.equal job.input_hash input_hash)
        then
          Json.fail
            Idempotency_conflict
            "execution intention already captures different input";
        job
      | None ->
        if Map.length t.jobs >= 100
        then Json.fail Blocked "100 retained execution publication intentions";
        if
          Map.exists t.jobs ~f:(fun job ->
            String.equal job.Job.plan.directory plan.directory)
        then Json.fail Idempotency_conflict "execution stage already has another binding";
        (* Validate the reviewed source without preparing or sending anything.
           An already existing external intent requires the distinct association action. *)
        Eio.Domain_manager.run (Eio.Stdenv.domain_mgr t.env) (fun () ->
          Local_file.protect
            ~operation:"validate evidence binding"
            ~path:plan.directory
            (fun () ->
               let fs = Eio.Stdenv.fs t.env in
               let stage = owned_stage ~fs ~directory:plan.directory in
               match plan.origin with
               | Plan.New { capture_digest = expected; _ } ->
                 let capture =
                   match Execution_stage.state stage with
                   | Finished c -> c
                   | Unfinished _ -> Json.fail Conflict "execution is unfinished"
                 in
                 if not (String.equal expected (capture_digest capture))
                 then Json.fail Conflict "execution capture changed";
                 let saved = Filename.concat plan.directory "publication.json" in
                 (match Eio.Path.kind ~follow:false Eio.Path.(fs / saved) with
                  | `Not_found -> ()
                  | _ ->
                    Json.fail
                      Conflict
                      "external publication intent exists; inspect and explicitly \
                       associate it")
               | External { intent_digest } ->
                 let bytes = intent_bytes ~fs ~directory:plan.directory in
                 if not (String.equal intent_digest (Json.hash bytes))
                 then Json.fail Idempotency_conflict "external intent changed"))
        |> Disk.unwrap;
        let job =
          { Job.plan
          ; input_hash
          ; revision = 1
          ; intent = None
          ; state =
              Saving_local
                (Problem.create
                   Local_io
                   "finish saving this exact local binding before sending")
          ; diagnostic = None
          }
        in
        put t job;
        job
    in
    match job.state with
    | Job.Prepared_unsent | Running _ | Published _ | Outcome_unknown _ -> job
    | Saving_local _ | Failed_unsent _ ->
      (match materialize t plan with
       | Error diagnostic ->
         let job = next job (Saving_local diagnostic) (Some diagnostic) in
         put t job;
         job
       | Ok bytes ->
         let state =
           match plan.origin with
           | Plan.New _ -> Job.Prepared_unsent
           | External _ ->
             Outcome_unknown
               (Problem.create
                  Outcome_unknown
                  "external intent may already have been sent; association performs no \
                   I/O; explicitly recover receipts or retry the exact request")
         in
         let job = next job state None in
         let job = { job with Job.intent = Some bytes } in
         put t job;
         job))
;;

let inspect t ~id =
  locked t (fun () ->
    synchronize t;
    lookup t id)
;;

let list t ~offset ~limit =
  locked t (fun () ->
    synchronize t;
    if offset < 0 || limit < 1 || limit > 25
    then
      Json.fail Invalid_argument "execution list uses nonnegative offset and limit1..25";
    let jobs = Map.data t.jobs in
    let selected = List.take (List.drop jobs offset) limit in
    let next_offset = offset + List.length selected in
    Json.obj
      [ "items", `Array (List.map selected ~f:Job.summary)
      ; "total", Json.int (List.length jobs)
      ; ( "next_offset"
        , if next_offset < List.length jobs then Json.int next_offset else `Null )
      ])
;;

let record t id state diagnostic =
  locked t (fun () ->
    let job = next (lookup t id) state diagnostic in
    put t job;
    job)
;;

let fence t id diagnostic =
  locked t (fun () ->
    let job = lookup t id in
    let job = next job (uncertainty job diagnostic) (Some diagnostic) in
    put t job;
    job)
;;

let classify_link problem =
  match problem.Problem.kind with
  | Outcome_unknown | Local_io | Storage_unavailable -> Job.Unknown (Some problem)
  | Invalid_argument
  | Not_found
  | Conflict
  | Blocked
  | Dependency_cycle
  | Already_claimed
  | Stale_claim
  | Idempotency_conflict
  | Corrupt_store
  | Workspace_closed
  | Unsupported_version -> Job.Rejected problem
;;

let receipt ~fs client request =
  let open Result.Let_syntax in
  let%bind entry = Request_journal.Entry.create request ~fs in
  let%bind lookup = Acknowledgement.receipt_request entry in
  let%bind raw = Client.invoke client lookup in
  let%bind response = Api_response.of_json raw in
  Acknowledgement.receipt request ~entry ~response
;;

let recover_state ~fs client job native =
  let open Result.Let_syntax in
  let%bind received = receipt ~fs client (Transfer.Upload_plan.finish_request native) in
  let%bind publication =
    match received with
    | Some (Acknowledgement.Committed response) ->
      Json.decode (fun () -> Some (validate_publication native response))
    | Some (Observed _) ->
      Error (Problem.create Outcome_unknown "finish receipt is not durable")
    | None ->
      Ok (Option.map (prior job.Job.state) ~f:(fun known -> known.Job.publication))
  in
  match publication with
  | None -> Ok job.state
  | Some publication ->
    let%bind link_request = Transfer.Upload_plan.link_request native ~publication in
    (match link_request with
     | None -> Ok (Job.Published { publication; link = Not_requested })
     | Some request ->
       let old =
         Option.bind (prior job.state) ~f:(fun known ->
           match known.link with
           | Linked response -> Some response
           | Not_requested | Rejected _ | Unknown _ -> None)
       in
       let link =
         match receipt ~fs client request with
         | Ok (Some (Committed response)) -> Job.Linked response
         | Ok (Some (Observed _)) ->
           Job.Unknown
             (Some (Problem.create Outcome_unknown "link receipt is not durable"))
         | Ok None -> Job.Unknown None
         | Error error -> Job.Unknown (Some error)
       in
       Ok
         (Job.Published
            { publication
            ; link =
                (match old with
                 | Some response -> Linked response
                 | None -> link)
            }))
;;

let publish t id client value native =
  let fs = Eio.Stdenv.fs t.env in
  let resource =
    match prior value.Job.state with
    | Some known -> Ok known.Job.publication
    | None ->
      Eio.Domain_manager.run (Eio.Stdenv.domain_mgr t.env) (fun () ->
        Transfer.upload_publication native ~client ~fs)
      |> Result.bind ~f:(fun raw ->
        Json.decode (fun () ->
          Api_response.of_json raw |> Disk.unwrap |> validate_publication native))
  in
  Result.bind resource ~f:(fun publication ->
    let link_request = Transfer.Upload_plan.link_request native ~publication in
    Result.bind link_request ~f:(fun request ->
      let previous_link =
        Option.map (prior value.state) ~f:(fun known -> known.Job.link)
      in
      let link =
        match request, previous_link with
        | None, _ -> Job.Not_requested
        | Some _, Some (Linked response) -> Job.Linked response
        | Some _, (None | Some (Not_requested | Rejected _ | Unknown _)) ->
          Job.Unknown None
      in
      (* Publish resource knowledge before a separate link can be attempted. A
         timeout, disconnect, process restart or failed link retains this fact. *)
      let known = { Job.publication; link } in
      let phase =
        match request, link with
        | Some _, (Job.Not_requested | Rejected _ | Unknown _) -> Job.Running (Some known)
        | None, _ | Some _, Linked _ -> Job.Published known
      in
      Result.bind (record t id phase None) ~f:(fun _ ->
        match request, link with
        | None, _ | Some _, Job.Linked _ -> Ok ()
        | Some request, (Not_requested | Rejected _ | Unknown _) ->
          let result =
            Eio.Domain_manager.run (Eio.Stdenv.domain_mgr t.env) (fun () ->
              Client.invoke client request)
          in
          let link =
            match result with
            | Error error -> classify_link error
            | Ok raw ->
              (match
                 Api_response.of_json raw
                 |> Result.bind ~f:(fun response ->
                   Acknowledgement.validate request ~response
                   |> Result.bind ~f:(function
                     | Committed _ -> Ok response
                     | Observed _ ->
                       Error (Problem.create Outcome_unknown "ticket link is not durable")))
               with
               | Ok response -> Job.Linked response
               | Error error -> Job.Unknown (Some error))
          in
          record t id (Job.Published { publication; link }) None |> Result.map ~f:ignore)))
;;

let eligible state invocation =
  match invocation, state with
  | Start, Job.Prepared_unsent
  | Retry, Outcome_unknown _
  | Retry, Published { link = Unknown _ | Rejected _; _ }
  | Recover, (Prepared_unsent | Outcome_unknown _ | Published _) -> true
  | (Start | Retry | Recover), (Saving_local _ | Running _ | Failed_unsent _)
  | (Start | Retry), (Prepared_unsent | Outcome_unknown _ | Published _) -> false
;;

let run t id kind =
  let launched =
    locked t (fun () ->
      synchronize t;
      let value = lookup t id in
      match t.flight with
      | Some flight
        when Operation.Id.equal flight.id id && equal_invocation flight.kind kind ->
        `Flight flight
      | Some _ -> Json.fail Blocked "one local evidence publication invocation is active"
      | None when not (eligible value.state kind) -> `Terminal value
      | None ->
        let admitted, admit = Eio.Promise.create () in
        let flight = { id; kind; admitted } in
        t.flight <- Some flight;
        Eio.Fiber.fork ~sw:t.sw (fun () ->
          let settled = ref false in
          let settle result =
            if not !settled
            then (
              settled := true;
              Eio.Promise.resolve admit result)
          in
          let started = ref false in
          Exn.protect
            ~finally:(fun () -> t.flight <- None)
            ~f:(fun () ->
              try
                let result =
                  Eio.Time.Timeout.run_exn
                    (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock t.env) 300.)
                    (fun () ->
                       let client = t.client value.plan.connection |> Disk.unwrap in
                       Daemon_qualification.check t.qualification client |> Disk.unwrap;
                       let fs = Eio.Stdenv.fs t.env in
                       let native =
                         match value.intent with
                         | None -> Json.fail Corrupt_store "execution intent is missing"
                         | Some bytes ->
                           native_plan ~fs ~directory:value.plan.directory bytes
                       in
                       (* Recovery never consults or recaptures stage/source bytes. The
                     saved request and exact receipts are the authority here. *)
                       match kind with
                       | Recover ->
                         (match
                            Eio.Domain_manager.run
                              (Eio.Stdenv.domain_mgr t.env)
                              (fun () -> recover_state ~fs client value native)
                          with
                          | Ok state ->
                            ignore (record t id state None |> Disk.unwrap : Job.t);
                            settle (Ok ())
                          | Error error ->
                            ignore
                              (record t id value.state (Some error) |> Disk.unwrap
                               : Job.t);
                            settle (Error error))
                       | Start | Retry ->
                         (* Check original saved bytes immediately before the durable
                       send barrier. No changed file or implicit replacement. *)
                         let checked =
                           Eio.Domain_manager.run (Eio.Stdenv.domain_mgr t.env) (fun () ->
                             Local_file.protect
                               ~operation:"verify execution retry intent"
                               ~path:value.plan.directory
                               (fun () ->
                                  let bytes =
                                    intent_bytes ~fs ~directory:value.plan.directory
                                  in
                                  if
                                    not
                                      (Option.value_map
                                         value.intent
                                         ~default:false
                                         ~f:(String.equal bytes))
                                  then
                                    Json.fail
                                      Idempotency_conflict
                                      "saved execution intent changed; refusing send"))
                         in
                         Disk.unwrap checked;
                         started := true;
                         ignore
                           (record t id (Job.Running (prior value.state)) None
                            |> Disk.unwrap
                            : Job.t);
                         settle (Ok ());
                         (match publish t id client value native with
                          | Ok () -> ()
                          | Error error ->
                            ignore (fence t id error |> Disk.unwrap : Job.t)))
                in
                settle (Ok result)
              with
              | Json.Decode_error error ->
                if !started then ignore (fence t id error : (Job.t, Problem.t) Result.t);
                settle (Error error)
              | Eio.Time.Timeout ->
                let error =
                  Problem.create
                    Outcome_unknown
                    "local evidence invocation reached its absolute 300s deadline; \
                     retain the exact saved intent"
                in
                if !started then ignore (fence t id error : (Job.t, Problem.t) Result.t);
                settle (Error error)
              | exn ->
                let backtrace = Stdlib.Printexc.get_raw_backtrace () in
                let diagnostic =
                  Problem.create
                    Outcome_unknown
                    "local evidence invocation interrupted; exact saved identity retained"
                in
                if !started
                then
                  Eio.Cancel.protect (fun () ->
                    ignore (fence t id diagnostic : (Job.t, Problem.t) Result.t));
                settle (Error diagnostic);
                Exn.raise_with_original_backtrace exn backtrace));
        `Flight flight)
  in
  match launched with
  | Error error -> Error error
  | Ok (`Terminal value) -> Ok value
  | Ok (`Flight flight) ->
    (match Eio.Promise.await flight.admitted with
     | Error error -> Error error
     | Ok () -> inspect t ~id)
;;

let start t ~id = run t id Start
let retry_exact t ~id = run t id Retry
let recover t ~id = run t id Recover

let cleanup t ~directory ~owner_token =
  isolated t (fun () ->
    Local_file.protect ~operation:"clean owned execution stage" ~path:directory (fun () ->
      path directory;
      Execution_stage.cleanup ~fs:(Eio.Stdenv.fs t.env) ~directory ~owner_token
      |> Disk.unwrap))
;;
