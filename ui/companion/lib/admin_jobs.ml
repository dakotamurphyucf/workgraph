open Core
open Workgraph

let boolean value = Api_codec.decode Api_codec.boolean value |> Disk.unwrap

module Plan = struct
  type action =
    | Migrate_0_6_2 of
        { source : string
        ; destination : string
        }
    | Cleanup_stage of
        { stage : string
        ; owner_token : string
        }

  type t =
    { intention_id : Operation.Id.t
    ; context : Daemon_launcher.Context.t
    ; action : action
    }

  let validate_path path =
    Disk.absolute path;
    if String.length path > 65536
    then Json.fail Invalid_argument "host path exceeds 64KiB"
  ;;

  let create ~intention_id ~context ~action =
    Json.decode (fun () ->
      (match action with
       | Migrate_0_6_2 { source; destination } ->
         validate_path source;
         validate_path destination;
         if String.equal source destination
         then Json.fail Invalid_argument "migration requires a fresh distinct destination"
       | Cleanup_stage { stage; owner_token } ->
         validate_path stage;
         if
           String.length owner_token <> 64
           || not
                (String.for_all owner_token ~f:(fun c ->
                   Char.is_digit c || Char.between c ~low:'a' ~high:'f'))
         then
           Json.fail
             Invalid_argument
             "cleanup requires the exact 64-character owner token");
      { intention_id; context; action })
  ;;

  let action_json = function
    | Migrate_0_6_2 { source; destination } ->
      Json.obj
        [ "kind", Json.string "migrate_0_6_2"
        ; "source", Json.string source
        ; "destination", Json.string destination
        ]
    | Cleanup_stage { stage; owner_token } ->
      Json.obj
        [ "kind", Json.string "cleanup_stage"
        ; "stage", Json.string stage
        ; "owner_token", Json.string owner_token
        ]
  ;;

  let to_json t =
    Json.obj
      [ "intention_id", Operation.Id.jsonaf_of_t t.intention_id
      ; "context", Daemon_launcher.Context.to_json t.context
      ; "action", action_json t.action
      ]
  ;;

  let hash t = Json.hash (Json.canonical (to_json t))

  let of_json value =
    Json.decode (fun () ->
      Json.fields value ~allowed:[ "intention_id"; "context"; "action" ];
      let action = Json.field value "action" in
      let text name = Json.field action name |> Json.text in
      let action =
        match text "kind" with
        | "migrate_0_6_2" ->
          Json.fields action ~allowed:[ "kind"; "source"; "destination" ];
          Migrate_0_6_2 { source = text "source"; destination = text "destination" }
        | "cleanup_stage" ->
          Json.fields action ~allowed:[ "kind"; "stage"; "owner_token" ];
          Cleanup_stage { stage = text "stage"; owner_token = text "owner_token" }
        | _ -> Json.fail Invalid_argument "unknown fixed administration helper"
      in
      create
        ~intention_id:(Operation.Id.t_of_jsonaf (Json.field value "intention_id"))
        ~context:
          (Daemon_launcher.Context.of_json (Json.field value "context") |> Disk.unwrap)
        ~action
      |> Disk.unwrap)
  ;;
end

