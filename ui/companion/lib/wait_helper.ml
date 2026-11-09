open Core
open Workgraph

(* All mutable entries, admission and random consumption belong to the main Eio
   domain. No metadata or cancellation handle crosses a worker-domain boundary. *)
module Plan = struct
  type t =
    { preparation : Operation.Preparation.t
    ; timeout_ms : int
    ; max_attempts : int
    ; wait_slice_ms : int
    }

  let limits t =
    Reservation_wait.Limits.create
      ~timeout_ms:t.timeout_ms
      ~max_attempts:t.max_attempts
      ~wait_slice_ms:t.wait_slice_ms
    |> Disk.unwrap
  ;;

  let validation_request preparation =
    let params = Operation.Preparation.params preparation in
    let params =
      match Json.optional params "mutation_id", params with
      | None, `Object fields ->
        Json.obj (("mutation_id", Json.string "ui-validation") :: fields)
      | Some _, _ -> params
      | None, _ -> Json.fail Invalid_argument "reservation params require an object"
    in
    Protocol.Request.create
      ~id:"ui-wait-validation"
      ~method_:(Operation.Preparation.method_ preparation)
      ~params
    |> Disk.unwrap
  ;;

  let create ~preparation ~timeout_ms ~max_attempts ~wait_slice_ms =
    Json.decode (fun () ->
      let t = { preparation; timeout_ms; max_attempts; wait_slice_ms } in
      ignore
        (Reservation_wait.create (validation_request preparation) ~limits:(limits t)
         |> Disk.unwrap
         : Reservation_wait.t);
      if
        String.length (Json.canonical (Operation.Preparation.to_json preparation))
        > 262144
      then Json.fail Invalid_argument "wait preparation exceeds 256KiB";
      t)
  ;;

  let id t =
    Operation.Id.of_string (Operation.Preparation.intention_id t.preparation)
    |> Disk.unwrap
  ;;

  let to_json t =
    Json.obj
      [ "preparation", Operation.Preparation.to_json t.preparation
      ; "timeout_ms", Json.int t.timeout_ms
      ; "max_attempts", Json.int t.max_attempts
      ; "wait_slice_ms", Json.int t.wait_slice_ms
      ]
  ;;

  let hash t = Json.hash (Json.canonical (to_json t))

  let of_json value =
    Json.decode (fun () ->
      Json.fields
        value
        ~allowed:[ "preparation"; "timeout_ms"; "max_attempts"; "wait_slice_ms" ];
      create
        ~preparation:
          (Operation.Preparation.of_json (Json.field value "preparation") |> Disk.unwrap)
        ~timeout_ms:(Json.integer (Json.field value "timeout_ms"))
        ~max_attempts:(Json.integer (Json.field value "max_attempts"))
        ~wait_slice_ms:(Json.integer (Json.field value "wait_slice_ms"))
      |> Disk.unwrap)
  ;;
end

module Job = struct
  type attempt =
    { request : Protocol.Request.t
    ; path : string
    ; started : bool
    }

  type state =
    | Prepared_unsent
    | Running
    | Completed of Jsonaf.t
    | Stopped of Jsonaf.t
    | Canceled_unsent
    | Outcome_unknown of Problem.t * Jsonaf.t option

  type t =
    { plan : Plan.t
    ; initial_request : Protocol.Request.t
    ; latest : attempt
    ; attempts : int
    ; journals : attempt list
    ; revision : int
    ; cancel_requested : bool
    ; state : state
    ; diagnostic : Problem.t option
    }

  let attempt_json t =
    Json.obj
      [ "request", Protocol.Request.to_json t.request
      ; "path", Json.string t.path
      ; ("started", if t.started then `True else `False)
      ]
  ;;

  let state_json t =
    let fields =
      match t.state with
      | Prepared_unsent -> [ "kind", Json.string "prepared_unsent" ]
      | Canceled_unsent -> [ "kind", Json.string "canceled_unsent" ]
      | Running ->
        [ "kind", Json.string "running"
        ; "attempts", Json.int t.attempts
        ; "latest_journal", Json.string t.latest.path
        ]
      | Completed outcome -> [ "kind", Json.string "completed"; "outcome", outcome ]
      | Stopped outcome -> [ "kind", Json.string "stopped"; "outcome", outcome ]
      | Outcome_unknown (problem, outcome) ->
        [ "kind", Json.string "outcome_unknown"
        ; "problem", Problem.to_json problem
        ; "exact_journal", Json.string t.latest.path
        ; ("exchange_started", if t.latest.started then `True else `False)
        ; "outcome", Option.value outcome ~default:`Null
        ]
    in
    Json.obj fields
  ;;

  let to_json t =
    Json.obj
      [ "id", Operation.Id.jsonaf_of_t (Plan.id t.plan)
      ; "input_hash", Json.string (Plan.hash t.plan)
      ; "preparation", Operation.Preparation.to_json t.plan.preparation
      ; ( "limits"
        , Json.obj
            [ "timeout_ms", Json.int t.plan.timeout_ms
            ; "max_attempts", Json.int t.plan.max_attempts
            ; "wait_slice_ms", Json.int t.plan.wait_slice_ms
            ] )
      ; "revision", Json.int t.revision
      ; ("cancel_requested", if t.cancel_requested then `True else `False)
      ; "state", state_json t
      ; "diagnostic", Option.value_map t.diagnostic ~default:`Null ~f:Problem.to_json
      ]
  ;;

  let storage t =
    Json.obj
      [ "format", Json.string "workgraph-ui-reservation-wait-1"
      ; "plan", Json.string (Json.canonical (Plan.to_json t.plan))
      ; ( "initial_request"
        , Json.string (Json.canonical (Protocol.Request.to_json t.initial_request)) )
      ; "latest", Json.string (Json.canonical (attempt_json t.latest))
      ; "attempts", Json.int t.attempts
      ; ( "journals"
        , Json.string (Json.canonical (`Array (List.map t.journals ~f:attempt_json))) )
      ; "revision", Json.int t.revision
      ; ("cancel_requested", if t.cancel_requested then `True else `False)
      ; "state", Json.string (Json.canonical (state_json t))
      ; "diagnostic", Option.value_map t.diagnostic ~default:`Null ~f:Problem.to_json
      ]
  ;;

  let next t ~state ~cancel_requested ~diagnostic =
    if Int.equal t.revision Int.max_value
    then Json.fail Corrupt_store "wait job revision exhausted";
    { t with revision = t.revision + 1; state; cancel_requested; diagnostic }
  ;;
end

let boolean value = Api_codec.decode Api_codec.boolean value |> Disk.unwrap
let parse_text value = Json.text value |> Json.parse |> Disk.unwrap
let request_json request = Json.canonical (Protocol.Request.to_json request)
let same_request a b = String.equal (request_json a) (request_json b)

let without_mutation params =
  match params with
  | `Object fields ->
    Json.obj
      (List.filter fields ~f:(fun (name, _) -> not (String.equal name "mutation_id")))
  | _ -> Json.fail Corrupt_store "saved acquisition parameters are not an object"
