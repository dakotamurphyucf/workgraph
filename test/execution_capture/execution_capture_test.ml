open Core
open Workgraph

let unwrap = function
  | Ok value -> value
  | Error error -> failwith error.Problem.message
;;

let report = function
  | Ok _ -> print_endline "accepted"
  | Error error -> print_endline error.Problem.message
;;

let with_directory f =
  Eio_main.run (fun env ->
    let fs = Eio.Stdenv.fs env in
    let nonce = Cstruct.create 16 in
    Eio.Flow.read_exact (Eio.Stdenv.secure_random env) nonce;
    let directory = "/tmp/workgraph-execution-" ^ Json.hash (Cstruct.to_string nonce) in
    Eio.Path.mkdir ~perm:0o700 Eio.Path.(fs / directory);
    Exn.protect
      ~f:(fun () -> f env fs directory)
      ~finally:(fun () -> Eio.Path.rmtree Eio.Path.(fs / directory)))
;;

let capture stage =
  match Execution_stage.state stage with
  | Finished capture -> capture
  | Unfinished _ -> failwith "expected finished capture"
;;

let%expect_test "binary output and completion are distinct from truncation" =
  let bytes = "\000\255hello" in
  let output =
    Execution_capture.Output.create
      ~bytes
      ~observed_bytes:7L
      ~observed_sha256:(Json.hash bytes)
      ~eof:true
    |> unwrap
  in
  let decoded =
    Api_codec.encode Execution_capture.Output.codec output
    |> unwrap
    |> Api_codec.decode Execution_capture.Output.codec
    |> unwrap
  in
  print_s [%sexp (String.equal bytes (Execution_capture.Output.bytes decoded) : bool)];
  Execution_capture.Output.create
    ~bytes
    ~observed_bytes:6L
    ~observed_sha256:(Json.hash bytes)
    ~eof:true
  |> report;
  Execution_capture.Output.create
    ~bytes
    ~observed_bytes:7L
    ~observed_sha256:(Json.hash "other")
    ~eof:true
  |> report;
  let partial =
    Execution_capture.Output.create
      ~bytes
      ~observed_bytes:100L
      ~observed_sha256:(Json.hash "all observed bytes")
      ~eof:false
    |> unwrap
  in
  print_s
    [%sexp
      (Execution_capture.Output.truncated partial : bool)
    , (Execution_capture.Output.eof partial : bool)];
  let command =
    Execution_capture.Command.create ~argv:[ "true" ] ~cwd:"/tmp" ~output_limit:100
    |> unwrap
  in
  Execution_capture.create
    ~command
    ~outcome:(Exited 0)
    ~started_unix_ms:1L
    ~finished_unix_ms:0L
    ~elapsed_ms:1L
    ~stdout:partial
    ~stderr:output
    ~source_before:Source_provenance.not_requested
    ~source_after:Source_provenance.not_requested
  |> report;
  Execution_capture.create
    ~command
    ~outcome:Interrupted
    ~started_unix_ms:1L
    ~finished_unix_ms:0L
    ~elapsed_ms:1L
    ~stdout:partial
    ~stderr:output
    ~source_before:Source_provenance.not_requested
    ~source_after:Source_provenance.not_requested
  |> report;
  [%expect
    {| 
    true
    invalid captured/observed byte counts
    captured output digest mismatch
    (true false)
    terminal process result requires drained output
    accepted
  |}]
;;

let%expect_test "independent decoder rejects malformed launch intent and outcome" =
  List.iter
    [ {|{"argv":[],"cwd":"/tmp","output_limit":"100"}|}
    ; {|{"argv":[""],"cwd":"/tmp","output_limit":"100"}|}
    ; {|{"argv":["true"],"cwd":"relative","output_limit":"100"}|}
    ; {|{"argv":["true"],"cwd":"/tmp","output_limit":"0"}|}
    ]
    ~f:(fun json ->
      Json.parse json
      |> unwrap
      |> Api_codec.decode Execution_capture.Command.codec
      |> report);
  List.iter
    [ {|{"kind":"signaled","signal":"0"}|}
    ; {|{"kind":"signaled","signal":"+9"}|}
    ; {|{"kind":"signaled","signal":"-9"}|}
    ; {|{"kind":"launch_failed","message":" "}|}
    ]
    ~f:(fun json ->
      Json.parse json
      |> unwrap
      |> Api_codec.decode Execution_capture.Outcome.codec
      |> report);
  [%expect
    {|
    capture requires 1..256 argv entries
    capture executable is empty
    capture cwd must be an absolute path <=4096 bytes
    capture output_limit must be 1..1048576 bytes
    signal must be a nonzero canonical signed decimal
    signal must be a nonzero canonical signed decimal
    accepted
    empty launch failure
  |}]