module Job = struct
  type report =
    { path : string
    ; sha256 : string
    ; byte_count : int
    }

  type state =
    | Prepared_unsent
    | Running
    | Canceled_unsent
    | Succeeded of
        { summary : Jsonaf.t
        ; report : report option
        }
    | Failed of Problem.t
    | Outcome_unknown of Problem.t

  type t =
    { plan : Plan.t
    ; execution_action : Plan.action
    ; revision : int
    ; cancel_requested : bool
    ; state : state
    ; diagnostic : Problem.t option
    }

  let report_json r =
    Json.obj
      [ "path", Json.string r.path
      ; "sha256", Json.string r.sha256
      ; "byte_count", Json.int r.byte_count
      ]
  ;;

  let state_json = function
    | Prepared_unsent -> Json.obj [ "status", Json.string "prepared_unsent" ]
    | Running -> Json.obj [ "status", Json.string "running" ]
    | Canceled_unsent -> Json.obj [ "status", Json.string "canceled_unsent" ]
    | Failed p ->
      Json.obj [ "status", Json.string "failed"; "problem", Problem.to_json p ]
    | Outcome_unknown p ->
      Json.obj [ "status", Json.string "outcome_unknown"; "problem", Problem.to_json p ]
    | Succeeded { summary; report } ->
      Json.obj
        [ "status", Json.string "succeeded"
        ; "summary", summary
        ; "report", Option.value_map report ~default:`Null ~f:report_json
        ]
  ;;

  let hash t =
    Json.hash
      (Json.canonical
         (Json.obj
            [ "plan", Plan.to_json t.plan
            ; "execution_action", Plan.action_json t.execution_action
            ]))
  ;;

  let to_json t =
    Json.obj
      [ "plan", Plan.to_json t.plan
      ; "execution_action", Plan.action_json t.execution_action
      ; "input_hash", Json.string (hash t)
      ; "revision", Json.int t.revision
      ; ("cancel_requested", if t.cancel_requested then `True else `False)
      ; "state", state_json t.state
      ; "diagnostic", Option.value_map t.diagnostic ~default:`Null ~f:Problem.to_json
      ]
  ;;

  let storage t = Json.obj [ "format", Json.string "ui-admin-job-1"; "job", to_json t ]

  let next t ~state ~cancel_requested ~diagnostic =
    if Int.equal t.revision Int.max_value
    then Json.fail Corrupt_store "administration job revision exhausted";
    { t with revision = t.revision + 1; state; cancel_requested; diagnostic }
  ;;

  let digest value =
    let text = Json.text value in
    Session_event.Blob_ref.create ~digest:text ~size_bytes:0 |> Disk.unwrap |> ignore;
    text
  ;;

  let validate_summary action summary =
    let text name = Json.field summary name |> Json.text in
    match action with
    | Plan.Cleanup_stage { stage; _ } ->
      Json.fields summary ~allowed:[ "kind"; "stage" ];
      if not (String.equal (text "kind") "cleaned" && String.equal (text "stage") stage)
      then Json.fail Corrupt_store "cleanup result does not match saved stage"
    | Migrate_0_6_2 { source; destination } ->
      Json.fields
        summary
        ~allowed:
          [ "workspace_id"
          ; "source"
          ; "destination"
          ; "planning_revision"
          ; "planning_head"
          ; "source_history_head"
          ; "history_head"
          ; "from_release"
          ; "source_format"
          ; "source_history_format"
          ; "register_in_fresh_registry"
          ; "old_api_requests_supported"
          ; "history_head_count"
          ];
      Id.Workspace.t_of_jsonaf (Json.field summary "workspace_id") |> ignore;
      Plan.validate_path (text "source");
      Plan.validate_path (text "destination");
      if
        not
          (String.equal (text "source") source
           && String.equal (text "destination") destination)
      then
        Json.fail
          Corrupt_store
          "migration result differs from captured canonical execution paths";
      let revision = Json.field summary "planning_revision" |> Json.integer in
      let count = Json.field summary "history_head_count" |> Json.integer in
      if revision > 100_000 || count > 1_000_000
      then Json.fail Corrupt_store "migration result count exceeds native capacity";
      let optional_digest name =
        match Json.field summary name with
        | `Null -> None
        | value -> Some (digest value)
      in
      let head = optional_digest "planning_head" in
      if Bool.(Int.equal revision 0 <> Option.is_none head)
      then Json.fail Corrupt_store "migration revision/head mismatch";
      let source_head = optional_digest "source_history_head" in
      let target_head = optional_digest "history_head" in
      if
        Bool.(Option.is_none source_head <> Option.is_none target_head)
        || Bool.(Int.equal count 0 <> Option.is_none source_head)
      then Json.fail Corrupt_store "migration history mapping mismatch";
      if
        not
          (String.equal (text "from_release") "0.6.2"
           && String.equal (text "source_format") "5"
           && String.equal (text "source_history_format") "1"
           && boolean (Json.field summary "register_in_fresh_registry")
           && not (boolean (Json.field summary "old_api_requests_supported")))
      then Json.fail Corrupt_store "invalid migration source/result flags"
  ;;

  let of_storage value =
    Json.decode (fun () ->
      Json.fields value ~allowed:[ "format"; "job" ];
      if not (String.equal (Json.field value "format" |> Json.text) "ui-admin-job-1")
      then Json.fail Unsupported_version "unsupported administration job format";
      let value = Json.field value "job" in
      Json.fields
        value
        ~allowed:
          [ "plan"
          ; "execution_action"
          ; "input_hash"
          ; "revision"
          ; "cancel_requested"
          ; "state"
          ; "diagnostic"
          ];
      let plan = Plan.of_json (Json.field value "plan") |> Disk.unwrap in
      let execution_plan =
        match Plan.to_json plan with
        | `Object fields ->
          Plan.of_json
            (Json.obj
               (List.map fields ~f:(fun (key, original) ->
                  ( key
                  , if String.equal key "action"
                    then Json.field value "execution_action"
                    else original ))))
          |> Disk.unwrap
        | _ -> assert false
      in
      let execution_action = execution_plan.Plan.action in
      (match plan.action, execution_action with
       | Migrate_0_6_2 _, Migrate_0_6_2 _ -> ()
       | ( Cleanup_stage { owner_token = original; _ }
         , Cleanup_stage { owner_token = captured; _ } ) ->
         if not (String.equal original captured)
         then Json.fail Corrupt_store "cleanup execution token changed"
       | Migrate_0_6_2 _, Cleanup_stage _ | Cleanup_stage _, Migrate_0_6_2 _ ->
         Json.fail Corrupt_store "execution helper differs from captured plan");
      let revision = Json.field value "revision" |> Json.integer in
      if revision < 1
      then Json.fail Corrupt_store "administration revision must be positive";
      let cancel_requested = Json.field value "cancel_requested" |> boolean in
      let state = Json.field value "state" in
      let problem () = Problem_wire.of_json (Json.field state "problem") |> Disk.unwrap in
      let state =
        match Json.field state "status" |> Json.text with
        | "prepared_unsent" ->
          Json.fields state ~allowed:[ "status" ];
          Prepared_unsent
        | "running" ->
          Json.fields state ~allowed:[ "status" ];
          Running
        | "canceled_unsent" ->
          Json.fields state ~allowed:[ "status" ];
          Canceled_unsent
        | "failed" ->
          Json.fields state ~allowed:[ "status"; "problem" ];
          Failed (problem ())
        | "outcome_unknown" ->
          Json.fields state ~allowed:[ "status"; "problem" ];
          Outcome_unknown (problem ())
        | "succeeded" ->
          Json.fields state ~allowed:[ "status"; "summary"; "report" ];
          let summary = Json.field state "summary" in
          validate_summary execution_action summary;
          let report =
            match Json.field state "report" with
            | `Null -> None
            | r ->
              Json.fields r ~allowed:[ "path"; "sha256"; "byte_count" ];
              let path = Json.field r "path" |> Json.text in
              Plan.validate_path path;
              let byte_count = Json.field r "byte_count" |> Json.integer in
              if byte_count < 1 || byte_count > 256 * 1024 * 1024
              then
                Json.fail
                  Corrupt_store
                  "helper report bytes outside admitted native capacity";
              Some { path; sha256 = digest (Json.field r "sha256"); byte_count }
          in
          Succeeded { summary; report }
        | _ -> Json.fail Corrupt_store "unknown administration job state"
      in
      let diagnostic =
        match Json.field value "diagnostic" with
        | `Null -> None
        | p -> Some (Problem_wire.of_json p |> Disk.unwrap)
      in
      (match state with
       | Prepared_unsent when cancel_requested ->
         Json.fail Corrupt_store "unsent preparation cannot carry cancellation"
       | Canceled_unsent when not cancel_requested ->
         Json.fail Corrupt_store "unsent cancellation flag missing"
       | Prepared_unsent
       | Canceled_unsent
       | Running
       | Succeeded _
       | Failed _
       | Outcome_unknown _ -> ());
      let job =
        { plan; execution_action; revision; cancel_requested; state; diagnostic }
      in
      if not (String.equal (digest (Json.field value "input_hash")) (hash job))
      then Json.fail Corrupt_store "administration input hash mismatch";
      (match state, diagnostic with
       | Succeeded { report = None; _ }, None ->
         Json.fail Corrupt_store "missing report requires publication diagnostic"
       | _ -> ());
      job)
  ;;
