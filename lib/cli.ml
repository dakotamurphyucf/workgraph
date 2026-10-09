open Core

let usage =
  {|Usage:
  workgraph --version
  workgraph methods [--core] [--output json|text]
  workgraph help METHOD [--brief|--full] [--output json|text]
  workgraph schema [METHOD]
  workgraph serve ABS_REGISTRY ABS_SOCKET
  workgraph call ABS_SOCKET METHOD PARAMS_JSON
  workgraph request [ABS_SOCKET] METHOD [OPTIONS] [--FIELD VALUE ...]
  workgraph FAMILY ACTION [ABS_SOCKET] [OPTIONS] [--FIELD VALUE ...]
  workgraph retry [ABS_SOCKET] REQUEST_FILE [--timeout SECONDS] [--output text]
  workgraph evidence-run --stage ABS_DIR --cwd ABS_DIR [--source-root ABS_GIT_ROOT]
    [--output-limit BYTES] -- COMMAND ARG...
  workgraph evidence-publish [ABS_SOCKET] --stage ABS_DIR --workspace-id ID
    --actor-id ID --mutation-id ID --resource-id ID --expected-revision N --title TEXT
  workgraph evidence-publish [ABS_SOCKET] --stage ABS_DIR [--timeout SECONDS]
  workgraph init --context ABS_FILE --socket ABS_SOCKET --workspace-id ID
    --actor-id ID --root ABS_ROOT --name NAME [--request-directory ABS_DIR]
    [--start-daemon true --registry ABS_REGISTRY --daemon-log ABS_LOG]

Agent-local defaults:
  --context ABS_FILE            Load explicit socket/workspace/actor/run defaults
  --socket ABS_SOCKET           Override context or positional socket
  --self                        Select context actor recipient or current run explicitly
  --request-directory ABS_DIR   Journal durable writes before transmission

Request options:
  --output json|text            JSON output (default) or human-readable result
  --timeout SECONDS             Finite request timeout (default 30)
  --params-file FILE            Read a JSON parameter object
  --json-field FIELD JSON       Typed parameter
  --field-file FIELD FILE       Read a UTF-8 string parameter
  --save-request ABS_FILE       Sync a new exact retry file before sending

Field names use hyphens or underscores. --workspace-id and --actor-id specify
scope and attribution; --actor and --text are literal payload fields.
Context defaults never select a current ticket. Explicit fields override defaults.
Reissuing generates a new identity when journaling; retry preserves the saved
operation. No automatic retries or implicit workspace creation occur.
|}
;;

type options =
  { fields : (string * Jsonaf.t) list
  ; named_fields : string list
  ; self : bool
  ; text : bool
  ; timeout_seconds : float
  ; save_request : string option
  ; request_directory : string option
  }

let field_name value = String.tr value ~target:'-' ~replacement:'_'

