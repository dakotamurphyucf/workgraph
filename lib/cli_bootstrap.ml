open Core

let help =
  {|init / bootstrap [local helper] — Create or select a workspace and save agent-local defaults.
Usage:
  workgraph init --context ABS_FILE --socket ABS_SOCKET --workspace-id ID [--actor-id ID]
    --root ABS_ROOT --name NAME [--run-id ID] [--request-directory ABS_DIR]
    [--start-daemon true --registry ABS_DIR --daemon-log ABS_FILE] [--timeout SECONDS]
  workgraph bootstrap ... (same options)
  workgraph init --context EXISTING_CONTEXT

New context requires an absolute context path, socket and workspace ID.
Omit actor/run for observer defaults against an existing open workspace. Observer
defaults are not security: explicit --actor-id still enables authorized writes.
A new workspace also requires an absolute root and nonblank name.
An existing context supplies defaults; chosen defaults must match it exactly.
--run-id records attribution; register the run separately before allocating work.
--start-daemon true requires registry and daemon-log; otherwise a daemon must be running.
Parent directories must exist. Setup creates the configured --request-directory
before starting a daemon or sending mutations. It saves exact administrative
requests there (beside the context if unconfigured), opens the workspace, then
publishes the private context. The directory also journals later mutations.
--save-request is unsupported here. For a second agent, use a fresh --context and
--actor-id with the same --socket and --workspace-id; omit root/name and startup
flags when the workspace and daemon already exist.
Reading this help requires no daemon or context and creates no files.|}
;;

module Startup = struct
  type t =
    | Existing
    | Start of
        { registry : string
        ; log : string
        }
end

type t =
  { context_file : string
  ; context : Cli_context.t
  ; previous : Cli_context.t option
  ; workspace_id : string
  ; actor_id : string option
  ; root : string option
  ; name : string option
  ; startup : Startup.t
  ; timeout_seconds : float
  }