end

type entry =
  { mutable job : Job.t
  ; mutable published : bool
  ; mutable dirty : bool
  }

type flight =
  { promise : (Job.t, Problem.t) Result.t Eio.Promise.t
  ; mutable cancellation : Eio.Cancel.t option
  ; mutable cancellation_authorized : bool
  }

type t =
  { sw : Eio.Switch.t
  ; env : Eio_unix.Stdenv.base
  ; root : State_root.t
  ; mutex : Eio.Mutex.t
  ; mutable entries : entry Operation.Id.Map.t
  ; mutable flight : (Operation.Id.t * flight) option
  ; mutable journal_reads : int
  }

let name id = "admin-" ^ Operation.Id.to_string id ^ ".json"
let report_name id = "admin-report-" ^ Operation.Id.to_string id ^ ".data"

let save t job =
  State_root.save t.root ~name:(name job.Job.plan.intention_id) ~value:(Job.storage job)
;;

let locked t f = Eio.Mutex.use_rw ~protect:true t.mutex f

let find t id =
  match Map.find t.entries id with
  | None -> Json.fail Not_found "administration job not found"
  | Some entry -> entry
;;

let create ~sw ~env ~root =
  Disk.protect (fun () ->
    let t =
      { sw
      ; env
      ; root
      ; mutex = Eio.Mutex.create ()
      ; entries = Operation.Id.Map.empty
      ; flight = None
      ; journal_reads = 0
      }
    in
    List.iter
      (State_root.names root |> Disk.unwrap)
      ~f:(fun filename ->
        if String.is_prefix filename ~prefix:"admin-"
        then (
          if Map.length t.entries >= 100
          then Json.fail Corrupt_store "administration job retention exceeds 100";
          let job =
            State_root.read root ~name:filename
            |> Disk.unwrap
            |> Option.value_exn
            |> Job.of_storage
            |> Disk.unwrap
          in
          let id = job.plan.intention_id in
          if (not (String.equal filename (name id))) || Map.mem t.entries id
          then Json.fail Corrupt_store "administration filename/identity mismatch";
          (match job.state with
           | Succeeded { report = Some report; _ } ->
             let expected = Filename.concat (State_root.path root) (report_name id) in
             if not (String.equal expected report.path)
             then Json.fail Corrupt_store "administration report path mismatch"
           | Prepared_unsent | Running | Canceled_unsent
           | Succeeded { report = None; _ }
           | Failed _ | Outcome_unknown _ -> ());
          let job =
            match job.state with
            | Running ->
              Job.next
                job
                ~state:
                  (Outcome_unknown
                     (Problem.create
                        Outcome_unknown
                        "companion restarted after helper admission; inspect \
                         source/destination and report; no automatic retry"))
                ~cancel_requested:job.cancel_requested
                ~diagnostic:job.diagnostic
            | Prepared_unsent
            | Canceled_unsent
            | Succeeded _
            | Failed _
            | Outcome_unknown _ -> job
          in
          let job =
            match job.state with
            | Job.Succeeded { report = Some report; _ } ->
              let fs = Eio.Stdenv.fs env in
              let verified =
                Eio.Domain_manager.run (Eio.Stdenv.domain_mgr env) (fun () ->
                  Disk.protect (fun () ->
                    let bytes =
                      Disk.read_with_limit
                        Eio.Path.(fs / report.path)
                        ~max_bytes:report.byte_count
                    in
                    if
                      String.length bytes <> report.byte_count
                      || not (String.equal (Json.hash bytes) report.sha256)
                    then
                      Json.fail
                        Corrupt_store
                        "published administration report bytes/hash differ from saved \
                         record"))
              in
              (match verified with
               | Ok () -> job
               | Error diagnostic ->
                 if
                   Option.exists job.diagnostic ~f:(fun prior ->
                     String.equal
                       (Json.canonical (Problem.to_json prior))
                       (Json.canonical (Problem.to_json diagnostic)))
                 then job
                 else
                   Job.next
                     job
                     ~state:job.state
                     ~cancel_requested:job.cancel_requested
                     ~diagnostic:(Some diagnostic))
            | Prepared_unsent | Running | Canceled_unsent
            | Succeeded { report = None; _ }
            | Failed _ | Outcome_unknown _ -> job
          in
          save t job |> Disk.unwrap;
          t.entries
          <- Map.set t.entries ~key:id ~data:{ job; published = true; dirty = false }));
    t)