;;

let validate_request plan request ~initial =
  let method_ = Operation.Preparation.method_ plan.Plan.preparation in
  if not (String.equal (Protocol.Request.method_ request) method_)
  then Json.fail Corrupt_store "wait journal method differs from original preparation";
  let params = Protocol.Request.params request in
  let expected = Operation.Preparation.params plan.preparation in
  if
    not
      (String.equal
         (Json.canonical (without_mutation params))
         (Json.canonical (without_mutation expected)))
  then
    Json.fail
      Corrupt_store
      "wait journal writer/workspace/guards/batch differ from original preparation";
  if initial
  then
    Option.iter (Json.optional expected "mutation_id") ~f:(fun mutation ->
      if
        not
          (String.equal
             (Json.canonical mutation)
             (Json.canonical (Json.field params "mutation_id")))
      then
        Json.fail
          Corrupt_store
          "initial saved mutation differs from explicit preparation identity");
  Reservation_wait.create request ~limits:(Plan.limits plan) |> Disk.unwrap
;;

let journal_path root request =
  Request_journal.path request ~directory:(State_root.journal_directory root)
  |> Disk.unwrap
;;

let validate_outcome job outcome ~completed =
  Json.fields outcome ~allowed:[ "data"; "meta" ];
  let data = Json.field outcome "data" in
  Json.fields data ~allowed:[ "daemon_response"; "wait" ];
  let wait = Json.field data "wait" in
  Json.fields
    wait
    ~allowed:
      [ "completed"
      ; "stop"
      ; "attempt_count"
      ; "journals"
      ; "last_conflict"
      ; "problem"
      ; "feed_response"
      ; "saved_request"
      ; "retry_request"
      ];
  let actual_completed = boolean (Json.field wait "completed") in
  let stop = Json.text (Json.field wait "stop") in
  if
    not
      (Bool.equal completed actual_completed
       && Bool.equal completed (String.equal stop "acquired"))
  then Json.fail Corrupt_store "wait completion contradicts its native outcome";
  if
    not
      (List.mem
         [ "acquired"
         ; "deadline"
         ; "attempt_limit"
         ; "needs_larger_budget"
         ; "no_progress"
         ; "failed"
         ; "uncertain"
         ; "canceled"
         ]
         stop
         ~equal:String.equal)
  then Json.fail Corrupt_store "unknown saved wait stop";
  if
    Json.integer (Json.field wait "attempt_count")
    <> List.count job.Job.journals ~f:(fun journal -> journal.started)
  then Json.fail Corrupt_store "wait attempt count differs from saved journal state";
  let journals = Json.list (Json.field wait "journals") in
  if List.length journals <> List.length job.journals
  then Json.fail Corrupt_store "wait journal reference count mismatch";
  List.iter2_exn journals job.journals ~f:(fun reference saved ->
    Json.fields reference ~allowed:[ "mutation_id"; "saved_request"; "started" ];
    ignore (Id.Mutation.t_of_jsonaf (Json.field reference "mutation_id") : Id.Mutation.t);
    Disk.absolute (Json.text (Json.field reference "saved_request"));
    if
      (not
         (String.equal (Json.text (Json.field reference "saved_request")) saved.Job.path
          && String.equal
               (Json.canonical (Json.field reference "mutation_id"))
               (Json.canonical
                  (Json.field (Protocol.Request.params saved.request) "mutation_id"))))
      || not (Bool.equal (boolean (Json.field reference "started")) saved.started)
    then
      Json.fail
        Corrupt_store
        "wait outcome journal attribution differs from saved history");
  (match Json.field wait "retry_request" with
   | `Null when job.attempts = 0 -> ()
   | value ->
     let request = Protocol.Request.of_json value |> Disk.unwrap in
     if not (same_request request job.latest.request)
     then Json.fail Corrupt_store "wait retry envelope differs from exact latest journal");
  if completed
  then (
    let validated = validate_request job.plan job.initial_request ~initial:true in
    Reservation_wait.validate_grants validated (Json.field data "daemon_response")
    |> Disk.unwrap)
;;

let job_of_storage root value =
  Json.decode (fun () ->
    Json.fields
      value
      ~allowed:
        [ "format"
        ; "plan"
        ; "initial_request"
        ; "latest"
        ; "attempts"
        ; "journals"
        ; "revision"
        ; "cancel_requested"
        ; "state"
        ; "diagnostic"
        ];
    if
      not
        (String.equal
           (Json.text (Json.field value "format"))
           "workgraph-ui-reservation-wait-1")
    then Json.fail Unsupported_version "unsupported wait-helper storage";
    let plan = Plan.of_json (parse_text (Json.field value "plan")) |> Disk.unwrap in
    let initial_request =
      Protocol.Request.of_json (parse_text (Json.field value "initial_request"))
      |> Disk.unwrap
    in
    ignore (validate_request plan initial_request ~initial:true : Reservation_wait.t);
    let latest = parse_text (Json.field value "latest") in
    Json.fields latest ~allowed:[ "request"; "path"; "started" ];
    let request = Protocol.Request.of_json (Json.field latest "request") |> Disk.unwrap in
    ignore (validate_request plan request ~initial:false : Reservation_wait.t);
    (* Request ID/profile are retained as well as every effective parameter.
       Only a fresh mutation identity after definite contention may differ. *)
    let with_initial_mutation =
      match Protocol.Request.params request with
      | `Object fields ->
        Protocol.Request.with_params
          request
          (Json.obj
             (List.Assoc.add
                fields
                ~equal:String.equal
                "mutation_id"
                (Json.field (Protocol.Request.params initial_request) "mutation_id")))
        |> Disk.unwrap
      | _ -> assert false
    in
    if not (same_request with_initial_mutation initial_request)
    then Json.fail Corrupt_store "wait retry changed envelope identity beyond mutation";
    let path = Json.text (Json.field latest "path") in
    if not (String.equal path (journal_path root request))
    then Json.fail Corrupt_store "wait journal path is not the exact private request path";
    Request_journal.sync_existing
      initial_request
      ~fs:(State_root.directory root)
      ~destination:(journal_path root initial_request)
    |> Disk.unwrap;
    Request_journal.sync_existing
      request
      ~fs:(State_root.directory root)
      ~destination:path
    |> Disk.unwrap;
    let latest = { Job.request; path; started = boolean (Json.field latest "started") } in
    let journals =
      parse_text (Json.field value "journals")
      |> Json.list
      |> List.map ~f:(fun value ->
        Json.fields value ~allowed:[ "request"; "path"; "started" ];
        let request =
          Protocol.Request.of_json (Json.field value "request") |> Disk.unwrap
        in
        ignore (validate_request plan request ~initial:false : Reservation_wait.t);
        let path = Json.text (Json.field value "path") in
        if not (String.equal path (journal_path root request))
        then Json.fail Corrupt_store "journal history path mismatch";
        let expected =
          match Protocol.Request.params request with
          | `Object fields ->
            Protocol.Request.with_params
              request
              (Json.obj
                 (List.Assoc.add
                    fields
                    ~equal:String.equal
                    "mutation_id"
                    (Json.field (Protocol.Request.params initial_request) "mutation_id")))
            |> Disk.unwrap
          | _ -> assert false
        in
        if not (same_request expected initial_request)
        then Json.fail Corrupt_store "journal history changed original envelope";
        Request_journal.sync_existing
          request
          ~fs:(State_root.directory root)
          ~destination:path
        |> Disk.unwrap;
        { Job.request; path; started = boolean (Json.field value "started") })
    in
    let attempts = Json.integer (Json.field value "attempts") in
    if
      List.length journals <> attempts
      || List.length
           (List.dedup_and_sort journals ~compare:(fun a b ->
              String.compare a.Job.path b.path))
         <> attempts
    then Json.fail Corrupt_store "journal history count/identity mismatch";
    (match List.last journals with
     | Some last
       when not
              (String.equal
                 (Json.canonical (Job.attempt_json last))
                 (Json.canonical (Job.attempt_json latest))) ->
       Json.fail Corrupt_store "last journal history differs from latest"
     | Some _ | None -> ());
    let revision = Json.integer (Json.field value "revision") in
    if attempts < 0 || attempts > 100 || revision < 1
    then Json.fail Corrupt_store "invalid saved wait counters";
    let cancel_requested = boolean (Json.field value "cancel_requested") in
    let diagnostic =
      match Json.field value "diagnostic" with
      | `Null -> None
      | value -> Some (Problem_wire.of_json value |> Disk.unwrap)
    in
    let state = parse_text (Json.field value "state") in
    let kind = Json.text (Json.field state "kind") in
    let state =
      match kind with
      | "prepared_unsent" ->
        Json.fields state ~allowed:[ "kind" ];
        Job.Prepared_unsent
      | "canceled_unsent" ->
        Json.fields state ~allowed:[ "kind" ];
        Canceled_unsent
      | "running" ->
        Json.fields state ~allowed:[ "kind"; "attempts"; "latest_journal" ];
        if
          Json.integer (Json.field state "attempts") <> attempts
          || not (String.equal (Json.text (Json.field state "latest_journal")) path)
        then Json.fail Corrupt_store "running wait journal metadata disagree";
        Running
      | "completed" | "stopped" ->
        Json.fields state ~allowed:[ "kind"; "outcome" ];
        if String.equal kind "completed"
        then Completed (Json.field state "outcome")
        else Stopped (Json.field state "outcome")
      | "outcome_unknown" ->
        Json.fields
          state
          ~allowed:[ "kind"; "problem"; "exact_journal"; "exchange_started"; "outcome" ];
        if
          not
            (String.equal (Json.text (Json.field state "exact_journal")) path
             && Bool.equal (boolean (Json.field state "exchange_started")) latest.started
            )
        then Json.fail Corrupt_store "uncertain wait journal metadata disagree";
        Outcome_unknown
          ( Problem_wire.of_json (Json.field state "problem") |> Disk.unwrap
          , match Json.field state "outcome" with
            | `Null -> None
            | value -> Some value )
      | _ -> Json.fail Corrupt_store "unknown saved wait state"
    in
    let job =
      { Job.plan
      ; initial_request
      ; latest
      ; attempts
      ; journals
      ; revision
      ; cancel_requested
      ; state
      ; diagnostic
      }
    in
    (match state with
     | Completed outcome -> validate_outcome job outcome ~completed:true
     | Stopped outcome -> validate_outcome job outcome ~completed:false
     | Prepared_unsent | Canceled_unsent ->
       if
         attempts <> 0
         || latest.started
         || not (same_request initial_request latest.request)
       then Json.fail Corrupt_store "unsent wait has evidence of an attempted exchange";
       if
         Bool.equal
           cancel_requested
           (match state with
            | Canceled_unsent -> false
            | _ -> true)
       then Json.fail Corrupt_store "unsent cancellation flag disagrees"
     | Running | Outcome_unknown _ -> ());
    job)
;;

type entry =
  { mutable job : Job.t
  ; mutable published : bool
  ; mutable dirty : bool
  }

type exchange_phase =
  | Idle
  | Reading
  | Writing

type flight =
  { id : Operation.Id.t
  ; promise : (Job.t, Problem.t) Result.t Eio.Promise.t
  ; mutable cancellation : Eio.Cancel.t option
  ; mutable cancellation_authorized : bool
  ; finished : unit Eio.Promise.t
  ; mutable phase : exchange_phase
  ; mutable interrupted_write : bool
  }

type t =
  { sw : Eio.Switch.t
  ; env : Eio_unix.Stdenv.base
  ; root : State_root.t
  ; mutex : Eio.Mutex.t
  ; mutable entries : entry Operation.Id.Map.t
  ; mutable flight : flight option
  }

let name id = "reservation-wait-" ^ Operation.Id.to_string id ^ ".json"
let locked t f = Eio.Mutex.use_rw ~protect:true t.mutex f

let save t job =
  State_root.save t.root ~name:(name (Plan.id job.Job.plan)) ~value:(Job.storage job)
;;

let find t id =
  match Map.find t.entries id with
  | Some entry -> entry
  | None -> Json.fail Not_found "wait job not found"
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

let random t =
  let bytes = Cstruct.create 32 in
  Eio.Flow.read_exact (Eio.Stdenv.secure_random t.env) bytes;
  Json.hash (Cstruct.to_string bytes)
;;

let materialize t plan =
  Protocol.Request.create
    ~id:("ui-wait-" ^ random t)
    ~method_:(Operation.Preparation.method_ plan.Plan.preparation)
    ~params:(Operation.Preparation.params plan.preparation)
  |> Disk.unwrap
  |> fun request ->
  Cli_mutation_identity.ensure
    request
    ~random:(Eio.Stdenv.secure_random t.env)
    ~allow_generate:true
  |> Disk.unwrap
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
      }
    in
    List.iter
      (State_root.names root |> Disk.unwrap)
      ~f:(fun filename ->
        if String.is_prefix filename ~prefix:"reservation-wait-"
        then (
          if Map.length t.entries >= 100
          then Json.fail Corrupt_store "wait job retention exceeds 100";
          let job =
            State_root.read root ~name:filename
            |> Disk.unwrap
            |> Option.value_exn
            |> job_of_storage root
            |> Disk.unwrap
          in
          let id = Plan.id job.plan in
          if (not (String.equal filename (name id))) || Map.mem t.entries id
          then Json.fail Corrupt_store "wait filename/identity mismatch";
          let job =
            match job.state with
            | Job.Running ->
              Job.next
                job
                ~state:
                  (Outcome_unknown
                     ( Problem.create
                         Outcome_unknown
                         "companion restarted after wait admission; exact journal \
                          retained; no automatic retry"
                     , None ))
                ~cancel_requested:job.cancel_requested
                ~diagnostic:job.diagnostic
            | Prepared_unsent
            | Completed _
            | Stopped _
            | Canceled_unsent
            | Outcome_unknown _ -> job
          in
          save t job |> Disk.unwrap;
          t.entries
          <- Map.set t.entries ~key:id ~data:{ job; published = true; dirty = false }));
    t)
;;

let prepare t plan =
  locked t (fun () ->
    Json.decode (fun () ->
      let id = Plan.id plan in
      let entry =
        match Map.find t.entries id with
        | Some entry ->
          if not (String.equal (Plan.hash plan) (Plan.hash entry.job.plan))
          then
            Json.fail
              Idempotency_conflict
              "wait intention already captures different complete inputs";
          entry
        | None ->
          if Map.length t.entries >= 100
          then
            Json.fail Blocked "100 retained wait jobs; choose another private state root";
          let request = materialize t plan in
          ignore (validate_request plan request ~initial:true : Reservation_wait.t);
          let path = journal_path t.root request in
          let job =
            { Job.plan
            ; initial_request = request
            ; latest = { request; path; started = false }
            ; attempts = 0
            ; journals = []
            ; revision = 1
            ; cancel_requested = false
            ; state = Prepared_unsent
            ; diagnostic = None
            }
          in
          let entry = { job; published = false; dirty = true } in
          t.entries <- Map.set t.entries ~key:id ~data:entry;
          entry
      in
      if not entry.published
      then
        Request_journal.save
          entry.job.initial_request
          ~fs:(State_root.directory t.root)
          ~random:(Eio.Stdenv.secure_random t.env)
          ~destination:entry.job.latest.path
        |> Disk.unwrap
        |> ignore;
      if (not entry.published) || entry.dirty then synchronize t entry |> Disk.unwrap;
      entry.published <- true;
      entry.job))
;;

let inspect t ~id =
  locked t (fun () ->
    Json.decode (fun () ->
      let entry = find t id in
      if not entry.published
      then Json.fail Conflict "wait preparation is not durably published";
      entry.job))
;;

let list t ~offset ~limit =
  locked t (fun () ->
    Json.decode (fun () ->
      if offset < 0 || limit < 1 || limit > 100
      then
        Json.fail Invalid_argument "wait list requires nonnegative offset and limit1..100";
      let entries = Map.data t.entries |> List.filter ~f:(fun entry -> entry.published) in
      let selected = List.take (List.drop entries offset) limit in
      let remaining = Int.max 0 (List.length entries - offset - List.length selected) in
      Json.obj
        [ "items", `Array (List.map selected ~f:(fun entry -> Job.to_json entry.job))
        ; "offset", Json.int offset
        ; "remaining", Json.int remaining
        ; ( "next_offset"
          , if remaining = 0 then `Null else Json.int (offset + List.length selected) )
        ]))
;;

exception Requested_cancel

(* A bounded cancellation outcome is a helper-local stop, never a forged daemon
   grant or rejection. The exact last journal and started flag remain separate. *)
let local_stop_outcome job ~stop =
  Json.obj
    [ ( "data"
      , Json.obj
          [ "daemon_response", `Null
          ; ( "wait"
            , Json.obj
                [ "completed", `False
                ; "stop", Json.string stop
                ; ( "attempt_count"
                  , Json.int
                      (List.count job.Job.journals ~f:(fun journal -> journal.started)) )
                ; ( "journals"
                  , `Array
                      (List.map job.journals ~f:(fun journal ->
                         Json.obj
                           [ ( "mutation_id"
                             , Json.field
                                 (Protocol.Request.params journal.Job.request)
                                 "mutation_id" )
                           ; "saved_request", Json.string journal.path
                           ; ("started", if journal.started then `True else `False)
                           ])) )
                ; "last_conflict", `Null
                ; "problem", `Null
                ; "feed_response", `Null
                ; "saved_request", Json.string job.latest.path
                ; "retry_request", Protocol.Request.to_json job.latest.request
                ] )
          ] )
    ; "meta", Json.obj []
    ]
;;

let canceled_outcome job = local_stop_outcome job ~stop:"canceled"

let observed t entry state =
  locked t (fun () ->
    let next =
      Job.next
        entry.job
        ~state
        ~cancel_requested:entry.job.cancel_requested
        ~diagnostic:None
    in
    entry.job <- next;
    ignore (synchronize t entry : (unit, Problem.t) Result.t);
    entry.job)
;;

let check_cancel flight = if flight.cancellation_authorized then raise Requested_cancel

let exchange t flight entry ~timeout_seconds request =
  let write =
    String.equal
      (Protocol.Request.method_ request)
      (Operation.Preparation.method_ entry.job.plan.preparation)
  in
  check_cancel flight;
  if write
  then (
    let admission =
      locked t (fun () ->
        Json.decode (fun () ->
          (* Expected cancellation exits outside use_rw: it must not poison the
           service mutex, which also owns the final stopped publication. *)
          if flight.cancellation_authorized
          then false
          else (
            if not (same_request request entry.job.latest.request)
            then
              Json.fail
                Corrupt_store
                "exchange request differs from synchronized latest journal";
            let job = entry.job in
            entry.job
            <- { (Job.next
                    job
                    ~state:Running
                    ~cancel_requested:job.cancel_requested
                    ~diagnostic:None)
                 with
                 latest = { job.latest with started = true }
               ; journals =
                   (if job.attempts = 0
                    then [ { job.latest with started = true } ]
                    else
                      List.mapi job.journals ~f:(fun index journal ->
                        if index = job.attempts - 1
                        then { journal with started = true }
                        else journal))
               ; attempts = Int.max 1 job.attempts
               };
            synchronize t entry |> Disk.unwrap;
            true)))
    in
    match admission with
    | Error problem -> raise (Json.Decode_error problem)
    | Ok false -> raise Requested_cancel
    | Ok true -> ());
  (* The durable started barrier may itself suspend. A completed cancellation
     still prevents an exchange that has not entered its bounded I/O phase. *)
  check_cancel flight;
  flight.phase <- (if write then Writing else Reading);
  Exn.protect
    ~finally:(fun () -> flight.phase <- Idle)
    ~f:(fun () ->
      let connection = Operation.Preparation.connection entry.job.plan.preparation in
      let client =
        Client.create
          ~net:(Eio.Stdenv.net t.env)
          ~clock:(Eio.Stdenv.mono_clock t.env)
          ~socket:(Connection_profile.socket connection)
          ~timeout_seconds
        |> Disk.unwrap
      in
      match Client.invoke client request with
      | response -> response
      | exception exn ->
        let backtrace = Stdlib.Printexc.get_raw_backtrace () in
        if write then flight.interrupted_write <- true;
        Stdlib.Printexc.raise_with_backtrace exn backtrace)
;;

let collect t flight entry =
  let core = validate_request entry.job.plan entry.job.initial_request ~initial:true in
  let origin = Eio.Time.Mono.now (Eio.Stdenv.mono_clock t.env) in
  let now () =
    Mtime.Span.to_float_ns
      (Mtime.span origin (Eio.Time.Mono.now (Eio.Stdenv.mono_clock t.env)))
    /. 1e9
  in
  let publication_failure = ref None in
  let save request =
    check_cancel flight;
    let saved =
      locked t (fun () ->
        if flight.cancellation_authorized
        then None
        else
          Some
            (Json.decode (fun () ->
               ignore
                 (validate_request entry.job.plan request ~initial:false
                  : Reservation_wait.t);
               let path = journal_path t.root request in
               Request_journal.save
                 request
                 ~fs:(State_root.directory t.root)
                 ~random:(Eio.Stdenv.secure_random t.env)
                 ~destination:path
               |> Disk.unwrap
               |> ignore;
               let job = entry.job in
               if job.attempts >= 100
               then Json.fail Blocked "wait journal bound exhausted";
               entry.job
               <- { (Job.next
                       job
                       ~state:Running
                       ~cancel_requested:job.cancel_requested
                       ~diagnostic:None)
                    with
                    latest = { request; path; started = false }
                  ; attempts = job.attempts + 1
                  ; journals = job.journals @ [ { request; path; started = false } ]
                  };
               (match synchronize t entry with
                | Ok () -> ()
                | Error problem ->
                  (* Core adds its journal only after save returns Ok. Retain our
                     exact newer saved identity, but never persist a core outcome
                     whose journal vector predates that failed publication. *)
                  publication_failure := Some problem;
                  raise (Json.Decode_error problem));
               path)))
    in
    match saved with
    | None -> raise Requested_cancel
    | Some result -> result
  in
  let outcome =
    Reservation_wait.collect
      core
      ~now
      ~max_exchange_seconds:60.
      ~fresh_mutation:(fun () -> Id.Mutation.of_string (random t) |> Disk.unwrap)
      ~save
      ~exchange:(exchange t flight entry)
  in
  match !publication_failure, outcome with
  | Some problem, _ ->
    Job.Outcome_unknown
      ( Problem.create
          Outcome_unknown
          ("wait journal metadata publication failed; retain the exact saved request \
            before any explicit retry: "
           ^ problem.message)
      , None )
  | None, Error problem -> Job.Outcome_unknown (problem, None)
  | None, Ok outcome ->
    let json = Reservation_wait.Outcome.to_json outcome in
    (match Reservation_wait.Outcome.stop outcome with
     | Acquired -> Completed json
     | Uncertain ->
       Outcome_unknown
         ( Problem.create
             Outcome_unknown
             "acquisition outcome is uncertain; inspect the retained exact request \
              before any retry"
         , Some json )
     | Deadline | Attempt_limit | Needs_larger_budget | No_progress | Failed ->
       Stopped json)
;;

(* Exact retry does not reopen the native wait loop, refresh a guard or allocate
   another identity. The saved journal is synchronized again before admission. *)
let retry_once t flight entry =
  let response =
    Json.decode (fun () ->
      exchange t flight entry ~timeout_seconds:60. entry.job.latest.request)
  in
  match response with
  | Error diagnostic ->
    (* Failure to publish a retry's local started barrier cannot resolve the
       original uncertain write. Expected local I/O must not kill the service. *)
    Job.Outcome_unknown
      ( { diagnostic with
          kind = Outcome_unknown
        ; message =
            "exact retry could not publish its local exchange barrier; original outcome \
             remains uncertain: "
            ^ diagnostic.message
        }
      , None )
  | Ok response ->
    (match response with
     | Error problem ->
       if
         Problem.equal_kind problem.kind Outcome_unknown
         || Problem.equal_kind problem.kind Storage_unavailable
       then Job.Outcome_unknown (problem, None)
       else (
         let outcome = canceled_outcome entry.job in
         let data = Json.field outcome "data" in
         let wait = Json.field data "wait" in
         let replace value fields =
           match value with
           | `Object previous ->
             Json.obj
               (List.fold fields ~init:previous ~f:(fun fields (key, value) ->
                  List.Assoc.add fields ~equal:String.equal key value))
           | _ -> assert false
         in
         Job.Stopped
           (replace
              outcome
              [ ( "data"
                , replace
                    data
                    [ ( "wait"
                      , replace
                          wait
                          [ "stop", Json.string "failed"
                          ; "problem", Problem.to_json problem
                          ] )
                    ] )
              ]))
     | Ok response ->
       let core =
         validate_request entry.job.plan entry.job.initial_request ~initial:true
       in
       (match Reservation_wait.validate_grants core response with
        | Error problem -> Outcome_unknown (problem, Some response)
        | Ok () ->
          let outcome = canceled_outcome entry.job in
          let wait = Json.field (Json.field outcome "data") "wait" in
          let fields =
            match wait with
            | `Object fields -> fields
            | _ -> assert false
          in
          let fields =
            List.Assoc.add fields ~equal:String.equal "completed" `True
            |> fun fields ->
            List.Assoc.add fields ~equal:String.equal "stop" (Json.string "acquired")
          in
          Completed
            (Json.obj
               [ "data", Json.obj [ "daemon_response", response; "wait", Json.obj fields ]
               ; "meta", Json.obj []
               ])))
;;

let rec admit t ~id ~retry =
  match t.flight with
  | Some flight when Operation.Id.equal id flight.id ->
    let open Result.Let_syntax in
    let%bind _ = Eio.Promise.await flight.promise in
    let%bind current = inspect t ~id in
    (match current.state with
     | Outcome_unknown _ when retry ->
       Eio.Promise.await flight.finished;
       admit t ~id ~retry
     | (Completed _ | Stopped _ | Canceled_unsent | Prepared_unsent) when retry ->
       Error (Problem.create Conflict "only an uncertain wait permits exact retry")
     | Prepared_unsent
     | Running
     | Completed _
     | Stopped _
     | Canceled_unsent
     | Outcome_unknown _ -> Ok current)
  | Some _ ->
    Error (Problem.create Blocked "one reservation wait or exact retry is already active")
  | None ->
    Json.decode (fun () ->
      let entry = find t id in
      if not entry.published
      then Json.fail Conflict "wait preparation is not durably published";
      let permitted =
        match entry.job.state, retry with
        | Prepared_unsent, false | Outcome_unknown _, true -> true
        | ( ( Prepared_unsent
            | Running
            | Completed _
            | Stopped _
            | Canceled_unsent
            | Outcome_unknown _ )
          , _ ) -> false
      in
      if not permitted
      then (
        if retry then Json.fail Conflict "only an uncertain wait permits exact retry";
        entry.job)
      else (
        let original_state = entry.job.state in
        let promise, resolve = Eio.Promise.create () in
        let finished, finish = Eio.Promise.create () in
        let flight =
          { id
          ; promise
          ; finished
          ; cancellation = None
          ; cancellation_authorized = false
          ; phase = Idle
          ; interrupted_write = false
          }
        in
        t.flight <- Some flight;
        Eio.Fiber.fork ~sw:t.sw (fun () ->
          Exn.protect
            ~finally:(fun () ->
              t.flight <- None;
              Eio.Promise.resolve finish ())
            ~f:(fun () ->
              let clock = Eio.Stdenv.mono_clock t.env in
              let origin = Eio.Time.Mono.now clock in
              let total_seconds =
                if retry then 60. else Float.of_int entry.job.plan.timeout_ms /. 1000.
              in
              let remaining () =
                total_seconds
                -. (Mtime.Span.to_float_ns (Mtime.span origin (Eio.Time.Mono.now clock))
                    /. 1e9)
              in
              let qualified =
                Json.decode (fun () ->
                  let connection =
                    Operation.Preparation.connection entry.job.plan.preparation
                  in
                  let client =
                    Client.create
                      ~net:(Eio.Stdenv.net t.env)
                      ~clock
                      ~socket:(Connection_profile.socket connection)
                      ~timeout_seconds:total_seconds
                    |> Disk.unwrap
                  in
                  Daemon_qualification.check
                    (Daemon_qualification.create ~clock)
                    ~timeout_seconds:(remaining ())
                    client
                  |> Disk.unwrap)
              in
              let admission =
                Result.bind qualified ~f:(fun () ->
                  locked t (fun () ->
                    Json.decode (fun () ->
                      (* Admission was tentatively selected before acquiring this
                       mutex. A queued prepared cancellation may have won first. *)
                      let permitted =
                        match entry.job.state, retry with
                        | Prepared_unsent, false | Outcome_unknown _, true -> true
                        | ( ( Prepared_unsent
                            | Running
                            | Completed _
                            | Stopped _
                            | Canceled_unsent
                            | Outcome_unknown _ )
                          , _ ) -> false
                      in
                      if not permitted
                      then (
                        if retry
                        then
                          Json.fail Conflict "only an uncertain wait permits exact retry";
                        entry.job)
                      else (
                        (* Synchronize the exact journal before every admitted flight. *)
                        Request_journal.sync_existing
                          entry.job.latest.request
                          ~fs:(State_root.directory t.root)
                          ~destination:entry.job.latest.path
                        |> Disk.unwrap;
                        let job = entry.job in
                        entry.job
                        <- Job.next
                             job
                             ~state:Running
                             ~cancel_requested:false
                             ~diagnostic:None;
                        (match synchronize t entry with
                         | Ok () -> ()
                         | Error diagnostic ->
                           entry.job
                           <- Job.next
                                entry.job
                                ~state:
                                  (Outcome_unknown
                                     ( Problem.create
                                         Outcome_unknown
                                         "admission sync failed; exchange not authorized"
                                     , None ))
                                ~cancel_requested:false
                                ~diagnostic:(Some diagnostic);
                           raise (Json.Decode_error diagnostic));
                        entry.job))))
              in
              Eio.Promise.resolve resolve admission;
              match admission with
              | Error _ -> ()
              | Ok job ->
                (match job.state with
                 | Prepared_unsent
                 | Completed _
                 | Stopped _
                 | Canceled_unsent
                 | Outcome_unknown _ -> ()
                 | Running ->
                   let state =
                     let deadline () =
                       match original_state with
                       | Outcome_unknown _ when retry -> original_state
                       | _ when flight.interrupted_write ->
                         Job.Outcome_unknown
                           ( Problem.create
                               Outcome_unknown
                               "wait deadline interrupted a write; retain the exact \
                                saved request"
                           , None )
                       | Prepared_unsent
                       | Running
                       | Completed _
                       | Stopped _
                       | Canceled_unsent
                       | Outcome_unknown _ ->
                         Stopped (local_stop_outcome entry.job ~stop:"deadline")
                     in
                     try
                       Eio.Cancel.sub (fun cancellation ->
                         flight.cancellation <- Some cancellation;
                         let budget = remaining () in
                         if Float.(budget <= 0.)
                         then deadline ()
                         else
                           Eio.Time.Timeout.run_exn
                             (Eio.Time.Timeout.seconds clock budget)
                             (fun () ->
                                if retry
                                then retry_once t flight entry
                                else collect t flight entry))
                     with
                     | Eio.Time.Timeout -> deadline ()
                     | Requested_cancel | Eio.Cancel.Cancelled Requested_cancel ->
                       (* Canceling this retry only prevents another exchange. It
                          cannot settle the earlier request whose reply was lost. *)
                       (match original_state with
                        | Outcome_unknown _ ->
                          if retry
                          then original_state
                          else Stopped (canceled_outcome entry.job)
                        | Prepared_unsent
                        | Running
                        | Completed _
                        | Stopped _
                        | Canceled_unsent -> Stopped (canceled_outcome entry.job))
                   in
                   flight.cancellation <- None;
                   ignore (observed t entry state : Job.t))));
        Eio.Promise.await promise |> Disk.unwrap))
;;

let start t ~id = admit t ~id ~retry:false
let retry_exact t ~id = admit t ~id ~retry:true

let cancel t ~id =
  locked t (fun () ->
    Json.decode (fun () ->
      let entry = find t id in
      if not entry.published
      then Json.fail Conflict "wait preparation is not durably published";
      match entry.job.state with
      | Prepared_unsent ->
        entry.job
        <- Job.next
             entry.job
             ~state:Canceled_unsent
             ~cancel_requested:true
             ~diagnostic:None;
        synchronize t entry |> Disk.unwrap;
        entry.job
      | Running ->
        entry.job
        <- Job.next
             entry.job
             ~state:Running
             ~cancel_requested:true
             ~diagnostic:entry.job.diagnostic;
        synchronize t entry |> Disk.unwrap;
        (match t.flight with
         | Some flight when Operation.Id.equal id flight.id ->
           flight.cancellation_authorized <- true;
           (* Do not interrupt a write whose durable reply may already be arriving.
            It remains bounded by its original deadline. Cancel the read wait,
            and prevent every subsequent acquisition attempt. *)
           (match flight.phase with
            | Reading ->
              Option.iter flight.cancellation ~f:(fun context ->
                Eio.Cancel.cancel context Requested_cancel)
            | Idle | Writing -> ())
         | Some _ | None -> ());
        entry.job
      | Completed _ | Stopped _ | Canceled_unsent | Outcome_unknown _ ->
        if entry.dirty then synchronize t entry |> Disk.unwrap;
        entry.job))
;;
