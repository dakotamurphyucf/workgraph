open Core
open Workgraph

module Context = struct
  type t =
    { workspace : Id.Workspace.t option
    ; project : Id.Project.t option
    ; writer : Writer.t option
    }

  let create ~workspace ~project ~writer = { workspace; project; writer }

  let to_json t =
    Json.obj
      [ ( "workspace_id"
        , Option.value_map t.workspace ~default:`Null ~f:Id.Workspace.jsonaf_of_t )
      ; "project_id", Option.value_map t.project ~default:`Null ~f:Id.Project.jsonaf_of_t
      ; "writer", Option.value_map t.writer ~default:`Null ~f:Writer.to_json
      ]
  ;;

  let of_json value =
    Json.decode (fun () ->
      Json.fields value ~allowed:[ "workspace_id"; "project_id"; "writer" ];
      let nullable name decode =
        match Json.field value name with
        | `Null -> None
        | value -> Some (decode value)
      in
      create
        ~workspace:(nullable "workspace_id" Id.Workspace.t_of_jsonaf)
        ~project:(nullable "project_id" Id.Project.t_of_jsonaf)
        ~writer:(nullable "writer" (fun value -> Writer.of_json value |> Disk.unwrap)))
  ;;
end

module Plan = struct
  type t =
    { intention_id : Operation.Id.t
    ; connection : Connection_profile.t
    ; context : Context.t
    ; registry : string
    ; log : string
    ; timeout_seconds : int
    }

  let create ~intention_id ~connection ~context ~registry ~log ~timeout_seconds =
    Json.decode (fun () ->
      Disk.absolute registry;
      Disk.absolute log;
      if String.length registry > 4096 || String.length log > 4096
      then Json.fail Invalid_argument "host path exceeds 4096 bytes";
      if timeout_seconds < 1 || timeout_seconds > 300
      then Json.fail Invalid_argument "startup timeout requires 1..300 seconds";
      { intention_id; connection; context; registry; log; timeout_seconds })
  ;;

  let to_json t =
    Json.obj
      [ "intention_id", Operation.Id.jsonaf_of_t t.intention_id
      ; "connection", Connection_profile.to_json t.connection
      ; "context", Context.to_json t.context
      ; "registry", Json.string t.registry
      ; "log", Json.string t.log
      ; "timeout_seconds", Json.int t.timeout_seconds
      ]
  ;;

  let of_json value =
    Json.decode (fun () ->
      Json.fields
        value
        ~allowed:
          [ "intention_id"
          ; "connection"
          ; "context"
          ; "registry"
          ; "log"
          ; "timeout_seconds"
          ];
      create
        ~intention_id:(Operation.Id.t_of_jsonaf (Json.field value "intention_id"))
        ~connection:
          (Connection_profile.of_json (Json.field value "connection") |> Disk.unwrap)
        ~context:(Context.of_json (Json.field value "context") |> Disk.unwrap)
        ~registry:(Json.field value "registry" |> Json.text)
        ~log:(Json.field value "log" |> Json.text)
        ~timeout_seconds:(Json.field value "timeout_seconds" |> Json.integer)
      |> Disk.unwrap)
  ;;
end

module Launch = struct
  type state =
    | Prepared_unsent
    | Starting
    | Ready of Cli_bootstrap.Daemon_start.t
    | Outcome_unknown of Problem.t

  type t =
    { plan : Plan.t
    ; executable : string
    ; revision : int
    ; state : state
    ; diagnostic : Problem.t option
    }

  let state_json = function
    | Prepared_unsent -> Json.obj [ "status", Json.string "prepared_unsent" ]
    | Starting -> Json.obj [ "status", Json.string "starting" ]
    | Outcome_unknown problem ->
      Json.obj
        [ "status", Json.string "outcome_unknown"; "problem", Problem.to_json problem ]
    | Ready { observation; listing } ->
      let observation =
        match observation with
        | Existing -> "existing_endpoint"
        | Startup_attempt_observed_ready -> "startup_attempt_observed_ready"
        | Competing -> "observed_competition"
      in
      Json.obj
        [ "status", Json.string "ready"
        ; "observation", Json.string observation
        ; "ownership", Json.string "unknown"
        ; "listing", listing
        ]
  ;;

  let to_json t =
    Json.obj
      [ "plan", Plan.to_json t.plan
      ; "executable", Json.string t.executable
      ; ( "input_hash"
        , Json.string
            (Json.hash
               (Json.canonical
                  (Json.obj
                     [ "plan", Plan.to_json t.plan
                     ; "executable", Json.string t.executable
                     ]))) )
      ; "revision", Json.int t.revision
      ; "state", state_json t.state
      ; "diagnostic", Option.value_map t.diagnostic ~default:`Null ~f:Problem.to_json
      ]
  ;;

  let storage t =
    let state =
      match t.state with
      | Ready observation ->
        (match state_json t.state with
         | `Object fields ->
           `Object
             (List.map fields ~f:(fun (key, value) ->
                if String.equal key "listing"
                then key, Json.string (Json.canonical observation.listing)
                else key, value))
         | _ -> assert false)
      | Prepared_unsent | Starting | Outcome_unknown _ -> state_json t.state
    in
    Json.obj
      [ "format", Json.string "ui-daemon-launch-1"
      ; "plan", Json.string (Json.canonical (Plan.to_json t.plan))
      ; "executable", Json.string t.executable
      ; "revision", Json.int t.revision
      ; "state", Json.string (Json.canonical state)
      ; "diagnostic", Option.value_map t.diagnostic ~default:`Null ~f:Problem.to_json
      ]
  ;;

  let next t ~state ~diagnostic =
    if Int.equal t.revision Int.max_value
    then Json.fail Corrupt_store "launch revision exhausted; refusing transition";
    { t with revision = t.revision + 1; state; diagnostic }
  ;;

  let of_storage value =
    Json.decode (fun () ->
      Json.fields
        value
        ~allowed:[ "format"; "plan"; "executable"; "revision"; "state"; "diagnostic" ];
      if not (String.equal (Json.field value "format" |> Json.text) "ui-daemon-launch-1")
      then Json.fail Unsupported_version "unsupported local daemon launch format";
      let plan =
        Json.field value "plan"
        |> Json.text
        |> Json.parse
        |> Disk.unwrap
        |> Plan.of_json
        |> Disk.unwrap
      in
      let executable = Json.field value "executable" |> Json.text in
      Disk.absolute executable;
      let revision = Json.field value "revision" |> Json.integer in
      if revision < 1 then Json.fail Corrupt_store "launch revision must be positive";
      let value_state =
        Json.field value "state" |> Json.text |> Json.parse |> Disk.unwrap
      in
      let state =
        match Json.field value_state "status" |> Json.text with
        | "prepared_unsent" ->
          Json.fields value_state ~allowed:[ "status" ];
          Prepared_unsent
        | "starting" ->
          Json.fields value_state ~allowed:[ "status" ];
          Starting
        | "outcome_unknown" ->
          Json.fields value_state ~allowed:[ "status"; "problem" ];
          Outcome_unknown
            (Json.field value_state "problem" |> Problem_wire.of_json |> Disk.unwrap)
        | "ready" ->
          Json.fields
            value_state
            ~allowed:[ "status"; "observation"; "ownership"; "listing" ];
          if
            not (String.equal (Json.field value_state "ownership" |> Json.text) "unknown")
          then Json.fail Corrupt_store "launch cannot assert process ownership";
          let observation =
            match Json.field value_state "observation" |> Json.text with
            | "existing_endpoint" -> Cli_bootstrap.Daemon_start.Existing
            | "startup_attempt_observed_ready" -> Startup_attempt_observed_ready
            | "observed_competition" -> Competing
            | _ -> Json.fail Corrupt_store "unknown launch observation"
          in
          let listing =
            Json.field value_state "listing" |> Json.text |> Json.parse |> Disk.unwrap
          in
          ignore
            (Api_codec.decode
               (Api_response.codec Administration_wire.Health.codec)
               listing
             |> Disk.unwrap);
          Ready { observation; listing }
        | _ -> Json.fail Corrupt_store "unknown launch status"
      in
      let diagnostic =
        match Json.field value "diagnostic" with
        | `Null -> None
        | value -> Some (Problem_wire.of_json value |> Disk.unwrap)
      in
      let t = { plan; executable; revision; state; diagnostic } in
      match state with
      | Starting ->
        next
          t
          ~state:
            (Outcome_unknown
               (Problem.create
                  Outcome_unknown
                  "companion restarted during startup; detached process may still be \
                   running"))
          ~diagnostic
      | Prepared_unsent | Ready _ | Outcome_unknown _ -> t)
  ;;
end

type entry =
  { mutable launch : Launch.t
  ; mutable published : bool
  }

type t =
  { sw : Eio.Switch.t
  ; env : Eio_unix.Stdenv.base
  ; root : State_root.t
  ; executable : string
  ; mutex : Eio.Mutex.t
  ; mutable entries : entry Operation.Id.Map.t
  ; mutable flights : (Launch.t, Problem.t) Result.t Eio.Promise.t Operation.Id.Map.t
  }

let name id = "launch-" ^ Operation.Id.to_string id ^ ".json"

let save t launch =
  State_root.save
    t.root
    ~name:(name launch.Launch.plan.intention_id)
    ~value:(Launch.storage launch)
;;

let locked t f = Eio.Mutex.use_rw ~protect:true t.mutex f

let create ~sw ~env ~root ~executable =
  Disk.protect (fun () ->
    Disk.absolute executable;
    let t =
      { sw
      ; env
      ; root
      ; executable
      ; mutex = Eio.Mutex.create ()
      ; entries = Operation.Id.Map.empty
      ; flights = Operation.Id.Map.empty
      }
    in
    let names = State_root.names root |> Disk.unwrap in
    List.iter names ~f:(fun filename ->
      if String.is_prefix filename ~prefix:"launch-"
      then (
        if Map.length t.entries >= 1000
        then Json.fail Corrupt_store "local launch limit exceeded";
        let value =
          State_root.read root ~name:filename |> Disk.unwrap |> Option.value_exn
        in
        let launch = Launch.of_storage value |> Disk.unwrap in
        let id = launch.plan.intention_id in
        if (not (String.equal filename (name id))) || Map.mem t.entries id
        then Json.fail Corrupt_store "launch filename/identity mismatch";
        save t launch |> Disk.unwrap;
        t.entries <- Map.set t.entries ~key:id ~data:{ launch; published = true }));
    t)
;;

let resolve_executable ~fs ~cwd ~invoked_as ~search_path =
  Disk.protect (fun () ->
    Disk.absolute cwd;
    let absolute path =
      if Filename.is_relative path then Filename.concat cwd path else path
    in
    let exists path =
      match Eio.Path.kind ~follow:true Eio.Path.(fs / path) with
      | `Regular_file -> true
      | _ -> false
    in
    let invoked =
      if String.contains invoked_as '/'
      then absolute invoked_as
      else (
        let paths = Option.value search_path ~default:"" |> String.split ~on:':' in
        List.find_map paths ~f:(fun directory ->
          let path =
            Filename.concat
              (absolute (if String.is_empty directory then "." else directory))
              invoked_as
          in
          if exists path then Some path else None)
        |> Option.value ~default:(absolute invoked_as))
    in
    let logical =
      Filename.concat (Platform.realpath (Filename.dirname invoked)) "workgraph"
    in
    if exists logical
    then logical
    else Filename.concat (Filename.dirname (Platform.realpath invoked)) "workgraph")
;;

let check_executable t =
  try
    Disk.protect (fun () ->
      Eio.Time.Timeout.run_exn
        (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock t.env) 2.)
        (fun () ->
           Eio.Switch.run (fun sw ->
             let manager = Eio.Stdenv.process_mgr t.env in
             let source, sink = Eio.Process.pipe ~sw manager in
             let process =
               Eio.Process.spawn
                 ~sw
                 manager
                 ~stdin:(Eio.Flow.string_source "")
                 ~stdout:sink
                 ~stderr:sink
                 [ t.executable; "--version" ]
             in
             Eio.Resource.close sink;
             let buffer = Cstruct.create 1025 in
             let rec read used =
               if used >= 1025
               then
                 Json.fail
                   Invalid_argument
                   "paired executable version output exceeds 1024 bytes";
               match
                 Eio.Flow.single_read source (Cstruct.sub buffer used (1025 - used))
               with
               | count -> read (used + count)
               | exception End_of_file -> Cstruct.to_string (Cstruct.sub buffer 0 used)
             in
             let version = read 0 |> String.strip in
             (match Eio.Process.await process with
              | `Exited 0 -> ()
              | status ->
                Json.fail
                  Storage_unavailable
                  (Fmt.str
                     "paired executable version probe failed: %a"
                     Eio.Process.pp_status
                     status));
             if not (String.equal version Version.value)
             then
               Json.fail
                 Unsupported_version
                 ("paired core must be exactly " ^ Version.value ^ "; observed " ^ version);
             version)))
  with
  | Eio.Time.Timeout ->
    Error
      (Problem.create
         Storage_unavailable
         "paired executable --version exceeded two seconds; startup unavailable")
;;

let capabilities t =
  match check_executable t with
  | Ok version ->
    Json.obj
      [ "available", `True
      ; "executable", Json.string t.executable
      ; "version", Json.string version
      ; "problem", `Null
      ]
  | Error problem ->
    Json.obj
      [ "available", `False
      ; "executable", Json.string t.executable
      ; "version", `Null
      ; "problem", Problem.to_json problem
      ]
;;

let prepare t plan =
  locked t (fun () ->
    Json.decode (fun () ->
      let publish entry =
        if not entry.published
        then (
          save t entry.launch |> Disk.unwrap;
          entry.published <- true);
        entry.launch
      in
      match Map.find t.entries plan.Plan.intention_id with
      | Some entry ->
        if
          not
            (String.equal t.executable entry.launch.executable
             && String.equal
                  (Json.canonical (Plan.to_json plan))
                  (Json.canonical (Plan.to_json entry.launch.plan)))
        then
          Json.fail
            Idempotency_conflict
            "launch intention already captures different complete inputs or executable";
        publish entry
      | None ->
        if Map.length t.entries >= 1000
        then
          Json.fail
            Blocked
            "local launch limit is 1000; choose another private companion state root";
        let launch =
          { Launch.plan
          ; executable = t.executable
          ; revision = 1
          ; state = Prepared_unsent
          ; diagnostic = None
          }
        in
        let entry = { launch; published = false } in
        t.entries <- Map.set t.entries ~key:plan.intention_id ~data:entry;
        publish entry))
;;

let inspect t ~intention_id =
  Json.decode (fun () ->
    match Map.find t.entries intention_id with
    | None ->
      Json.fail Not_found "launch intention is absent from this companion state root"
    | Some { published = false; _ } ->
      Json.fail Conflict "launch preparation has not completed durable publication"
    | Some entry -> entry.launch)
;;

let list t =
  Map.data t.entries
  |> List.filter_map ~f:(fun entry -> if entry.published then Some entry.launch else None)
;;

let start t ~intention_id ~retry =
  match Map.find t.flights intention_id with
  | Some promise -> Eio.Promise.await promise
  | None ->
    Json.decode (fun () ->
      let current = inspect t ~intention_id |> Disk.unwrap in
      let admitted =
        match current.Launch.state, retry with
        | Prepared_unsent, false | Outcome_unknown _, true -> true
        | Prepared_unsent, true | Outcome_unknown _, false | Starting, _ | Ready _, _ ->
          false
      in
      if not admitted
      then
        Json.fail
          Conflict
          "launch state requires start for prepared_unsent or explicit retry for \
           outcome_unknown";
      if not (String.equal current.executable t.executable)
      then
        Json.fail
          Conflict
          "saved launch uses another configured executable; inspect it and prepare a new \
           intention explicitly";
      if Map.length t.flights >= 8
      then
        Json.fail
          Blocked
          "eight local startup tasks are already pending; saved launch remains unsent";
      let promise, resolve = Eio.Promise.create () in
      t.flights <- Map.set t.flights ~key:intention_id ~data:promise;
      Eio.Fiber.fork ~sw:t.sw (fun () ->
        Exn.protect
          ~finally:(fun () -> t.flights <- Map.remove t.flights intention_id)
          ~f:(fun () ->
            let result =
              Json.decode (fun () ->
                ignore (check_executable t |> Disk.unwrap : string);
                let entry = Map.find_exn t.entries intention_id in
                let starting =
                  Launch.next entry.launch ~state:Starting ~diagnostic:None
                in
                entry.launch <- starting;
                (match save t starting with
                 | Ok () -> ()
                 | Error error ->
                   entry.launch
                   <- Launch.next
                        starting
                        ~state:
                          (Outcome_unknown
                             (Problem.create
                                Outcome_unknown
                                "startup barrier persistence failed; no spawn authorized"))
                        ~diagnostic:(Some error);
                   raise (Json.Decode_error error));
                Eio.Promise.resolve resolve (Ok starting);
                let state =
                  match
                    Cli_bootstrap.start_daemon
                      ~before_probe:(fun client ->
                        Daemon_qualification.check
                          (Daemon_qualification.create
                             ~clock:(Eio.Stdenv.mono_clock t.env))
                          client)
                      ~env:t.env
                      ~executable:starting.executable
                      ~socket:(Connection_profile.socket starting.plan.connection)
                      ~registry:starting.plan.registry
                      ~log:starting.plan.log
                      ~timeout_seconds:(Float.of_int starting.plan.timeout_seconds)
                      ()
                  with
                  | Ok observation -> Launch.Ready observation
                  | Error problem -> Launch.Outcome_unknown problem
                in
                let observed = Launch.next entry.launch ~state ~diagnostic:None in
                entry.launch <- observed;
                (match save t observed with
                 | Ok () -> ()
                 | Error diagnostic ->
                   entry.launch
                   <- Launch.next observed ~state ~diagnostic:(Some diagnostic));
                entry.launch)
            in
            if not (Eio.Promise.is_resolved promise)
            then Eio.Promise.resolve resolve result));
      Eio.Promise.await promise |> Disk.unwrap)
;;
