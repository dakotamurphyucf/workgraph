open Core
open Workgraph
open Workgraph_ui

module Options = struct
  type t =
    { state_root : string
    ; host : string
    ; port : int
    ; open_browser : bool
    ; daemon_executable : string option
    }

  let usage =
    "workgraph-ui --state-root ABS [--host 127.0.0.1|::1] [--port 0..65535] [--no-open] \
     [--daemon-executable ABS]\n\n\
     Optional same-version local browser companion. The state root must be private.\n\
     Defaults: IPv4 loopback, ephemeral port, open browser. No daemon or profile is \
     started.\n\
     Startup emits one workgraph-ui-ready-1 JSON record to stdout; diagnostics use stderr.\n"
  ;;

  let parse arguments =
    Json.decode (fun () ->
      let rec loop arguments seen state_root host port open_browser daemon_executable =
        match arguments with
        | [] ->
          let state_root =
            Option.value_or_thunk state_root ~default:(fun () ->
              Json.fail Invalid_argument "--state-root ABS is required")
          in
          Disk.absolute state_root;
          { state_root; host; port; open_browser; daemon_executable }
        | flag :: rest ->
          if Set.mem seen flag
          then Json.fail Invalid_argument ("duplicate launcher flag: " ^ flag);
          let seen = Set.add seen flag in
          let value f =
            match rest with
            | [] -> Json.fail Invalid_argument ("missing value for " ^ flag)
            | value :: rest -> f value rest
          in
          (match flag with
           | "--state-root" ->
             value (fun value rest ->
               loop rest seen (Some value) host port open_browser daemon_executable)
           | "--host" ->
             value (fun value rest ->
               if not (String.equal value "127.0.0.1" || String.equal value "::1")
               then
                 Json.fail
                   Invalid_argument
                   "--host must be 127.0.0.1 or ::1; LAN binding is unsupported";
               loop rest seen state_root value port open_browser daemon_executable)
           | "--port" ->
             value (fun value rest ->
               let port = Json.integer (Json.string value) in
               if port > 65535 then Json.fail Invalid_argument "--port must be 0..65535";
               loop rest seen state_root host port open_browser daemon_executable)
           | "--daemon-executable" ->
             value (fun value rest ->
               Disk.absolute value;
               loop rest seen state_root host port open_browser (Some value))
           | "--no-open" -> loop rest seen state_root host port false daemon_executable
           | _ -> Json.fail Invalid_argument ("unknown launcher flag: " ^ flag))
      in
      loop arguments String.Set.empty None "127.0.0.1" 0 true None)
  ;;
end