let parse_options ~fs arguments =
  let initial =
    { fields = []
    ; named_fields = []
    ; self = false
    ; text = false
    ; timeout_seconds = 30.
    ; save_request = None
    ; request_directory = None
    }
  in
  let add options key value =
    let key = field_name key in
    if List.Assoc.mem options.fields key ~equal:String.equal
    then Json.fail Invalid_argument ("duplicate CLI field: " ^ key);
    { options with fields = options.fields @ [ key, value ] }
  in
  let rec loop options = function
    | [] -> options
    | "--self" :: rest ->
      if options.self then Json.fail Invalid_argument "duplicate --self option";
      loop { options with self = true } rest
    | "--output" :: "text" :: rest -> loop { options with text = true } rest
    | "--output" :: "json" :: rest -> loop { options with text = false } rest
    | "--request-directory" :: directory :: rest ->
      Disk.absolute directory;
      loop { options with request_directory = Some directory } rest
    | "--json" :: rest -> loop { options with text = false } rest
    | "--timeout" :: value :: rest ->
      let timeout_seconds =
        match Float.of_string_opt value with
        | Some value -> value
        | None -> Json.fail Invalid_argument "invalid timeout"
      in
      loop { options with timeout_seconds } rest
    | "--save-request" :: file :: rest ->
      if Option.is_some options.save_request
      then Json.fail Invalid_argument "duplicate save-request option";
      loop { options with save_request = Some file } rest
    | "--params-file" :: file :: rest ->
      let json =
        Local_file.read Eio.Path.(fs / file) ~operation:"read parameter file"
        |> Json.parse
        |> Disk.unwrap
      in
      let options =
        match json with
        | `Object fields ->
          List.fold fields ~init:options ~f:(fun o (key, value) -> add o key value)
        | _ -> Json.fail Invalid_argument "parameter file requires an object"
      in
      loop options rest
    | "--json-field" :: key :: value :: rest ->
      loop (add options key (Json.parse value |> Disk.unwrap)) rest
    | "--field-file" :: key :: file :: rest ->
      let bytes = Local_file.read Eio.Path.(fs / file) ~operation:"read field file" in
      if
        not
          (Uutf.String.fold_utf_8
             (fun valid _ -> function
                | `Uchar _ -> valid
                | `Malformed _ -> false)
             true
             bytes)
      then Json.fail Invalid_argument "field file must be UTF-8";
      loop (add options key (Json.string bytes)) rest
    | flag :: value :: rest when String.is_prefix flag ~prefix:"--" ->
      let key = field_name (String.drop_prefix flag 2) in
      let options = add options key (Json.string value) in
      loop { options with named_fields = key :: options.named_fields } rest
    | _ -> Json.fail Invalid_argument "malformed CLI options; use --help"
  in
  loop initial arguments
;;

let render_text value =
  let rec render indent = function
    | `Object fields ->
      List.concat_map fields ~f:(fun (key, value) ->
        match value with
        | `Object _ | `Array _ -> (indent ^ key ^ ":") :: render (indent ^ "  ") value
        | _ -> [ indent ^ key ^ ": " ^ String.concat ~sep:"\n" (render "" value) ])
    | `Array [] -> [ indent ^ "(none)" ]
    | `Array values ->
      List.concat_map values ~f:(fun value ->
        (indent ^ "-") :: render (indent ^ "  ") value)
    | `String value -> [ indent ^ value ]
    | (`Null | `True | `False | `Number _) as value -> [ indent ^ Json.canonical value ]
  in
  String.concat ~sep:"\n" (render "" value)
;;

let needs_mutation_id = Cli_mutation_identity.required

let run ~env arguments =
  let fs = (Eio.Stdenv.fs env :> Eio.Fs.dir_ty Eio.Path.t) in
  let output text = Platform.write_string (Eio.Stdenv.stdout env) (text ^ "\n") in
  let diagnostic text = Platform.write_string (Eio.Stdenv.stderr env) (text ^ "\n") in
  let execute socket options request =
    let method_ = Protocol.Request.method_ request in
    if
      Option.is_none (Api_catalog.find method_)
      && not
           (List.mem
              [ "resource.upload"; "resource.download" ]
              method_
              ~equal:String.equal)
    then
      Json.fail
        Invalid_argument
        ("unknown method: "
         ^ method_
         ^ "; use workgraph methods to list methods; ticket.get reads ticket context");
    let client =
      Client.create
        ~net:(Eio.Stdenv.net env)
        ~clock:(Eio.Stdenv.mono_clock env)
        ~socket
        ~timeout_seconds:options.timeout_seconds
      |> Disk.unwrap
    in
    let request =
      Cli_mutation_identity.ensure
        request
        ~random:(Eio.Stdenv.secure_random env)
        ~allow_generate:
          (Option.is_some options.save_request || Option.is_some options.request_directory)
      |> Disk.unwrap
    in
    let upload =
      if String.equal (Protocol.Request.method_ request) "resource.upload"
      then
        Some
          (Transfer.Upload_plan.prepare ~fs ~params:(Protocol.Request.params request)
           |> Disk.unwrap)
      else None
    in
    let request =
      match upload with
      | None -> request
      | Some plan ->
        Protocol.Request.with_params request (Transfer.Upload_plan.params plan)
        |> Disk.unwrap
    in
    let save_request =
      match options.save_request, options.request_directory with
      | Some path, _ -> Some path
      | None, Some directory when needs_mutation_id request ->
        Local_file.require_directory Eio.Path.(fs / directory) ~operation:"save request";
        let bytes = Cstruct.create 32 in
        Eio.Flow.read_exact (Eio.Stdenv.secure_random env) bytes;
        Some (Filename.concat directory (Json.hash (Cstruct.to_string bytes) ^ ".json"))
      | None, _ -> None
    in
    Option.iter save_request ~f:(fun file ->
      Disk.absolute file;
      Local_file.write_new
        ~operation:"save request"
        Eio.Path.(fs / file)
        (Json.canonical (Protocol.Request.to_json request));
      diagnostic ("saved_request: " ^ file));
    let response =
      match upload with
      | Some plan -> Protocol.Success (Transfer.upload plan ~client ~fs |> Disk.unwrap)
      | None when String.equal (Protocol.Request.method_ request) "resource.download" ->
        let plan =
          Transfer.Download.of_params (Protocol.Request.params request) |> Disk.unwrap
        in
        Protocol.Success
          (Transfer.download plan ~client ~fs ~random:(Eio.Stdenv.secure_random env)
           |> Disk.unwrap
           |> Api_response.project Value
           |> Api_response.to_json)
      | None -> Client.execute client request |> Disk.unwrap
    in
    (match response with
     | Success value when needs_mutation_id request ->
       let envelope = Api_response.of_json value |> Disk.unwrap in
       Api_response.require_durable envelope |> Disk.unwrap
     | Success _ | Failure _ -> ());
    if options.text
    then (
      match response with
      | Success value -> output (render_text value)
      | Failure error -> diagnostic (Json.canonical (Problem.to_json error)))
    else output (Json.canonical (Protocol.response_json request response));
    match response with
    | Success _ -> 0
    | Failure _ -> 1
  in
  let context = ref None in
  let request socket method_ options =
    let method_ =
      if String.equal method_ "ticket.get" then "ticket.context" else method_
    in
    let options =
      if options.self
      then
        { options with
          fields =
            Cli_context.apply_self !context ~method_ ~fields:options.fields |> Disk.unwrap
        }
      else options
    in
    let options =
      match Api_catalog.find method_ with
      | None -> options
      | Some (Api_method.Packed.Pack method_definition) ->
        let codec = Api_method.request_codec method_definition in
        { options with
          fields =
            List.map options.fields ~f:(fun (key, value) ->
              if List.mem options.named_fields key ~equal:String.equal
              then
                key, Api_codec.cli_value codec ~field:key (Json.text value) |> Disk.unwrap
              else key, value)
        }
    in
    let fields =
      Option.value_map !context ~default:options.fields ~f:(fun context ->
        Cli_context.apply context ~method_ ~fields:options.fields)
    in
    let options =
      { options with
        fields
      ; request_directory =
          (match options.request_directory with
           | Some _ as directory -> directory
           | None -> Option.bind !context ~f:Cli_context.request_directory)
      }
    in
    let value =
      Protocol.Request.create ~id:"cli" ~method_ ~params:(Json.obj options.fields)
      |> Disk.unwrap
    in
    execute socket options value
  in
  let result =
    Disk.protect (fun () ->
      let rec select context_file socket reversed = function
        | "--" :: rest -> context_file, socket, List.rev reversed @ ("--" :: rest)
        | "--context" :: path :: rest ->
          if Option.is_some context_file
          then Json.fail Invalid_argument "duplicate context";
          Disk.absolute path;
          select (Some path) socket reversed rest
        | "--socket" :: path :: rest ->
          if Option.is_some socket then Json.fail Invalid_argument "duplicate socket";
          Disk.absolute path;
          select context_file (Some path) reversed rest
        | (("--json-field" | "--field-file") as flag) :: key :: value :: rest ->
          select context_file socket (value :: key :: flag :: reversed) rest
        | (("--json" | "--help" | "--version" | "--self") as flag) :: rest ->
          select context_file socket (flag :: reversed) rest
        | flag :: value :: rest when String.is_prefix flag ~prefix:"--" ->
          select context_file socket (value :: flag :: reversed) rest
        | value :: rest -> select context_file socket (value :: reversed) rest
        | [] -> context_file, socket, List.rev reversed
      in
      let context_file, socket_override, arguments = select None None [] arguments in
      let offline =
        match arguments with
        | []
        | [ "--help" ]
        | [ "--version" ]
        | [ "version" ]
        | "help" :: _
        | "methods" :: _
        | "schema" :: _
        | [ ("init" | "bootstrap"); "--help" ] -> true
        | _ -> false
      in
      context
      := if offline
         then None
         else
           Option.bind context_file ~f:(fun path ->
             if
               List.mem
                 [ "init"; "bootstrap" ]
                 (Option.value (List.hd arguments) ~default:"")
                 ~equal:String.equal
               &&
               match Eio.Path.kind ~follow:false Eio.Path.(fs / path) with
               | `Not_found -> true
               | _ -> false
             then None
             else Some (Cli_context.load ~fs path |> Disk.unwrap));
      let default_socket =
        match socket_override with
        | Some socket -> Some socket
        | None -> Option.map !context ~f:Cli_context.socket
      in
      let with_socket rest =
        match rest with
        | socket :: rest when Filename.is_absolute socket ->
          Option.value socket_override ~default:socket, rest
        | rest ->
          (match default_socket with
           | Some socket -> socket, rest
           | None ->
             Json.fail Invalid_argument "supply an absolute socket or --context/--socket")
      in
      match arguments with
      | "evidence-run" :: rest ->
        let plan = Execution_cli.of_arguments rest |> Disk.unwrap in
        let summary, code = Execution_cli.run plan ~env |> Disk.unwrap in
        output (Json.canonical summary);
        code
      | "evidence-publish" :: rest ->
        let socket, rest = with_socket rest in
        let options = parse_options ~fs rest in
        if options.self
        then Json.fail Invalid_argument "--self is unsupported for evidence-publish";
        let directory =
          match List.Assoc.find options.fields "stage" ~equal:String.equal with
          | None -> Json.fail Invalid_argument "evidence-publish requires --stage"
          | Some value -> Json.text value
        in
        Disk.absolute directory;
        let fields = List.Assoc.remove options.fields "stage" ~equal:String.equal in
        let saved = Filename.concat directory "publication.json" in
        let publication =
          match
            Local_file.protect
              ~operation:"inspect publication intent"
              ~path:saved
              (fun () -> Eio.Path.kind ~follow:false Eio.Path.(fs / saved))
            |> Disk.unwrap
          with
          | `Not_found ->
            let fields =
              Option.value_map !context ~default:fields ~f:(fun context ->
                Cli_context.apply context ~method_:"resource.upload" ~fields)
            in
            let stage = Execution_stage.load ~fs ~directory |> Disk.unwrap in
            Execution_publication.prepare
              stage
              ~fs
              ~random:(Eio.Stdenv.secure_random env)
              ~params:(Json.obj fields)
            |> Disk.unwrap
          | _ ->
            if not (List.is_empty fields)
            then
              Json.fail
                Invalid_argument
                "publication already saved; retry with --stage and transport/output \
                 options only";
            Execution_publication.load ~fs ~directory |> Disk.unwrap
        in
        diagnostic ("saved_request: " ^ Execution_publication.saved_request publication);
        let request_directory =
          match options.request_directory with
          | Some _ as directory -> directory
          | None -> Option.bind !context ~f:Cli_context.request_directory
        in
        let journal =
          match options.save_request, request_directory with
          | Some destination, _ -> Some destination
          | None, Some directory ->
            Some (Execution_publication.journal_path publication ~directory |> Disk.unwrap)
          | None, None -> None
        in
        Option.iter journal ~f:(fun destination ->
          Execution_publication.journal publication ~fs ~destination |> Disk.unwrap;
          diagnostic ("saved_request: " ^ destination));
        let client =
          Client.create
            ~net:(Eio.Stdenv.net env)
            ~clock:(Eio.Stdenv.mono_clock env)
            ~socket
            ~timeout_seconds:options.timeout_seconds
          |> Disk.unwrap
        in
        let receipt =
          Execution_publication.publish publication ~client ~fs |> Disk.unwrap
        in
        output
          (if options.text
           then render_text receipt
           else
             Protocol.response_json
               (Execution_publication.request publication)
               (Protocol.Success receipt)
             |> Json.canonical);
        0
      | [] | [ "--help" ] | [ "help" ] ->
        output usage;
        0
      | [ "version" ] | [ "--version" ] ->
        output Version.value;
        0
      | "schema" :: rest ->
        let method_name =
          match rest with
          | [] -> None
          | [ name ] -> Some name
          | _ -> Json.fail Invalid_argument "schema accepts at most one method name"
        in
        output (Cli_reference.schema ~method_name () |> Disk.unwrap |> Json.canonical);
        0
      | "methods" :: _ | "help" :: _ ->
        let method_name, options =
          match arguments with
          | "methods" :: rest -> None, rest
          | "help" :: name :: rest -> Some name, rest
          | _ -> Json.fail Invalid_argument "help requires a method name"
        in
        let rec parse options json core detail =
          match options with
          | [] -> json, core, detail
          | "--output" :: "text" :: rest -> parse rest false core detail
          | "--output" :: "json" :: rest -> parse rest true core detail
          | "--core" :: rest when Option.is_none method_name ->
            parse rest json true detail
          | "--brief" :: rest when Option.is_some method_name ->
            parse rest json core Cli_reference.Detail.Brief
          | "--full" :: rest when Option.is_some method_name ->
            parse rest json core Cli_reference.Detail.Full
          | _ ->
            Json.fail
              Invalid_argument
              "reference options: methods --core; help METHOD --brief|--full; --output \
               json|text"
        in
        let json, core, detail = parse options false false Cli_reference.Detail.Brief in
        output
          (if json
           then
             Cli_reference.schema ~core ~method_name () |> Disk.unwrap |> Json.canonical
           else Cli_reference.help ~detail ~core ~method_name () |> Disk.unwrap);
        0
      | [ ("init" | "bootstrap"); "--help" ] ->
        output Cli_bootstrap.help;
        0
      | ("init" | "bootstrap") :: rest ->
        let options = parse_options ~fs rest in
        if options.self then Json.fail Invalid_argument "--self is unsupported for init";
        if Option.is_some options.save_request
        then
          Json.fail
            Invalid_argument
            "init saves administrative requests beside its context; --save-request is \
             not accepted";
        let context_file =
          match context_file with
          | Some path -> path
          | None -> Json.fail Invalid_argument "init requires --context"
        in
        let socket =
          match default_socket with
          | Some socket -> socket
          | None -> Json.fail Invalid_argument "init requires --socket"
        in
        let plan =
          Cli_bootstrap.create
            ~context_file
            ~socket
            ~previous:!context
            ~fields:options.fields
            ~request_directory:options.request_directory
            ~timeout_seconds:options.timeout_seconds
          |> Disk.unwrap
        in
        let value =
          Cli_bootstrap.run plan ~env ~on_saved_request:(fun path ->
            diagnostic ("saved_request: " ^ path))
          |> Disk.unwrap
        in
        output (if options.text then render_text value else Json.canonical value);
        0
      | [ "serve"; registry; socket ] ->
        Service.run ~env ~registry ~socket;
        0
      | "call" :: rest ->
        let socket, rest = with_socket rest in
        (match rest with
         | method_ :: params :: rest ->
           let fields =
             match Json.parse params |> Disk.unwrap with
             | `Object fields -> fields
             | _ -> Json.fail Invalid_argument "call parameters require an object"
           in
           let options = parse_options ~fs rest in
           if not (List.is_empty options.fields)
           then
             Json.fail Invalid_argument "call fields must be supplied in its JSON object";
           request socket method_ { options with fields }
         | _ -> Json.fail Invalid_argument "call requires method and JSON parameters")
      | "retry" :: rest ->
        let socket, rest =
          match rest with
          | socket :: file :: rest
            when Filename.is_absolute socket && not (String.is_prefix file ~prefix:"--")
            -> Option.value socket_override ~default:socket, file :: rest
          | rest ->
            (match default_socket with
             | Some socket -> socket, rest
             | None -> Json.fail Invalid_argument "retry requires a socket")
        in
        let file, rest =
          match rest with
          | file :: rest -> file, rest
          | [] -> Json.fail Invalid_argument "retry requires a request file"
        in
        let options = parse_options ~fs rest in
        if
          (not (List.is_empty options.fields))
          || options.self
          || Option.is_some options.save_request
          || Option.is_some options.request_directory
        then Json.fail Invalid_argument "retry cannot change or resave request parameters";
        let request =
          Local_file.read Eio.Path.(fs / file) ~operation:"read retry request"
          |> Json.parse
          |> Disk.unwrap
          |> Protocol.Request.of_json
          |> Disk.unwrap
        in
        execute socket options request
      | "request" :: rest ->
        let explicit_socket =
          Option.value_map (List.hd rest) ~default:false ~f:Filename.is_absolute
        in
        let socket, rest =
          match rest with
          | [] ->
            Json.fail
              Invalid_argument
              "request requires an action: --context ABS_FILE request get/list/...; or \
               request ABS_SOCKET METHOD"
          | action :: tail when not explicit_socket ->
            let domain_method = "request." ^ action in
            let method_ =
              if Option.is_some (Api_catalog.find domain_method)
              then domain_method
              else if
                String.contains action '.' || Option.is_some (Api_catalog.find action)
              then action
              else
                Json.fail
                  Invalid_argument
                  "use --context ABS_FILE request get/list/... or request ABS_SOCKET \
                   METHOD"
            in
            if Option.is_none default_socket
            then
              Json.fail
                Invalid_argument
                "supply --context ABS_FILE or --socket ABS_SOCKET for request actions; \
                 generic transport is request ABS_SOCKET METHOD";
            with_socket (method_ :: tail)
          | _ -> with_socket rest
        in
        (match rest with
         | method_ :: rest -> request socket method_ (parse_options ~fs rest)
         | [] ->
           Json.fail Invalid_argument "request requires METHOD: request ABS_SOCKET METHOD")
      | family :: action :: rest ->
        let socket, rest = with_socket rest in
        request socket (family ^ "." ^ action) (parse_options ~fs rest)
      | _ -> Json.fail Invalid_argument "invalid command; use --help")
  in
  match result with
  | Ok code -> code
  | Error error ->
    diagnostic (Json.canonical (Problem.to_json error));
    1
;;
