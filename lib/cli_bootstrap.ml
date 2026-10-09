open Core

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
  ; actor_id : string
  ; root : string option
  ; name : string option
  ; startup : Startup.t
  ; timeout_seconds : float
  }

let create ~context_file ~socket ~previous ~fields ~request_directory ~timeout_seconds =
  Json.decode (fun () ->
    Disk.absolute context_file;
    Disk.absolute socket;
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
    let actor_id = required "actor_id" in
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
        ([ "socket", Json.string socket
         ; "workspace_id", Json.string workspace_id
         ; "actor_id", Json.string actor_id
         ]
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

let run t ~env ~on_saved_request =
  Disk.protect (fun () ->
    let fs = (Eio.Stdenv.fs env :> Eio.Fs.dir_ty Eio.Path.t) in
    let directory = Filename.dirname t.context_file in
    Disk.require_directory Eio.Path.(fs / directory);
    let require_creatable_directory path =
      match Eio.Path.kind ~follow:false Eio.Path.(fs / path) with
      | `Directory -> ()
      | `Not_found -> Disk.require_directory Eio.Path.(fs / Filename.dirname path)
      | _ ->
        Json.fail
          Invalid_argument
          "setup directory must be a real directory or a fresh path"
    in
    Option.iter t.root ~f:require_creatable_directory;
    Option.iter (Cli_context.request_directory t.context) ~f:require_creatable_directory;
    (match t.startup with
     | Existing -> ()
     | Start { registry; log } ->
       require_creatable_directory registry;
       Disk.require_directory Eio.Path.(fs / Filename.dirname log);
       (match Eio.Path.kind ~follow:false Eio.Path.(fs / log) with
        | `Not_found | `Regular_file -> ()
        | _ ->
          Json.fail Invalid_argument "daemon log must be a regular file or a fresh path"));
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
      match list () with
      | Ok value -> value
      | Error problem ->
        (match t.startup with
         | Existing -> raise (Json.Decode_error problem)
         | Start { registry; log } ->
           Eio.Process.run
             (Eio.Stdenv.process_mgr env)
             [ "/bin/sh"
             ; "-c"
             ; {|umask 077; nohup "$1" serve "$2" "$3" </dev/null >>"$4" 2>&1 &|}
             ; "workgraph-bootstrap"
             ; Stdlib.Sys.executable_name
             ; registry
             ; Cli_context.socket t.context
             ; log
             ];
           let rec wait remaining =
             match list () with
             | Ok value -> value
             | Error problem when remaining = 0 -> raise (Json.Decode_error problem)
             | Error _ ->
               Eio.Time.sleep (Eio.Stdenv.clock env) 0.1;
               wait (remaining - 1)
           in
           wait 50)
    in
    let find listing =
      Json.field (Json.field listing "data") "workspaces"
      |> Json.list
      |> List.find ~f:(fun value ->
        String.equal (Json.field value "workspace_id" |> Json.text) t.workspace_id)
    in
    let existing = find listing in
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
      let request =
        Protocol.Request.create
          ~id:"cli-init"
          ~method_
          ~params:
            (Json.obj
               ([ "actor_id", Json.string t.actor_id
                ; "workspace_id", Json.string t.workspace_id
                ; "mutation_id", Json.string (random_name env)
                ]
                @ fields))
        |> Disk.unwrap
      in
      let path = Filename.concat directory (random_name env ^ ".json") in
      Disk.write_new
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
    Option.iter (Cli_context.request_directory t.context) ~f:(fun directory ->
      Disk.ensure_directory Eio.Path.(fs / directory));
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
