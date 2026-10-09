open Core

let unwrap = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

module Command = struct
  type t =
    { argv : string list
    ; cwd : string
    ; output_limit : int
    ; source_root : string option
    }

  let validate t =
    Json.decode (fun () ->
      if List.is_empty t.argv || List.length t.argv > 256
      then Json.fail Invalid_argument "capture requires 1..256 argv entries";
      if List.sum (module Int) t.argv ~f:String.length > 65536
      then Json.fail Invalid_argument "capture argv exceeds 65536 bytes";
      List.iter (t.cwd :: t.argv) ~f:(fun text ->
        Api_codec.decode (Api_codec.text ~max_bytes:65536) (Json.string text)
        |> unwrap
        |> ignore;
        if String.mem text '\000'
        then Json.fail Invalid_argument "capture path/argv contains NUL");
      if String.is_empty (List.hd_exn t.argv)
      then Json.fail Invalid_argument "capture executable is empty";
      if (not (Filename.is_absolute t.cwd)) || String.length t.cwd > 4096
      then Json.fail Invalid_argument "capture cwd must be an absolute path <=4096 bytes";
      if t.output_limit < 1 || t.output_limit > 1048576
      then Json.fail Invalid_argument "capture output_limit must be 1..1048576 bytes";
      Option.iter t.source_root ~f:(fun root ->
        Source_provenance.unavailable ~root ~reason:"not observed" |> unwrap |> ignore);
      t)
  ;;

  let create ~argv ~cwd ~output_limit =
    validate { argv; cwd; output_limit; source_root = None }
  ;;

  let argv t = t.argv
  let cwd t = t.cwd
  let output_limit t = t.output_limit
  let source_root t = t.source_root
  let with_source_root t root = validate { t with source_root = Some root }

  let codec =
    let open Api_codec in
    object_
      Fields.(
        both
          (both
             (required "argv" (list (text ~max_bytes:65536) ~max_items:256))
             (required "cwd" (text ~max_bytes:4096)))
          (both
             (required "output_limit" (decimal ~max:1048576))
             (optional "source_root" (text ~max_bytes:4096))))
    |> map
         ~decode:(fun ((argv, cwd), (output_limit, source_root)) ->
           validate { argv; cwd; output_limit; source_root })
         ~encode:(fun { argv; cwd; output_limit; source_root } ->
           (argv, cwd), (output_limit, source_root))
         ~description:
           "Absolute cwd; nonempty executable/argv; no NUL; total argv <=64KiB; positive \
            per-stream output limit."
  ;;
end

module Outcome = struct
  type t =
    | Exited of int
    | Signaled of int
    | Interrupted
    | Launch_failed of string
  [@@deriving sexp, equal]

  let codec =
    let open Api_codec in
    let case name payload decode encode =
      object_ Fields.(both (required "kind" (literal name)) payload)
      |> map
           ~decode:(fun ((), payload) -> decode payload)
           ~encode:(fun t -> (), encode t)
           ~description:("Execution outcome: " ^ name)
    in
    let wrong () = Json.fail Invalid_argument "incorrect execution outcome branch" in
    tagged
      ~discriminator:"kind"
      ~cases:
        [ ( "exited"
          , case
              "exited"
              Fields.(required "code" (decimal ~max:255))
              (fun code -> Ok (Exited code))
              (function
                | Exited code -> code
                | Signaled _ | Interrupted | Launch_failed _ -> wrong ()) )
        ; ( "signaled"
          , case
              "signaled"
              Fields.(required "signal" (text ~max_bytes:16))
              (fun text ->
                 Json.decode (fun () ->
                   match Int.of_string_opt text with
                   | Some signal
                     when (not (Int.equal signal 0))
                          && String.equal (Int.to_string signal) text -> Signaled signal
                   | Some _ | None ->
                     Json.fail
                       Invalid_argument
                       "signal must be a nonzero canonical signed decimal"))
              (function
                | Signaled signal -> Int.to_string signal
                | Exited _ | Interrupted | Launch_failed _ -> wrong ()) )
        ; ( "interrupted"
          , case
              "interrupted"
              Fields.empty
              (fun () -> Ok Interrupted)
              (function
                | Interrupted -> ()
                | Exited _ | Signaled _ | Launch_failed _ -> wrong ()) )
        ; ( "launch_failed"
          , case
              "launch_failed"
              Fields.(required "message" (text ~max_bytes:4096))
              (fun message ->
                 if String.is_empty (String.strip message)
                 then Error (Problem.create Invalid_argument "empty launch failure")
                 else Ok (Launch_failed message))
              (function
                | Launch_failed message -> message
                | Exited _ | Signaled _ | Interrupted -> wrong ()) )
        ]
      ~select:(function
        | Exited _ -> "exited"
        | Signaled _ -> "signaled"
        | Interrupted -> "interrupted"
        | Launch_failed _ -> "launch_failed")
  ;;
end