;;

let normalized = function
  | Plan.Migrate_0_6_2 { source; destination } ->
    let source = Platform.realpath source in
    let parent = Platform.realpath (Filename.dirname destination) in
    let basename = Filename.basename destination in
    if List.mem [ ""; "."; ".." ] basename ~equal:String.equal
    then Json.fail Invalid_argument "migration requires a named destination";
    Plan.Migrate_0_6_2 { source; destination = Filename.concat parent basename }
  | Cleanup_stage { stage; owner_token } ->
    Cleanup_stage { stage = Platform.realpath stage; owner_token }
;;

let synchronize t entry =
  entry.dirty <- true;
  match save t entry.job with
  | Ok () ->
    entry.dirty <- false;
    Ok ()
  | Error diagnostic ->
    entry.job
    <- Job.next
         entry.job
         ~state:entry.job.state
         ~cancel_requested:entry.job.cancel_requested
         ~diagnostic:(Some diagnostic);
    Error diagnostic
;;

let prepare t plan =
  locked t (fun () ->
    Json.decode (fun () ->
      let id = plan.Plan.intention_id in
      match Map.find t.entries id with
      | Some entry ->
        if not (String.equal (Plan.hash entry.job.plan) (Plan.hash plan))
        then
          Json.fail
            Idempotency_conflict
            "administration identity already captures different input";
        if (not entry.published) || entry.dirty
        then (
          synchronize t entry |> Disk.unwrap;
          entry.published <- true);
        entry.job
      | None ->
        if Map.length t.entries >= 100
        then
          Json.fail
            Blocked
            "100 retained administration jobs; use another private state root";
        let execution_action = normalized plan.action in
        let job =
          { Job.plan
          ; execution_action
          ; revision = 1
          ; cancel_requested = false
          ; state = Prepared_unsent
          ; diagnostic = None
          }
        in
        let entry = { job; published = false; dirty = true } in
        t.entries <- Map.set t.entries ~key:id ~data:entry;
        synchronize t entry |> Disk.unwrap;
        entry.published <- true;
        job))
