open Core

type t =
  { directory : string
  ; command : Execution_capture.Command.t
  }

let of_arguments arguments =
  Json.decode (fun () ->
    let rec parse fields = function
      | "--" :: argv -> fields, argv
      | (("--stage" | "--cwd" | "--source-root" | "--output-limit") as flag)
        :: value
        :: rest ->
        if Map.mem fields flag
        then Json.fail Invalid_argument ("duplicate evidence-run option: " ^ flag);
        parse (Map.set fields ~key:flag ~data:value) rest
      | _ ->
        Json.fail
          Invalid_argument
          "evidence-run requires --stage ABS --cwd ABS [--source-root ABS] \
           [--output-limit BYTES] -- COMMAND ARG..."
    in
    let fields, argv = parse String.Map.empty arguments in
    let required field =
      match Map.find fields field with
      | Some value -> value
      | None -> Json.fail Invalid_argument ("evidence-run requires " ^ field)
    in
    let directory = required "--stage" in
    Disk.absolute directory;
    let cwd = required "--cwd" in
    let output_limit =
      match Map.find fields "--output-limit" with
      | None -> 65536
      | Some text -> Json.integer (Json.string text)
    in
    let command =
      Execution_capture.Command.create ~argv ~cwd ~output_limit |> Disk.unwrap
    in
    let command =
      match Map.find fields "--source-root" with
      | None -> command
      | Some root ->
        Execution_capture.Command.with_source_root command root |> Disk.unwrap
    in
    { directory; command })
;;

let run t ~env =
  let open Result.Let_syntax in
  let%map stage = Execution_stage.run t.command ~env ~directory:t.directory in
  let capture =
    match Execution_stage.state stage with
    | Finished capture -> capture
    | Unfinished _ -> failwith "execution returned without a final staged outcome"
  in
  let output_summary output =
    Json.obj
      [ "retained_bytes", Json.int (String.length (Execution_capture.Output.bytes output))
      ; "observed_bytes", Json.int64 (Execution_capture.Output.observed_bytes output)
      ; ("eof", if Execution_capture.Output.eof output then `True else `False)
      ; ("truncated", if Execution_capture.Output.truncated output then `True else `False)
      ]
  in
  let summary =
    Json.obj
      [ "stage", Json.string t.directory
      ; "capture_file", Json.string (Filename.concat t.directory "capture.json")
      ; ( "outcome"
        , Api_codec.encode
            Execution_capture.Outcome.codec
            (Execution_capture.outcome capture)
          |> Disk.unwrap )
      ; "stdout", output_summary (Execution_capture.stdout capture)
      ; "stderr", output_summary (Execution_capture.stderr capture)
      ; ( "source_drift"
        , match
            Source_provenance.drift
              ~before:(Execution_capture.source_before capture)
              ~after:(Execution_capture.source_after capture)
          with
          | None -> `Null
          | Some true -> `True
          | Some false -> `False )
      ; "publication", Json.string "not_attempted"
      ]
  in
  let code =
    match Execution_capture.outcome capture with
    | Exited 0 -> 0
    | Exited _ | Signaled _ | Launch_failed _ | Interrupted -> 2
  in
  summary, code
;;