module Output = struct
  type t =
    { bytes : string
    ; observed_bytes : int64
    ; observed_sha256 : string
    ; eof : bool
    }

  let create ~bytes ~observed_bytes ~observed_sha256 ~eof =
    Json.decode (fun () ->
      let length = String.length bytes in
      if length > 1048576 || Int64.(observed_bytes < of_int length)
      then Json.fail Invalid_argument "invalid captured/observed byte counts";
      if
        String.length observed_sha256 <> 64
        || not
             (String.for_all observed_sha256 ~f:(fun c ->
                Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
      then Json.fail Invalid_argument "invalid observed SHA256";
      if
        Int64.equal observed_bytes (Int64.of_int length)
        && not (String.equal observed_sha256 (Json.hash bytes))
      then Json.fail Invalid_argument "captured output digest mismatch";
      { bytes; observed_bytes; observed_sha256; eof })
  ;;

  let bytes t = t.bytes
  let observed_bytes t = t.observed_bytes
  let eof t = t.eof
  let truncated t = Int64.(t.observed_bytes > of_int (String.length t.bytes))

  let codec =
    let open Api_codec in
    object_
      Fields.(
        both
          (both
             (required "base64" (text ~max_bytes:1398104))
             (required "observed_bytes" (decimal64 ~max:Int64.max_value)))
          (both
             (required "observed_sha256" (text ~max_bytes:64))
             (required "eof" boolean)))
    |> map
         ~decode:(fun ((base64, observed_bytes), (observed_sha256, eof)) ->
           match Base64.decode base64 with
           | Error (`Msg message) -> Error (Problem.create Invalid_argument message)
           | Ok bytes ->
             if not (String.equal base64 (Base64.encode_exn bytes))
             then Error (Problem.create Invalid_argument "noncanonical captured base64")
             else create ~bytes ~observed_bytes ~observed_sha256 ~eof)
         ~encode:(fun { bytes; observed_bytes; observed_sha256; eof } ->
           (Base64.encode_exn bytes, observed_bytes), (observed_sha256, eof))
         ~description:
           "Exact binary prefix, total observed bytes and their SHA256, and separate \
            EOF/completeness indication."
  ;;
end

type t =
  { command : Command.t
  ; outcome : Outcome.t
  ; started_unix_ms : int64
  ; finished_unix_ms : int64
  ; elapsed_ms : int64
  ; stdout : Output.t
  ; stderr : Output.t
  ; source_before : Source_provenance.t
  ; source_after : Source_provenance.t
  }

let create
      ~command
      ~outcome
      ~started_unix_ms
      ~finished_unix_ms
      ~elapsed_ms
      ~stdout
      ~stderr
      ~source_before
      ~source_after
  =
  Json.decode (fun () ->
    Api_codec.encode Outcome.codec outcome |> unwrap |> ignore;
    List.iter [ source_before; source_after ] ~f:(fun source ->
      if
        not
          (Option.equal
             String.equal
             (Command.source_root command)
             (Source_provenance.root source))
      then Json.fail Invalid_argument "source provenance differs from requested root");
    if Int64.(started_unix_ms < zero || finished_unix_ms < zero || elapsed_ms < zero)
    then Json.fail Invalid_argument "capture times must be nonnegative";
    List.iter [ stdout; stderr ] ~f:(fun output ->
      if String.length (Output.bytes output) > Command.output_limit command
      then Json.fail Invalid_argument "capture exceeds command output limit");
    (match outcome with
     | Outcome.Exited _ | Signaled _ ->
       if not (Output.eof stdout && Output.eof stderr)
       then Json.fail Invalid_argument "terminal process result requires drained output"
     | Launch_failed _ ->
       if
         not
           (Int64.equal (Output.observed_bytes stdout) 0L
            && Int64.equal (Output.observed_bytes stderr) 0L)
       then Json.fail Invalid_argument "failed launch cannot have process output"
     | Interrupted -> ());
    { command
    ; outcome
    ; started_unix_ms
    ; finished_unix_ms
    ; elapsed_ms
    ; stdout
    ; stderr
    ; source_before
    ; source_after
    })
;;

let command t = t.command
let outcome t = t.outcome
let stdout t = t.stdout
let stderr t = t.stderr
let source_before t = t.source_before
let source_after t = t.source_after

let codec =
  let open Api_codec in
  let milliseconds = decimal64 ~max:Int64.max_value in
  object_
    Fields.(
      both
        (both
           (both (required "command" Command.codec) (required "outcome" Outcome.codec))
           (both
              (required "source_before" Source_provenance.codec)
              (required "source_after" Source_provenance.codec)))
        (both
           (both
              (required "started_unix_ms" milliseconds)
              (required "finished_unix_ms" milliseconds))
           (both
              (required "elapsed_ms" milliseconds)
              (both (required "stdout" Output.codec) (required "stderr" Output.codec)))))
  |> map
       ~decode:
         (fun
           ( ((command, outcome), (source_before, source_after))
           , ((started_unix_ms, finished_unix_ms), (elapsed_ms, (stdout, stderr))) ) ->
         create
           ~command
           ~outcome
           ~started_unix_ms
           ~finished_unix_ms
           ~elapsed_ms
           ~stdout
           ~stderr
           ~source_before
           ~source_after)
       ~encode:
         (fun
           { command
           ; outcome
           ; started_unix_ms
           ; finished_unix_ms
           ; elapsed_ms
           ; stdout
           ; stderr
           ; source_before
           ; source_after
           } ->
         ( ((command, outcome), (source_before, source_after))
         , ((started_unix_ms, finished_unix_ms), (elapsed_ms, (stdout, stderr))) ))
       ~description:
         "Attributed execution evidence, not an acceptance assertion. Wall-clock \
          boundaries and independent monotonic duration; complete or explicitly partial \
          bounded streams."
;;