;;

let inspect t ~intention_id =
  Json.decode (fun () ->
    let entry = find t intention_id in
    if not entry.published
    then Json.fail Conflict "administration preparation is not durably published";
    entry.job)
;;

let list t ~offset ~limit =
  Json.decode (fun () ->
    if offset < 0 || limit < 1 || limit > 100
    then
      Json.fail
        Invalid_argument
        "administration list requires nonnegative offset and limit1..100";
    let entries = Map.data t.entries |> List.filter ~f:(fun e -> e.published) in
    let selected = List.take (List.drop entries offset) limit in
    let remaining = Int.max 0 (List.length entries - offset - List.length selected) in
    Json.obj
      [ "items", `Array (List.map selected ~f:(fun e -> Job.to_json e.job))
      ; "offset", Json.int offset
      ; "remaining", Json.int remaining
      ; ( "next_offset"
        , if remaining = 0 then `Null else Json.int (offset + List.length selected) )
      ])
;;

let observed t entry state diagnostic =
  locked t (fun () ->
    let job =
      Job.next entry.job ~state ~cancel_requested:entry.job.cancel_requested ~diagnostic
    in
    entry.job <- job;
    ignore (synchronize t entry : (unit, Problem.t) Result.t);
    entry.job)
;;

exception Requested_cancel