let open_browser env url =
  let fs = Eio.Stdenv.fs env in
  let executable =
    List.find [ "/usr/bin/open"; "/usr/bin/wslview"; "/usr/bin/xdg-open" ] ~f:(fun path ->
      match Eio.Path.kind ~follow:true Eio.Path.(fs / path) with
      | `Regular_file -> true
      | _ -> false)
    |> Option.value ~default:"xdg-open"
  in
  try
    Eio.Time.Timeout.run_exn
      (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock env) 10.)
      (fun () ->
         Eio.Process.run
           (Eio.Stdenv.process_mgr env)
           ~stdin:(Eio.Flow.string_source "")
           ~stdout:(Eio.Stdenv.stderr env)
           ~stderr:(Eio.Stdenv.stderr env)
           [ executable; url ])
  with
  | Eio.Io _ | Eio.Time.Timeout ->
    Platform.write_diagnostic
      (Eio.Stdenv.stderr env)
      ("Browser opener failed; companion is running. Open " ^ url ^ "\n")
;;

let serve env options =
  Disk.protect (fun () ->
    Eio.Switch.run (fun sw ->
      let fs = Eio.Stdenv.fs env in
      let random = Eio.Stdenv.secure_random env in
      let root =
        State_root.acquire ~sw ~fs ~random ~path:options.Options.state_root |> Disk.unwrap
      in
      let executable =
        match options.daemon_executable with
        | Some path -> path
        | None ->
          Daemon_launcher.resolve_executable
            ~fs
            ~cwd:(Platform.realpath (Eio.Path.native_exn (Eio.Stdenv.cwd env)))
            ~invoked_as:(Sys.get_argv ()).(0)
            ~search_path:(Sys.getenv "PATH")
          |> Disk.unwrap
      in
      let launcher = Daemon_launcher.create ~sw ~env ~root ~executable |> Disk.unwrap in
      let admin_jobs = Admin_jobs.create ~sw ~env ~root |> Disk.unwrap in
      let wait_helper = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
      let profiles = Connection_profile.Store.create root |> Disk.unwrap in
      let view_settings = View_settings.create root |> Disk.unwrap in
      let qualification =
        Daemon_qualification.create ~clock:(Eio.Stdenv.mono_clock env)
      in
      let transfer_helper =
        Transfer_helper.create ~sw ~env ~root ~client:(fun captured ->
          let open Result.Let_syntax in
          let%bind retained =
            match
              Connection_profile.Store.find
                profiles
                ~id:(Connection_profile.id captured)
                ~generation:(Connection_profile.generation captured)
            with
            | Some retained
              when String.equal
                     (Connection_profile.socket retained)
                     (Connection_profile.socket captured) -> Ok retained
            | Some _ ->
              Error
                (Problem.create
                   Conflict
                   "retained upload profile differs from captured socket; no retargeting")
            | None ->
              Error
                (Problem.create
                   Not_found
                   "captured upload connection generation is absent; preserve saved \
                    operation")
          in
          let%bind client =
            Client.create
              ~net:(Eio.Stdenv.net env)
              ~clock:(Eio.Stdenv.mono_clock env)
              ~socket:(Connection_profile.socket retained)
              ~timeout_seconds:60.
          in
          let%map () = Daemon_qualification.check qualification client in
          client)
        |> Disk.unwrap
      in
      let execution_helper =
        Execution_helper.create ~sw ~env ~root ~client:(fun captured ->
          let open Result.Let_syntax in
          let%bind retained =
            match
              Connection_profile.Store.find
                profiles
                ~id:(Connection_profile.id captured)
                ~generation:(Connection_profile.generation captured)
            with
            | Some retained
              when String.equal
                     (Connection_profile.socket retained)
                     (Connection_profile.socket captured) -> Ok retained
            | Some _ ->
              Error
                (Problem.create
                   Conflict
                   "captured execution publication socket differs from retained \
                    generation")
            | None ->
              Error
                (Problem.create
                   Not_found
                   "original publication profile generation is absent; no retargeting")
          in
          (* Execution_helper owns one fresh qualification per explicit invocation. *)
          Client.create
            ~net:(Eio.Stdenv.net env)
            ~clock:(Eio.Stdenv.mono_clock env)
            ~socket:(Connection_profile.socket retained)
            ~timeout_seconds:60.)
        |> Disk.unwrap
      in
      let operations = Operation_store.create ~root ~random |> Disk.unwrap in
      let address =
        if String.equal options.host "::1"
        then Eio.Net.Ipaddr.V6.loopback
        else Eio.Net.Ipaddr.V4.loopback
      in
      let listener =
        Eio.Net.listen
          ~sw
          ~backlog:64
            (* Rebind after a stopped instance leaves TCP connections in TIME_WAIT.
             Never share a listening port with another companion instance. *)
          ~reuse_addr:true
          ~reuse_port:false
          (Eio.Stdenv.net env)
          (`Tcp (address, options.port))
      in
      let port =
        match Eio.Net.listening_addr listener with
        | `Tcp (_, port) -> port
        | `Unix _ -> assert false
      in
      let host =
        (if String.equal options.host "::1" then "[::1]" else options.host)
        ^ ":"
        ^ Int.to_string port
      in
      let origin = "http://" ^ host in
      let url = origin ^ "/" in
      let bytes = Cstruct.create 32 in
      Eio.Flow.read_exact random bytes;
      let capability = Json.hash (Cstruct.to_string bytes) in
      let scheduler = Read_scheduler.create () in
      let rpc =
        Rpc_bridge.create
          ~sw
          ~net:(Eio.Stdenv.net env)
          ~clock:(Eio.Stdenv.mono_clock env)
          ~random
          ~store:operations
          ~scheduler
      in
      let request_observer =
        Request_observer.create
          ~net:(Eio.Stdenv.net env)
          ~clock:(Eio.Stdenv.mono_clock env)
          ~scheduler
      in
      let router =
        Http_router.create ~host ~origin ~capability ~profiles ~operations ~rpc ~random
        |> fun router ->
        Http_router.with_view_settings router view_settings
        |> fun router ->
        Http_router.with_launcher router launcher
        |> fun router ->
        Http_router.with_admin_jobs router admin_jobs
        |> fun router ->
        Http_router.with_wait_helper router wait_helper
        |> fun router ->
        Http_router.with_transfer_helper router transfer_helper
        |> fun router ->
        Http_router.with_execution_helper router execution_helper
        |> fun router -> Http_router.with_request_observer router request_observer
      in
      Eio.Fiber.fork ~sw (fun () ->
        Http_server.serve ~sw ~clock:(Eio.Stdenv.mono_clock env) ~listener ~router);
      Eio.Fiber.yield ();
      let ready =
        Json.obj
          [ "format", Json.string "workgraph-ui-ready-1"
          ; "event", Json.string "ready"
          ; "url", Json.string url
          ; "state_root", Json.string (State_root.path root)
          ; "asset_manifest_sha256", Json.string Workgraph_ui_assets.manifest_sha256
          ; "api_prefix", Json.string "/ui-api/v1"
          ; "host", Json.string options.host
          ; "port", Json.int port
          ]
      in
      Platform.write_string (Eio.Stdenv.stdout env) (Json.canonical ready ^ "\n");
      if options.open_browser then Eio.Fiber.fork ~sw (fun () -> open_browser env url)))
;;

let () =
  let arguments = Array.to_list (Sys.get_argv ()) |> List.tl_exn in
  let code =
    try
      Eio_main.run (fun env ->
        match arguments with
        | [ "--help" ] | [ "-h" ] ->
          Platform.write_string (Eio.Stdenv.stdout env) Options.usage;
          0
        | [ "--version" ] ->
          Platform.write_string (Eio.Stdenv.stdout env) (Version.value ^ "\n");
          0
        | _ ->
          (match Result.bind (Options.parse arguments) ~f:(serve env) with
           | Ok () -> 0
           | Error problem ->
             Platform.write_diagnostic
               (Eio.Stdenv.stderr env)
               (Json.canonical (Wire.failure problem) ^ "\n");
             1))
    with
    | Platform.Broken_pipe -> 0
  in
  if code <> 0 then Stdlib.exit code
;;
