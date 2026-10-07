open Core

let usage =
  {|Usage:
  workgraph --version
  workgraph serve ABS_REGISTRY ABS_SOCKET
  workgraph call ABS_SOCKET METHOD PARAMS_JSON
  workgraph request ABS_SOCKET METHOD [OPTIONS] [--FIELD VALUE ...]
  workgraph FAMILY ACTION ABS_SOCKET [OPTIONS] [--FIELD VALUE ...]
  workgraph retry ABS_SOCKET REQUEST_FILE [--timeout SECONDS] [--text]
  workgraph resource upload ABS_SOCKET --workspace ID --actor ID --resource-id ID
    --expected-revision REV --title TEXT --file ABS_FILE --save-request FILE
  workgraph resource download ABS_SOCKET --workspace ID --resource-id ID
    --destination ABS_NEW_FILE [--version REV]

Request options:
  --json                       Stable JSON output (default)
  --text                       Human-readable result
  --timeout SECONDS             Finite request timeout (default 30)
  --params-file FILE           Read a JSON parameter object
  --json-field FIELD JSON      Object, array, null or other typed parameter
  --field-file FIELD FILE      Read a UTF-8 string parameter from a file
  --save-request FILE          Sync a new retry file before sending; generates a
                              mutation ID when absent on a mutation request

Field names use hyphens or underscores. --workspace and --actor are aliases for
--workspace-id and --actor-id. Values are strings except known boolean flags.
Use --json-field to set null or structured values. No automatic retries occur.
After Outcome_unknown, retry the identical saved request or inspect its receipt.
|}
;;

type options =
  { fields : (string * Jsonaf.t) list
  ; text : bool
  ; timeout_seconds : float
  ; save_request : string option
  }

let field_name value =
  let value = String.tr value ~target:'-' ~replacement:'_' in
  match value with
  | "workspace" -> "workspace_id"
  | "actor" -> "actor_id"
  | _ -> value
;;

let parse_options ~fs arguments =
  let initial =
    { fields = []; text = false; timeout_seconds = 30.; save_request = None }
  in
  let add options key value =
    let key = field_name key in
    if List.Assoc.mem options.fields key ~equal:String.equal
    then Json.fail Invalid_argument ("duplicate CLI field: " ^ key);
    { options with fields = options.fields @ [ key, value ] }
  in
  let rec loop options = function
    | [] -> options
    | "--text" :: rest -> loop { options with text = true } rest
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
      let json = Disk.read Eio.Path.(fs / file) |> Json.parse |> Disk.unwrap in
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
      let bytes = Disk.read Eio.Path.(fs / file) in
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
      let value =
        if
          List.mem
            [ "archived"; "include_archived"; "include_tombstones"; "allow_partial" ]
            key
            ~equal:String.equal
        then (
          match value with
          | "true" -> `True
          | "false" -> `False
          | _ -> Json.fail Invalid_argument (key ^ " requires true or false"))
        else Json.string value
      in
      loop (add options key value) rest
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

let needs_mutation_id request =
  Protocol.Request.equal_mode (Protocol.Request.mode request) Write
  && not
       (List.mem
          [ "daemon.shutdown"
          ; "upload.begin"
          ; "upload.chunk"
          ; "upload.abort"
          ; "resource.download"
          ]
          (Protocol.Request.method_ request)
          ~equal:String.equal)
;;

let run ~env arguments =
  let fs = (Eio.Stdenv.fs env :> Eio.Fs.dir_ty Eio.Path.t) in
  let output text = Platform.write_string (Eio.Stdenv.stdout env) (text ^ "\n") in
  let diagnostic text = Platform.write_string (Eio.Stdenv.stderr env) (text ^ "\n") in
  let execute socket options request =
    let client =
      Client.create
        ~net:(Eio.Stdenv.net env)
        ~clock:(Eio.Stdenv.mono_clock env)
        ~socket
        ~timeout_seconds:options.timeout_seconds
      |> Disk.unwrap
    in
    let request =
      if
        needs_mutation_id request
        && Option.is_none (Json.optional (Protocol.Request.params request) "mutation_id")
      then (
        match options.save_request with
        | None ->
          Json.fail Invalid_argument "mutations require --mutation-id or --save-request"
        | Some _ ->
          let bytes = Cstruct.create 32 in
          Eio.Flow.read_exact (Eio.Stdenv.secure_random env) bytes;
          let fields =
            match Protocol.Request.params request with
            | `Object fields -> fields
            | _ -> assert false
          in
          Protocol.Request.create
            ~id:"cli"
            ~method_:(Protocol.Request.method_ request)
            ~params:
              (Json.obj
                 (("mutation_id", Json.string (Json.hash (Cstruct.to_string bytes)))
                  :: fields))
          |> Disk.unwrap)
      else request
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
    Option.iter options.save_request ~f:(fun file ->
      Disk.write_new
        Eio.Path.(fs / file)
        (Json.canonical (Protocol.Request.to_json request)));
    let response =
      match upload with
      | Some plan -> Protocol.Success (Transfer.upload plan ~client ~fs |> Disk.unwrap)
      | None when String.equal (Protocol.Request.method_ request) "resource.download" ->
        let plan =
          Transfer.Download.of_params (Protocol.Request.params request) |> Disk.unwrap
        in
        Protocol.Success
          (Transfer.download plan ~client ~fs ~random:(Eio.Stdenv.secure_random env)
           |> Disk.unwrap)
      | None -> Client.execute client request |> Disk.unwrap
    in
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
  let request socket method_ options =
    let value =
      Protocol.Request.create ~id:"cli" ~method_ ~params:(Json.obj options.fields)
      |> Disk.unwrap
    in
    execute socket options value
  in
  let result =
    Disk.protect (fun () ->
      match arguments with
      | [] | [ "--help" ] | [ "help" ] ->
        output usage;
        0
      | [ "version" ] | [ "--version" ] ->
        output Version.value;
        0
      | [ "serve"; registry; socket ] ->
        Service.run ~env ~registry ~socket;
        0
      | [ "call"; socket; method_; params ] ->
        let params = Json.parse params |> Disk.unwrap in
        let options = parse_options ~fs [] in
        execute
          socket
          options
          (Protocol.Request.create ~id:"cli" ~method_ ~params |> Disk.unwrap)
      | "retry" :: socket :: file :: rest ->
        let options = parse_options ~fs rest in
        if (not (List.is_empty options.fields)) || Option.is_some options.save_request
        then Json.fail Invalid_argument "retry cannot change or resave request parameters";
        let request =
          Disk.read Eio.Path.(fs / file)
          |> Json.parse
          |> Disk.unwrap
          |> Protocol.Request.of_json
          |> Disk.unwrap
        in
        execute socket options request
      | "request" :: socket :: method_ :: rest ->
        request socket method_ (parse_options ~fs rest)
      | family :: action :: socket :: rest ->
        request socket (family ^ "." ^ action) (parse_options ~fs rest)
      | _ -> Json.fail Invalid_argument "invalid command; use --help")
  in
  match result with
  | Ok code -> code
  | Error error ->
    diagnostic (Json.canonical (Problem.to_json error));
    1
;;