let run_helper t plan execution_action seed =
  let fs = Eio.Stdenv.fs t.env in
  let report_path =
    Filename.concat (State_root.path t.root) (report_name plan.Plan.intention_id)
  in
  (* Only immutable plan/paths and filesystem capability cross the domain boundary.
     Metadata, cancellation context and shared random provider stay in their owner. *)
  Eio.Domain_manager.run (Eio.Stdenv.domain_mgr t.env) (fun () ->
    Eio.Switch.run (fun sw ->
      let result =
        match execution_action with
        | Plan.Migrate_0_6_2 { source; destination } ->
          Result.map
            (Migration.run
               ~sw
               ~fs
               ~random:(Eio.Flow.string_source seed)
               ~source
               ~destination)
            ~f:Migration.to_json
        | Cleanup_stage { stage; owner_token } ->
          Result.map (Migration.cleanup ~fs ~stage ~owner_token) ~f:(fun () ->
            Json.obj [ "kind", Json.string "cleaned"; "stage", Json.string stage ])
      in
      match result with
      | Error problem -> Error problem
      | Ok full ->
        let publication =
          Json.decode (fun () ->
            let summary =
              match execution_action with
              | Cleanup_stage _ -> full
              | Migrate_0_6_2 _ ->
                (match full with
                 | `Object fields ->
                   let mappings =
                     match Json.field full "history_heads" with
                     | `Object fields -> fields
                     | _ -> Json.fail Corrupt_store "migration mappings require object"
                   in
                   Json.obj
                     (("history_head_count", Json.int (List.length mappings))
                      :: List.filter fields ~f:(fun (key, _) ->
                        not (String.equal key "history_heads")))
                 | _ -> assert false)
            in
            Job.validate_summary execution_action summary;
            let bytes = Json.canonical full in
            let report =
              Disk.protect (fun () ->
                Disk.write_new Eio.Path.(fs / report_path) bytes;
                { Job.path = report_path
                ; sha256 = Json.hash bytes
                ; byte_count = String.length bytes
                })
            in
            summary, report)
        in
        Result.map_error publication ~f:(fun problem ->
          Problem.create
            Outcome_unknown
            ("native helper returned success, but result publication/provenance could \
              not be established: "
             ^ problem.message
             ^ "; conversion was not rolled back; inspect captured paths"))))
;;

let start t ~intention_id =
  match t.flight with
  | Some (id, flight) when Operation.Id.equal id intention_id ->
    Eio.Promise.await flight.promise
  | Some _ ->
    Error
      (Problem.create
         Blocked
         "one offline administration helper is already admitted; preparation remains \
          unsent")
  | None ->
    Json.decode (fun () ->
      let current = inspect t ~intention_id |> Disk.unwrap in
      (match current.Job.state with
       | Prepared_unsent -> ()
       | Running | Canceled_unsent | Succeeded _ | Failed _ | Outcome_unknown _ ->
         Json.fail
           Conflict
           "only an unsent prepared local helper may start; inspect existing outcomes \
            and explicitly create a new plan");
      let promise, resolve = Eio.Promise.create () in
      let flight = { promise; cancellation = None; cancellation_authorized = false } in
      t.flight <- Some (intention_id, flight);
      Eio.Fiber.fork ~sw:t.sw (fun () ->
        Exn.protect
          ~finally:(fun () -> t.flight <- None)
          ~f:(fun () ->
            let result =
              Json.decode (fun () ->
                let entry = find t intention_id in
                let running =
                  locked t (fun () ->
                    (match entry.job.state with
                     | Prepared_unsent -> ()
                     | Running
                     | Canceled_unsent
                     | Succeeded _
                     | Failed _
                     | Outcome_unknown _ ->
                       Json.fail Conflict "local preparation changed before admission");
                    let running =
                      Job.next
                        entry.job
                        ~state:Running
                        ~cancel_requested:false
                        ~diagnostic:None
                    in
                    entry.job <- running;
                    (match synchronize t entry with
                     | Ok () -> ()
                     | Error diagnostic ->
                       entry.job
                       <- Job.next
                            running
                            ~state:
                              (Outcome_unknown
                                 (Problem.create
                                    Outcome_unknown
                                    "helper admission sync failed; no invocation \
                                     authorized"))
                            ~cancel_requested:false
                            ~diagnostic:(Some diagnostic);
                       raise (Json.Decode_error diagnostic));
                    running)
                in
                Eio.Promise.resolve resolve (Ok running);
                let result =
                  try
                    Eio.Cancel.sub (fun cancellation ->
                      flight.cancellation <- Some cancellation;
                      (* Unsynchronized metadata may already contain the requested flag.
                         Only the cancellation path's completed durable save authorizes
                         delivery, including when this context is installed later. *)
                      if flight.cancellation_authorized
                      then Eio.Cancel.cancel cancellation Requested_cancel;
                      Eio.Cancel.check cancellation;
                      let seed = Cstruct.create 32 in
                      Eio.Flow.read_exact (Eio.Stdenv.secure_random t.env) seed;
                      run_helper
                        t
                        current.plan
                        current.execution_action
                        (Cstruct.to_string seed))
                  with
                  | Eio.Cancel.Cancelled Requested_cancel ->
                    Error
                      (Problem.create
                         Outcome_unknown
                         "local cancellation requested after admission; publication may \
                          have occurred; inspect exact paths before any new plan")
                in
                flight.cancellation <- None;
                match result with
                | Error problem ->
                  let state =
                    if Problem.equal_kind problem.kind Outcome_unknown
                    then Job.Outcome_unknown problem
                    else Failed problem
                  in
                  observed t entry state None
                | Ok (summary, report) ->
                  let report, diagnostic =
                    match report with
                    | Ok r -> Some r, None
                    | Error p -> None, Some p
                  in
                  observed t entry (Succeeded { summary; report }) diagnostic)
            in
            if not (Eio.Promise.is_resolved promise)
            then Eio.Promise.resolve resolve result));
      Eio.Promise.await promise |> Disk.unwrap)
