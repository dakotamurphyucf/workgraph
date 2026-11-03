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
  workgraph METHOD [ABS_SOCKET] [OPTIONS] [--FIELD VALUE ...]
  workgraph FAMILY ACTION... [ABS_SOCKET] [OPTIONS] [--FIELD VALUE ...]
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
  --params-file FILE|-          Read a JSON object (one bounded stdin source)
  --json-field FIELD JSON       Typed parameter
  --field-file FIELD FILE|-     Read exact UTF-8 bytes (including newlines)
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
  ; materialized : bool
  }

let field_name value = String.tr value ~target:'-' ~replacement:'_'

let parse_options ~fs ~stdin arguments =
  let rec stdin_consumers = function
    | [] -> 0
    | "--params-file" :: "-" :: rest | "--field-file" :: _ :: "-" :: rest ->
      1 + stdin_consumers rest
    | ("--json-field" | "--field-file") :: _ :: _ :: rest -> stdin_consumers rest
    | ("--self" | "--json") :: rest -> stdin_consumers rest
    | flag :: _ :: rest when String.is_prefix flag ~prefix:"--" -> stdin_consumers rest
    | _ :: rest -> stdin_consumers rest
  in
  if stdin_consumers arguments > 1
  then Json.fail Invalid_argument "stdin permits exactly one explicit input consumer";
  let read_input file ~operation =
    if String.equal file "-"
    then (
      let max_bytes = 4 * 1024 * 1024 in
      let bytes =
        try Eio.Buf_read.(of_flow stdin ~max_size:(max_bytes + 1) |> take_all) with
        | Eio.Buf_read.Buffer_limit_exceeded ->
          Json.fail Invalid_argument "stdin exceeds 4194304-byte input limit"
      in
      if String.length bytes > max_bytes
      then Json.fail Invalid_argument "stdin exceeds 4194304-byte input limit";
      bytes)
    else Local_file.read Eio.Path.(fs / file) ~operation
  in
  let initial =
    { fields = []
    ; named_fields = []
    ; self = false
    ; text = false
    ; timeout_seconds = 30.
    ; save_request = None
    ; request_directory = None
    ; materialized = false
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
        read_input file ~operation:"read parameter file" |> Json.parse |> Disk.unwrap
      in
      let options =
        match json with
        | `Object fields ->
          List.fold
            fields
            ~init:{ options with materialized = true }
            ~f:(fun o (key, value) -> add o key value)
        | _ -> Json.fail Invalid_argument "parameter file requires an object"
      in
      loop options rest
    | "--json-field" :: key :: value :: rest ->
      loop (add options key (Json.parse value |> Disk.unwrap)) rest
    | "--field-file" :: key :: file :: rest ->
      let bytes = read_input file ~operation:"read field file" in
      if
        not
          (Uutf.String.fold_utf_8
             (fun valid _ -> function
                | `Uchar _ -> valid
                | `Malformed _ -> false)
             true
             bytes)
      then Json.fail Invalid_argument "field file must be UTF-8";
      loop (add { options with materialized = true } key (Json.string bytes)) rest
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

(* Help is a local operation. Option values and literal child argv cannot turn
   an execution into help, even when a value happens to be "--help". *)
let normalize_help arguments =
  let rec words reversed = function
    | word :: rest
      when not (String.is_prefix word ~prefix:"--" || Filename.is_absolute word) ->
      words (word :: reversed) rest
    | rest -> List.rev reversed, rest
  in
  let rec help_flag = function
    | [] | "--" :: _ -> false
    | "--help" :: _ -> true
    | ("--json-field" | "--field-file") :: _ :: _ :: rest -> help_flag rest
    | ("--self" | "--json" | "--brief" | "--full") :: rest -> help_flag rest
    | flag :: _ :: rest when String.is_prefix flag ~prefix:"--" -> help_flag rest
    | _ :: rest -> help_flag rest
  in
  let name names =
    match names with
    | "request" :: (_ :: _ as rest) ->
      (match Cli_reference.resolve_method names with
       | Ok (method_, []) -> method_
       | Ok (_, _ :: _) | Error _ ->
         (match Cli_reference.resolve_method rest with
          | Ok (method_, []) -> method_
          | Ok (_, _ :: _) | Error _ -> String.concat ~sep:"." names))
    | _ -> String.concat ~sep:"." names
  in
  let rec reference_options = function
    | [] | "--" :: _ -> []
    | (("--full" | "--brief") as flag) :: rest -> flag :: reference_options rest
    | "--output" :: value :: rest -> "--output" :: value :: reference_options rest
    | ("--json-field" | "--field-file") :: _ :: _ :: rest -> reference_options rest
    | ("--self" | "--json" | "--help") :: rest -> reference_options rest
    | flag :: _ :: rest when String.is_prefix flag ~prefix:"--" -> reference_options rest
    | _ :: rest -> reference_options rest
  in
  match arguments with
  | "help" :: rest | "schema" :: rest ->
    let names, options = words [] rest in
    let prefix = List.hd_exn arguments in
    if List.is_empty names then arguments else prefix :: name names :: options
  | [] | [ "--help" ] -> arguments
  | _ when help_flag arguments ->
    let names, _ =
      match arguments with
      | "request" :: socket :: rest when Filename.is_absolute socket -> words [] rest
      | _ -> words [] arguments
    in
    if List.equal String.equal names [ "methods" ]
    then "methods" :: reference_options arguments
    else if List.is_empty names
    then [ "--help" ]
    else "help" :: name names :: reference_options arguments
  | _ -> arguments
;;

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
    then (
      match Cli_reference.resolve_method [ method_ ] with
      | Error problem -> raise (Json.Decode_error problem)
      | Ok (canonical, _) ->
        Json.fail
          Invalid_argument
          ("method is not executable: "
           ^ method_
           ^ "; use "
           ^ canonical
           ^ " for a new request; saved retries never change methods"));
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
    if options.materialized
    then
      Option.iter
        (Api_catalog.find method_)
        ~f:(fun (Api_method.Packed.Pack definition) ->
          ignore
            (Api_codec.decode
               (Api_method.request_codec definition)
               (Protocol.Request.params request)
             |> Disk.unwrap));
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
    let download =
      if String.equal method_ "resource.download"
      then
        Some (Transfer.Download.of_params (Protocol.Request.params request) |> Disk.unwrap)
      else None
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
    let raw_download =
      String.equal method_ "resource.download"
      && Option.exists
           (Json.optional (Protocol.Request.params request) "destination")
           ~f:(fun value -> String.equal (Json.text value) "-")
    in
    let response =
      match upload with
      | Some plan -> Protocol.Success (Transfer.upload plan ~client ~fs |> Disk.unwrap)
      | None when String.equal (Protocol.Request.method_ request) "resource.download" ->
        let plan = Option.value_exn download in
        let receipt =
          if raw_download
          then (
            match plan.spool with
            | None ->
              Transfer.stream plan ~client ~output:(Eio.Stdenv.stdout env) |> Disk.unwrap
            | Some destination ->
              let receipt =
                Transfer.download
                  { plan with destination; spool = None }
                  ~client
                  ~fs
                  ~random:(Eio.Stdenv.secure_random env)
                |> Disk.unwrap
              in
              Local_file.protect
                ~operation:"copy verified spool"
                ~path:destination
                (fun () ->
                   Eio.Path.with_open_in
                     Eio.Path.(fs / destination)
                     (fun source -> Eio.Flow.copy source (Eio.Stdenv.stdout env)))
              |> Disk.unwrap;
              receipt)
          else
            Transfer.download plan ~client ~fs ~random:(Eio.Stdenv.secure_random env)
            |> Disk.unwrap
        in
        Protocol.Success (receipt |> Api_response.project Value |> Api_response.to_json)
      | None -> Client.execute client request |> Disk.unwrap
    in
    (match response with
     | Success value when needs_mutation_id request ->
       let envelope = Api_response.of_json value |> Disk.unwrap in
       Api_response.require_durable envelope |> Disk.unwrap
     | Success _ | Failure _ -> ());
    if raw_download
    then (
      match response with
      | Success value ->
        diagnostic (Json.canonical (Protocol.response_json request (Success value)))
      | Failure error -> diagnostic (Json.canonical (Problem.to_json error)))
    else if options.text
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
    let method_ = Cli_reference.canonical_method_name method_ in
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
      let arguments = normalize_help arguments in
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
        let options = parse_options ~fs ~stdin:(Eio.Stdenv.stdin env) rest in
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
        let options = parse_options ~fs ~stdin:(Eio.Stdenv.stdin env) rest in
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
           let options = parse_options ~fs ~stdin:(Eio.Stdenv.stdin env) rest in
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
        let options = parse_options ~fs ~stdin:(Eio.Stdenv.stdin env) rest in
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
          | _ :: _ when not explicit_socket ->
            let method_, tail =
              match Cli_reference.resolve_method ("request" :: rest) with
              | Ok method_ -> method_
              | Error _ -> Cli_reference.resolve_method rest |> Disk.unwrap
            in
            let socket, tail =
              match tail, default_socket with
              | socket :: _, _ when Filename.is_absolute socket -> with_socket tail
              | _, Some _ -> with_socket tail
              | _, None ->
                Json.fail
                  Invalid_argument
                  "supply --context ABS_FILE or --socket ABS_SOCKET for request actions; \
                   generic transport is request ABS_SOCKET METHOD"
            in
            socket, method_ :: tail
          | _ -> with_socket rest
        in
        (match rest with
         | _ :: _ ->
           let method_, rest = Cli_reference.resolve_method rest |> Disk.unwrap in
           request socket method_ (parse_options ~fs ~stdin:(Eio.Stdenv.stdin env) rest)
         | [] ->
           Json.fail Invalid_argument "request requires METHOD: request ABS_SOCKET METHOD")
      | _ :: _ ->
        let method_, rest = Cli_reference.resolve_method arguments |> Disk.unwrap in
        let socket, rest = with_socket rest in
        request socket method_ (parse_options ~fs ~stdin:(Eio.Stdenv.stdin env) rest))
  in
  match result with
  | Ok code -> code
  | Error error ->
    diagnostic (Json.canonical (Problem.to_json error));
    1
;;