let create ~context_file ~socket ~previous ~fields ~request_directory ~timeout_seconds =
  Json.decode (fun () ->
    Disk.absolute context_file;
    Platform.validate_socket_path socket |> Disk.unwrap;
    if
      (not (Float.is_finite timeout_seconds))
      || Float.(timeout_seconds <= 0. || timeout_seconds > 3600.)
    then
      Json.fail
        Invalid_argument
        "timeout must be positive, finite and at most 3600 seconds";
    Json.fields
      (Json.obj fields)
      ~allowed:
        [ "workspace_id"
        ; "actor_id"
        ; "run_id"
        ; "root"
        ; "name"
        ; "start_daemon"
        ; "registry"
        ; "daemon_log"
        ];
    let fields =
      Option.value_map previous ~default:fields ~f:(fun context ->
        let defaults =
          match Cli_context.to_json context with
          | `Object fields -> fields
          | _ -> assert false
        in
        fields
        @ List.filter defaults ~f:(fun (key, _) ->
          List.mem [ "workspace_id"; "actor_id"; "run_id" ] key ~equal:String.equal
          && not (List.Assoc.mem fields key ~equal:String.equal)))
    in
    let optional key =
      Option.map (List.Assoc.find fields key ~equal:String.equal) ~f:Json.text
    in
    let required key =
      match optional key with
      | Some value -> value
      | None ->
        Json.fail
          Invalid_argument
          ("init requires --" ^ String.tr key ~target:'_' ~replacement:'-')
    in
    let workspace_id = required "workspace_id" in
    let actor_id = optional "actor_id" in
    let root = optional "root" in
    Option.iter root ~f:Disk.absolute;
    let name = optional "name" in
    Option.iter name ~f:(fun name ->
      if String.is_empty (String.strip name) || String.length name > 512
      then
        Json.fail Invalid_argument "workspace name must be nonblank and at most 512 bytes");
    let request_directory =
      match request_directory with
      | Some _ as directory -> directory
      | None -> Option.bind previous ~f:Cli_context.request_directory
    in
    let context_value =
      Json.obj
        ([ "socket", Json.string socket; "workspace_id", Json.string workspace_id ]
         @ Option.to_list
             (Option.map actor_id ~f:(fun actor -> "actor_id", Json.string actor))
         @ Option.to_list
             (Option.map
                (List.Assoc.find fields "run_id" ~equal:String.equal)
                ~f:(fun value -> "run_id", value))
         @ Option.to_list
             (Option.map request_directory ~f:(fun value ->
                "request_directory", Json.string value)))
    in
    let context = Cli_context.of_json context_value |> Disk.unwrap in
    Option.iter previous ~f:(fun previous ->
      if
        not
          (String.equal
             (Json.canonical (Cli_context.to_json previous))
             (Json.canonical context_value))
      then Json.fail Conflict "existing context differs; choose a new context file");
    let start =
      match List.Assoc.find fields "start_daemon" ~equal:String.equal with
      | None | Some `False | Some (`String "false") -> false
      | Some `True | Some (`String "true") -> true
      | Some _ -> Json.fail Invalid_argument "start-daemon requires true or false"
    in
    let startup =
      if start
      then (
        let registry = required "registry" in
        let log = required "daemon_log" in
        Disk.absolute registry;
        Disk.absolute log;
        Startup.Start { registry; log })
      else (
        if Option.is_some (optional "registry") || Option.is_some (optional "daemon_log")
        then
          Json.fail Invalid_argument "registry and daemon-log require --start-daemon true";
        Startup.Existing)
    in
    { context_file
    ; context
    ; previous
    ; workspace_id
    ; actor_id
    ; root
    ; name
    ; startup
    ; timeout_seconds
    })
;;

let same_context left right =
  String.equal
    (Json.canonical (Cli_context.to_json left))
    (Json.canonical (Cli_context.to_json right))
;;

let random_name env =
  let bytes = Cstruct.create 32 in
  Eio.Flow.read_exact (Eio.Stdenv.secure_random env) bytes;
  Json.hash (Cstruct.to_string bytes)
;;

let startup_log file ~after =
  let result =
    Disk.protect (fun () ->
      let size = Eio.File.size file in
      let maximum a b = if Optint.Int63.compare a b >= 0 then a else b in
      let offset = maximum after (Optint.Int63.sub size (Optint.Int63.of_int 8192)) in
      let count =
        Optint.Int63.to_int (maximum Optint.Int63.zero (Optint.Int63.sub size offset))
      in
      let bytes = Cstruct.create count in
      Eio.File.pread_exact file ~file_offset:offset [ bytes ];
      let text = Cstruct.to_string bytes in
      if Optint.Int63.compare offset after > 0
      then (
        match String.lsplit2 text ~on:'\n' with
        | Some (_, rest) -> rest
        | None -> "[startup log tail omitted an incomplete line]")
      else text)
  in
  match result with
  | Ok text ->
    let problem =
      String.split_lines text
      |> List.rev
      |> List.find_map ~f:(fun line ->
        Result.bind (Json.parse line) ~f:Problem_wire.of_json |> Result.ok)
    in
    text, problem
  | Error problem -> "[cannot read startup log: " ^ problem.message ^ "]", None
;;

let probe_listing ?before_probe client request =
  let qualification : (unit, Problem.t) Result.t =
    match before_probe with
    | None -> Ok ()
    | Some qualify -> qualify client
  in
  match qualification with
  | Error problem when not (Problem.equal_kind problem.kind Storage_unavailable) ->
    (* A reached endpoint's typed incompatibility/domain rejection is terminal.
       It must not become the absent-socket branch that spawns another child. *)
    Ok (Protocol.Failure problem)
  | Error problem -> Error problem
  | Ok () ->
    Result.bind (Client.execute client request) ~f:(function
      | Protocol.Failure _ as response -> Ok response
      | Success value ->
        Result.map
          (Api_codec.decode (Api_response.codec Administration_wire.Health.codec) value)
          ~f:(fun _ -> Protocol.Success value))
;;

module Daemon_start = struct
  type observation =
    | Existing
    | Startup_attempt_observed_ready
    | Competing
  [@@deriving equal, sexp]

  type t =
    { observation : observation
    ; listing : Jsonaf.t
    }
end

let start_daemon_after_probe
      ~before_probe
      ~env
      ~socket
      ~timeout_seconds
      ~executable
      ~client
      ~list_request
      ~initial_problem
      ~registry
      ~log
  =
  Eio.Switch.run (fun sw ->
    let fs = Eio.Stdenv.fs env in
    (* Eio.Path.open_out opens for reading and writing on both POSIX and Linux;
       append constrains writes only, so pread can inspect this same descriptor. *)
    let file =
      Eio.Path.open_out ~sw ~append:true ~create:(`If_missing 0o600) Eio.Path.(fs / log)
    in
    let after = Eio.File.size file in
    (* The supervisor owns the child until we observe readiness or its exit.
       USR1 releases supervision after a valid handshake; unlike an Eio-managed
       daemon child, the nohup process survives release of this short switch. *)
    let supervisor =
      Eio.Process.spawn
        ~sw
        (Eio.Stdenv.process_mgr env)
        ~stdout:file
        ~stderr:file
        [ "/bin/sh"
        ; "-c"
        ; {|trap 'exit 0' USR1; umask 077; nohup "$1" serve "$2" "$3" </dev/null & wait "$!"|}
        ; "workgraph-bootstrap"
        ; executable
        ; registry
        ; socket
        ]
    in
    let last_problem = ref initial_problem in
    let rec ready () =
      match probe_listing ?before_probe client list_request with
      | Ok (Protocol.Success value) -> value
      | Ok (Failure problem) -> raise (Json.Decode_error problem)
      | Error problem ->
        last_problem := problem;
        Eio.Time.Mono.sleep (Eio.Stdenv.mono_clock env) 0.05;
        ready ()
    in
    let failure status =
      let tail, problem = startup_log file ~after in
      let problem =
        Option.value problem ~default:(Problem.create Storage_unavailable "daemon exited")
      in
      { problem with
        message =
          sprintf
            "daemon startup failed (%s): %s; log %S: %s; last handshake: %s"
            status
            problem.message
            log
            tail
            !last_problem.message
      }
    in
    try
      Eio.Time.Timeout.run_exn
        (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock env) timeout_seconds)
        (fun () ->
           match
             Eio.Fiber.first
               (fun () -> `Ready (ready ()))
               (fun () -> `Exited (Eio.Process.await supervisor))
           with
           | `Ready value ->
             Eio.Process.signal supervisor Stdlib.Sys.sigusr1;
             ignore (Eio.Process.await supervisor : Eio.Process.exit_status);
             { Daemon_start.observation = Startup_attempt_observed_ready
             ; listing = value
             }
           | `Exited status ->
             (* A competing bootstrap may own this exact socket and still be
               recovering its registry. Its valid handshake is the only success
               condition; the losing child's exit is not itself readiness. *)
             let _, problem = startup_log file ~after in
             if
               Option.exists problem ~f:(function
                 | { Problem.kind = Conflict; details = Some (Socket_owner _); _ } -> true
                 | _ -> false)
             then { Daemon_start.observation = Competing; listing = ready () }
             else
               raise
                 (Json.Decode_error (failure (Fmt.str "%a" Eio.Process.pp_status status))))
    with
    | Eio.Time.Timeout ->
      let problem =
        failure "startup deadline exceeded; detached daemon may still start"
      in
      raise (Json.Decode_error problem))
;;

let start_daemon ?before_probe ~env ~executable ~socket ~registry ~log ~timeout_seconds ()
  =
  let run () =
    Disk.protect (fun () ->
      Disk.absolute executable;
      Platform.validate_socket_path socket |> Disk.unwrap;
      Disk.absolute registry;
      Disk.absolute log;
      if
        (not (Float.is_finite timeout_seconds))
        || Float.(timeout_seconds <= 0. || timeout_seconds > 3600.)
      then
        Json.fail
          Invalid_argument
          "startup timeout must be positive and at most 3600 seconds";
      let fs = Eio.Stdenv.fs env in
      (match Eio.Path.kind ~follow:false Eio.Path.(fs / registry) with
       | `Directory -> ()
       | `Not_found ->
         Local_file.require_directory
           Eio.Path.(fs / Filename.dirname registry)
           ~operation:"initialize daemon registry"
       | _ ->
         Json.fail
           Invalid_argument
           "daemon registry requires a real directory or fresh path");
      Local_file.require_directory
        Eio.Path.(fs / Filename.dirname log)
        ~operation:"initialize daemon log";
      (match Eio.Path.kind ~follow:false Eio.Path.(fs / log) with
       | `Not_found | `Regular_file -> ()
       | _ ->
         Json.fail Invalid_argument "daemon log requires a regular file or fresh path");
      let client =
        Client.create
          ~net:(Eio.Stdenv.net env)
          ~clock:(Eio.Stdenv.mono_clock env)
          ~socket
          ~timeout_seconds
        |> Disk.unwrap
      in
      let list_request =
        Protocol.Request.create
          ~id:"local-daemon-start"
          ~method_:"workspace.list"
          ~params:(Json.obj [])
        |> Disk.unwrap
      in
      match probe_listing ?before_probe client list_request with
      | Ok (Protocol.Success listing) -> { Daemon_start.observation = Existing; listing }
      | Ok (Failure problem) -> raise (Json.Decode_error problem)
      | Error initial_problem ->
        start_daemon_after_probe
          ~before_probe
          ~env
          ~socket
          ~timeout_seconds
          ~executable
          ~client
          ~list_request
          ~initial_problem
          ~registry
          ~log)
  in
  if
    (not (Float.is_finite timeout_seconds))
    || Float.(timeout_seconds <= 0. || timeout_seconds > 3600.)
  then
    Error
      (Problem.create
         Invalid_argument
         "startup timeout must be positive and at most 3600 seconds")
  else (
    match before_probe with
    | None -> run ()
    | Some _ ->
      (* Qualification is included in the caller's full budget, including the
       initial existing-endpoint probe. Its own cap cannot extend this deadline. *)
      (try
         Eio.Time.Timeout.run_exn
           (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock env) timeout_seconds)
           run
       with
       | Eio.Time.Timeout ->
         Error
           (Problem.create
              Storage_unavailable
              "daemon startup deadline exceeded during qualification/readiness; a \
               detached startup, if already admitted, may still finish")))
;;

let run ?daemon_executable t ~env ~on_saved_request =
  Disk.protect (fun () ->
    Option.iter daemon_executable ~f:Disk.absolute;
    let daemon_executable =
      Option.value daemon_executable ~default:Stdlib.Sys.executable_name
    in
    let fs = (Eio.Stdenv.fs env :> Eio.Fs.dir_ty Eio.Path.t) in
    let directory = Filename.dirname t.context_file in
    Local_file.require_directory Eio.Path.(fs / directory) ~operation:"initialize context";
    let require_creatable_directory path =
      match Eio.Path.kind ~follow:false Eio.Path.(fs / path) with
      | `Directory -> ()
      | `Not_found ->
        Local_file.require_directory
          Eio.Path.(fs / Filename.dirname path)
          ~operation:"initialize directory"
      | _ ->
        Json.fail
          Invalid_argument
          (sprintf
             "initialize directory %S: requires a real directory or a fresh path"
             path)
    in
    Option.iter t.root ~f:require_creatable_directory;
    Option.iter (Cli_context.request_directory t.context) ~f:require_creatable_directory;
    (match t.startup with
     | Existing -> ()
     | Start { registry; log } ->
       require_creatable_directory registry;
       Local_file.require_directory
         Eio.Path.(fs / Filename.dirname log)
         ~operation:"initialize daemon log";
       (match Eio.Path.kind ~follow:false Eio.Path.(fs / log) with
        | `Not_found | `Regular_file -> ()
        | _ ->
          Json.fail
            Invalid_argument
            (sprintf
               "initialize daemon log %S: requires a regular file or a fresh path"
               log)));
    let request_directory =
      match Cli_context.request_directory t.context with
      | None -> directory
      | Some directory ->
        Local_file.protect
          ~operation:"initialize request directory"
          ~path:directory
          (fun () -> Disk.ensure_directory Eio.Path.(fs / directory))
        |> Disk.unwrap;
        directory
    in
    let client =
      Client.create
        ~net:(Eio.Stdenv.net env)
        ~clock:(Eio.Stdenv.mono_clock env)
        ~socket:(Cli_context.socket t.context)
        ~timeout_seconds:t.timeout_seconds
      |> Disk.unwrap
    in
    let list_request =
      Protocol.Request.create
        ~id:"cli-init"
        ~method_:"workspace.list"
        ~params:(Json.obj [])
      |> Disk.unwrap
    in
    let list () = Client.invoke client list_request in
    let listing =
      match probe_listing client list_request with
      | Ok (Protocol.Success value) -> value
      | Ok (Failure problem) -> raise (Json.Decode_error problem)
      | Error problem ->
        (match t.startup with
         | Existing -> raise (Json.Decode_error problem)
         | Start { registry; log } ->
           (start_daemon_after_probe
              ~before_probe:None
              ~env
              ~socket:(Cli_context.socket t.context)
              ~timeout_seconds:t.timeout_seconds
              ~executable:daemon_executable
              ~client
              ~list_request
              ~initial_problem:problem
              ~registry
              ~log)
             .listing)
    in
    let find listing =
      Json.field (Json.field listing "data") "workspaces"
      |> Json.list
      |> List.find ~f:(fun value ->
        String.equal (Json.field value "workspace_id" |> Json.text) t.workspace_id)
    in
    let existing = find listing in
    if Option.is_none t.actor_id && Option.is_none existing
    then
      Json.fail
        Invalid_argument
        "observer init requires an existing open workspace; supply --actor-id to create \
         it";
    let root =
      match existing with
      | Some value ->
        let existing_root = Json.field value "root" |> Json.text in
        Option.iter t.root ~f:(fun root ->
          if not (String.equal (Platform.realpath root) (Platform.realpath existing_root))
          then Json.fail Conflict "workspace ID is registered at another root");
        existing_root
      | None ->
        (match t.root with
         | Some root -> root
         | None -> Json.fail Invalid_argument "new workspace requires --root")
    in
    let mutate method_ fields =
      let actor =
        match t.actor_id with
        | Some actor -> actor
        | None ->
          Json.fail
            Invalid_argument
            "observer init cannot open a closed workspace; supply --actor-id explicitly"
      in
      let request =
        Protocol.Request.create
          ~id:"cli-init"
          ~method_
          ~params:
            (Json.obj
               ([ "actor_id", Json.string actor
                ; "workspace_id", Json.string t.workspace_id
                ; "mutation_id", Json.string (random_name env)
                ]
                @ fields))
        |> Disk.unwrap
      in
      let path = Filename.concat request_directory (random_name env ^ ".json") in
      Local_file.write_new
        ~operation:"save initialization request"
        Eio.Path.(fs / path)
        (Json.canonical (Protocol.Request.to_json request));
      on_saved_request path;
      Result.bind (Client.invoke client request) ~f:(fun value ->
        Json.decode (fun () ->
          let envelope = Api_response.of_json value |> Disk.unwrap in
          Api_response.require_durable envelope |> Disk.unwrap;
          value))
    in
    (match existing with
     | Some _ -> ()
     | None ->
       let name =
         match t.name with
         | Some name -> name
         | None -> Json.fail Invalid_argument "new workspace requires --name"
       in
       (match
          mutate "workspace.create" [ "root", Json.string root; "name", Json.string name ]
        with
        | Ok _ -> ()
        | Error problem ->
          (* Another explicit bootstrap may have registered the same identity.
             This observation does not reissue our uncertain mutation. *)
          let registered = list () |> Disk.unwrap |> find in
          (match registered with
           | Some value
             when String.equal
                    (Platform.realpath (Json.field value "root" |> Json.text))
                    (Platform.realpath root) -> ()
           | None | Some _ -> raise (Json.Decode_error problem))));
    let current = list () |> Disk.unwrap |> find in
    (match current with
     | Some value ->
       (match Json.field value "open" with
        | `False -> mutate "workspace.open" [] |> Disk.unwrap |> ignore
        | `True -> ()
        | _ -> Json.fail Invalid_argument "invalid workspace listing")
     | None -> Json.fail Not_found "workspace disappeared during explicit setup");
    (match t.previous with
     | Some _ -> ()
     | None ->
       (match
          Cli_context.save
            t.context
            ~fs
            ~random:(Eio.Stdenv.secure_random env)
            t.context_file
        with
        | Ok () -> ()
        | Error problem ->
          let previous = Cli_context.load ~fs t.context_file |> Disk.unwrap in
          if not (same_context previous t.context) then raise (Json.Decode_error problem)));
    Json.obj
      [ "context", Cli_context.to_json t.context
      ; "context_file", Json.string t.context_file
      ; "root", Json.string root
      ; ( "daemon_startup"
        , match t.startup with
          | Existing -> Json.obj [ "policy", Json.string "existing" ]
          | Start { registry; log } ->
            Json.obj
              [ "policy", Json.string "start_if_unavailable"
              ; "registry", Json.string registry
              ; "log", Json.string log
              ] )
      ])
;;