;;

let cancel t ~intention_id =
  locked t (fun () ->
    Json.decode (fun () ->
      let entry = find t intention_id in
      if not entry.published
      then Json.fail Conflict "administration preparation is not published";
      match entry.job.state with
      | Job.Prepared_unsent ->
        let canceled =
          Job.next
            entry.job
            ~state:Canceled_unsent
            ~cancel_requested:true
            ~diagnostic:None
        in
        entry.job <- canceled;
        synchronize t entry |> Disk.unwrap;
        canceled
      | Running ->
        let requested =
          Job.next
            entry.job
            ~state:Running
            ~cancel_requested:true
            ~diagnostic:entry.job.diagnostic
        in
        entry.job <- requested;
        synchronize t entry |> Disk.unwrap;
        (match t.flight with
         | Some (id, flight) when Operation.Id.equal id intention_id ->
           flight.cancellation_authorized <- true;
           Option.iter flight.cancellation ~f:(fun context ->
             Eio.Cancel.cancel context Requested_cancel)
         | Some _ | None -> ());
        entry.job
      | Canceled_unsent | Succeeded _ | Failed _ | Outcome_unknown _ ->
        if entry.dirty then synchronize t entry |> Disk.unwrap;
        entry.job))
;;

let journal_read t f =
  if t.journal_reads >= 2
  then Error (Problem.create Blocked "two journal inspection reads are already active")
  else (
    t.journal_reads <- t.journal_reads + 1;
    Exn.protect
      ~finally:(fun () -> t.journal_reads <- t.journal_reads - 1)
      ~f:(fun () -> Eio.Domain_manager.run (Eio.Stdenv.domain_mgr t.env) f))
;;

let journal_list t ~directory ~after ~limit ~max_bytes =
  let directory = Option.value directory ~default:(State_root.journal_directory t.root) in
  let fs = Eio.Stdenv.fs t.env in
  journal_read t (fun () ->
    Result.map
      (Request_journal.list directory ~fs ~after ~limit ~max_bytes)
      ~f:Request_journal.Page.to_json)
;;

let journal_inspect t ~path =
  let fs = Eio.Stdenv.fs t.env in
  journal_read t (fun () ->
    Result.map (Request_journal.inspect path ~fs) ~f:Request_journal.Entry.to_json)
;;