;;

let%expect_test "real process output is drained, bounded and persisted before reuse" =
  with_directory (fun env fs directory ->
    let command =
      Execution_capture.Command.create
        ~argv:
          [ "/bin/sh"
          ; "-c"
          ; "dd if=/dev/zero bs=65536 count=4 2>/dev/null; dd if=/dev/zero bs=65536 \
             count=4 1>&2 2>/dev/null; exit 7"
          ]
        ~cwd:directory
        ~output_limit:8
      |> unwrap
    in
    let path = Filename.concat directory "stage" in
    let result = Execution_stage.run command ~env ~directory:path |> unwrap |> capture in
    print_s [%sexp (Execution_capture.outcome result : Execution_capture.Outcome.t)];
    List.iter
      [ Execution_capture.stdout result; Execution_capture.stderr result ]
      ~f:(fun output ->
        print_s
          [%sexp
            (String.length (Execution_capture.Output.bytes output) : int)
          , (Execution_capture.Output.observed_bytes output : int64)
          , (Execution_capture.Output.eof output : bool)
          , (Execution_capture.Output.truncated output : bool)]);
    let loaded = Execution_stage.load ~fs ~directory:path |> unwrap |> capture in
    print_s
      [%sexp
        (Execution_capture.Outcome.equal
           (Execution_capture.outcome result)
           (Execution_capture.outcome loaded)
         : bool)];
    match Execution_stage.run command ~env ~directory:path with
    | Ok _ -> print_endline "incorrect rerun"
    | Error _ -> print_endline "existing stage refuses execution");
  [%expect
    {|
    (Exited 7)
    (8 262144 true true)
    (8 262144 true true)
    true
    existing stage refuses execution
  |}]
;;

let%expect_test "signal, failed launch and unfinished intent stay distinct" =
  with_directory (fun env fs directory ->
    let run name argv =
      let command =
        Execution_capture.Command.create ~argv ~cwd:directory ~output_limit:8 |> unwrap
      in
      Execution_stage.run command ~env ~directory:(Filename.concat directory name)
      |> unwrap
      |> capture
    in
    (match
       Execution_capture.outcome (run "signal" [ "/bin/sh"; "-c"; "kill -TERM $$" ])
     with
     | Signaled _ -> print_endline "signaled"
     | Exited _ | Interrupted | Launch_failed _ -> print_endline "wrong signal outcome");
    (match
       Execution_capture.outcome (run "missing" [ Filename.concat directory "absent" ])
     with
     | Launch_failed _ -> print_endline "launch failed"
     | Exited _ | Signaled _ | Interrupted -> print_endline "wrong launch outcome");
    let unfinished = Filename.concat directory "unfinished" in
    Eio.Path.mkdir ~perm:0o700 Eio.Path.(fs / unfinished);
    Disk.write_new
      Eio.Path.(fs / unfinished / "command.json")
      {|{"argv":["/bin/echo","never executed"],"cwd":"/tmp","output_limit":"8"}|};
    match
      Execution_stage.load ~fs ~directory:unfinished |> unwrap |> Execution_stage.state
    with
    | Unfinished _ -> print_endline "unfinished; no implicit rerun"
    | Finished _ -> print_endline "invented outcome");
  [%expect
    {|
    signaled
    launch failed
    unfinished; no implicit rerun
  |}]
;;

exception Stop_capture

let%expect_test "cancellation propagates after durable interrupted capture" =
  with_directory (fun env fs directory ->
    let marker = Filename.concat directory "ready" in
    let path = Filename.concat directory "interrupted" in
    let command =
      Execution_capture.Command.create
        ~argv:[ "/bin/sh"; "-c"; "printf ready > \"$1\"; exec sleep 60"; "test"; marker ]
        ~cwd:directory
        ~output_limit:8
      |> unwrap
    in
    (try
       Eio.Fiber.both
         (fun () -> Execution_stage.run command ~env ~directory:path |> unwrap |> ignore)
         (fun () ->
            let rec ready () =
              match Eio.Path.kind ~follow:false Eio.Path.(fs / marker) with
              | `Regular_file -> raise Stop_capture
              | _ ->
                Eio.Time.Mono.sleep (Eio.Stdenv.mono_clock env) 0.001;
                ready ()
            in
            Eio.Time.Timeout.run_exn
              (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock env) 10.)
              ready)
     with
     | Stop_capture -> print_endline "caller cancellation preserved");
    let result = Execution_stage.load ~fs ~directory:path |> unwrap |> capture in
    print_s [%sexp (Execution_capture.outcome result : Execution_capture.Outcome.t)]);
  [%expect
    {|
    caller cancellation preserved
    Interrupted
  |}]
;;
