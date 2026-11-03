open Core

module State = struct
  type t =
    | Unfinished of Execution_capture.Command.t
    | Finished of Execution_capture.t
end

type t =
  { directory : string
  ; state : State.t
  ; owner_token : string option
  }

let directory t = t.directory
let state t = t.state
let owner_token t = t.owner_token

let capture_file t =
  match t.state with
  | State.Unfinished _ -> None
  | Finished _ -> Some (Filename.concat t.directory "capture.json")
;;

let encode codec value = Api_codec.encode codec value |> Disk.unwrap |> Json.canonical

let with_lock ~fs ~directory ~f =
  Local_file.protect ~operation:"lock execution stage" ~path:directory (fun () ->
    Disk.absolute directory;
    let path = Eio.Path.(fs / directory) in
    Local_file.require_directory path ~operation:"lock execution stage";
    Eio.Path.with_open_dir path (fun opened ->
      let opened = (opened :> Eio.Fs.dir_ty Eio.Path.t) in
      let command = Eio.Path.(opened / "command.json") in
      (match Eio.Path.kind ~follow:false command with
       | `Regular_file -> ()
       | _ -> Json.fail Invalid_argument "stage lock requires a regular command.json");
      Eio.Path.with_open_out ~append:true ~create:`Never command (fun lock ->
        if not (Platform.lock_exclusive lock)
        then Json.fail Conflict "execution stage is live or held by another operation";
        f opened)))
;;

let validate_token token =
  if
    String.length token <> 64
    || not
         (String.for_all token ~f:(fun c ->
            Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
  then
    Json.fail
      Invalid_argument
      "stage ownership token must be 64 lowercase hexadecimal bytes"
;;

let load_path path ~directory =
  Local_file.require_directory path ~operation:"load execution stage";
  let command =
    Disk.read Eio.Path.(path / "command.json")
    |> Json.parse
    |> Disk.unwrap
    |> Api_codec.decode Execution_capture.Command.codec
    |> Disk.unwrap
  in
  let state =
    match Eio.Path.kind ~follow:false Eio.Path.(path / "capture.json") with
    | `Not_found -> State.Unfinished command
    | _ ->
      let capture =
        Disk.read Eio.Path.(path / "capture.json")
        |> Json.parse
        |> Disk.unwrap
        |> Api_codec.decode Execution_capture.codec
        |> Disk.unwrap
      in
      if
        not
          (String.equal
             (encode Execution_capture.Command.codec command)
             (encode Execution_capture.Command.codec (Execution_capture.command capture)))
      then Json.fail Corrupt_store "capture differs from durable launch intent";
      Finished capture
  in
  let owner_token =
    let owner = Eio.Path.(path / "owner.json") in
    match Eio.Path.kind ~follow:false owner with
    | `Not_found -> None
    | _ ->
      let record = Disk.read owner |> Json.parse |> Disk.unwrap in
      Json.fields record ~allowed:[ "version"; "token"; "command_sha256" ];
      if Json.integer (Json.field record "version") <> 1
      then Json.fail Corrupt_store "unknown stage ownership version";
      let token = Json.text (Json.field record "token") in
      validate_token token;
      if
        not
          (String.equal
             (Json.text (Json.field record "command_sha256"))
             (Json.hash (encode Execution_capture.Command.codec command)))
      then Json.fail Corrupt_store "stage ownership differs from launch intent";
      Some token
  in
  { directory; state; owner_token }
;;

let load ~fs ~directory =
  Local_file.protect ~operation:"load execution stage" ~path:directory (fun () ->
    Disk.absolute directory;
    load_path Eio.Path.(fs / directory) ~directory)
;;

module Drain = struct
  type t =
    { buffer : Buffer.t
    ; limit : int
    ; mutable observed : int64
    ; mutable digest : Digestif.SHA256.ctx
    ; mutable eof : bool
    }

  let create limit =
    { buffer = Buffer.create (Int.min limit 65536)
    ; limit
    ; observed = 0L
    ; digest = Digestif.SHA256.empty
    ; eof = false
    }
  ;;

  let run t source =
    let scratch = Cstruct.create 65536 in
    let rec loop () =
      match Eio.Flow.single_read source scratch with
      | count ->
        let bytes = Cstruct.to_string ~len:count scratch in
        if Int64.(t.observed > max_value - of_int count)
        then Json.fail Invalid_argument "capture observed-byte counter overflow";
        t.observed <- Int64.(t.observed + of_int count);
        t.digest <- Digestif.SHA256.feed_string t.digest bytes;
        let keep = Int.min count (t.limit - Buffer.length t.buffer) in
        Buffer.add_substring t.buffer bytes ~pos:0 ~len:keep;
        loop ()
      | exception End_of_file -> t.eof <- true
    in
    loop ()
  ;;

  let finish t =
    Execution_capture.Output.create
      ~bytes:(Buffer.contents t.buffer)
      ~observed_bytes:t.observed
      ~observed_sha256:Digestif.SHA256.(get t.digest |> to_hex)
      ~eof:t.eof
    |> Disk.unwrap
  ;;
end

let run command ~env ~directory =
  Local_file.protect ~operation:"create execution stage" ~path:directory (fun () ->
    Disk.absolute directory;
    let fs = (Eio.Stdenv.fs env :> Eio.Fs.dir_ty Eio.Path.t) in
    let path = Eio.Path.(fs / directory) in
    let parent =
      match Eio.Path.split path with
      | Some (parent, _) -> parent
      | None -> Json.fail Invalid_argument "capture directory has no parent"
    in
    Local_file.require_directory parent ~operation:"create execution stage";
    let existing () =
      Json.fail
        Invalid_argument
        (sprintf
           "create execution stage %S: stage already exists; inspect or publish its \
            saved capture, or choose a fresh stage for a new execution"
           directory)
    in
    (match Eio.Path.kind ~follow:false path with
     | `Not_found -> ()
     | _ -> existing ());
    (try Eio.Path.mkdir ~perm:0o700 path with
     | Eio.Io (Eio.Fs.E (Already_exists _), _) -> existing ());
    Platform.sync_directory parent;
    Disk.write_new
      Eio.Path.(path / "command.json")
      (encode Execution_capture.Command.codec command);
    let nonce = Cstruct.create 32 in
    Eio.Flow.read_exact (Eio.Stdenv.secure_random env) nonce;
    let owner_token = Json.hash (Cstruct.to_string nonce) in
    Disk.write_new
      Eio.Path.(path / "owner.json")
      (Json.canonical
         (Json.obj
            [ "version", Json.int 1
            ; "token", Json.string owner_token
            ; ( "command_sha256"
              , Json.string (Json.hash (encode Execution_capture.Command.codec command)) )
            ]));
    with_lock ~fs ~directory ~f:(fun _ ->
      let observe_source () =
        Option.value_map
          (Execution_capture.Command.source_root command)
          ~default:Source_provenance.not_requested
          ~f:(fun root ->
            Source_provenance.capture_scope
              (Execution_capture.Command.source_scope command)
              ~env
              ~root)
      in
      let source_before = observe_source () in
      let clock = Eio.Stdenv.clock env in
      let mono = Eio.Stdenv.mono_clock env in
      let milliseconds () = Float.to_int64 (Eio.Time.now clock *. 1000.) in
      let started_unix_ms = milliseconds () in
      let started = Eio.Time.Mono.now mono in
      let stdout = Drain.create (Execution_capture.Command.output_limit command) in
      let stderr = Drain.create (Execution_capture.Command.output_limit command) in
      let outcome = ref Execution_capture.Outcome.Interrupted in
      let finished = ref None in
      Exn.protect
        ~f:(fun () ->
          let status =
            Eio.Switch.run (fun sw ->
              let manager = Eio.Stdenv.process_mgr env in
              let out_read, out_write = Eio.Process.pipe ~sw manager in
              let err_read, err_write = Eio.Process.pipe ~sw manager in
              let process =
                try
                  Ok
                    (Eio.Process.spawn
                       ~sw
                       manager
                       ~cwd:Eio.Path.(fs / Execution_capture.Command.cwd command)
                       ~stdin:(Eio.Flow.string_source "")
                       ~stdout:out_write
                       ~stderr:err_write
                       (Execution_capture.Command.argv command))
                with
                | Eio.Io _ as exn -> Error (Exn.to_string exn)
              in
              Eio.Flow.close out_write;
              Eio.Flow.close err_write;
              match process with
              | Error message ->
                Execution_capture.Outcome.Launch_failed (String.prefix message 4096)
              | Ok process ->
                let status, () =
                  Eio.Fiber.pair
                    (fun () -> Eio.Process.await process)
                    (fun () ->
                       Eio.Fiber.both
                         (fun () -> Drain.run stdout out_read)
                         (fun () -> Drain.run stderr err_read))
                in
                (match status with
                 | `Exited code -> Exited code
                 | `Signaled signal -> Signaled signal))
          in
          outcome := status)
        ~finally:(fun () ->
          Eio.Cancel.protect (fun () ->
            let elapsed_ms =
              Mtime.span started (Eio.Time.Mono.now mono)
              |> Mtime.Span.to_float_ns
              |> fun ns -> Float.to_int64 (ns /. 1_000_000.)
            in
            let finished_unix_ms = milliseconds () in
            let source_after =
              match !outcome, Execution_capture.Command.source_root command with
              | Interrupted, Some root ->
                Source_provenance.unavailable_for_scope
                  (Execution_capture.Command.source_scope command)
                  ~root
                  ~reason:"execution interrupted; no final source observation"
                |> Disk.unwrap
              | (Exited _ | Signaled _ | Launch_failed _), _ | Interrupted, None ->
                observe_source ()
            in
            let capture =
              Execution_capture.create
                ~command
                ~outcome:!outcome
                ~started_unix_ms
                ~finished_unix_ms
                ~elapsed_ms
                ~stdout:(Drain.finish stdout)
                ~stderr:(Drain.finish stderr)
                ~source_before
                ~source_after
              |> Disk.unwrap
            in
            Disk.write_new
              Eio.Path.(path / "capture.json")
              (encode Execution_capture.codec capture);
            finished := Some capture));
      match !finished with
      | Some capture ->
        { directory; state = Finished capture; owner_token = Some owner_token }
      | None -> assert false)
    |> Disk.unwrap)
;;

let cleanup ~fs ~directory ~owner_token =
  Local_file.protect ~operation:"clean execution stage" ~path:directory (fun () ->
    validate_token owner_token;
    with_lock ~fs ~directory ~f:(fun owned ->
      let stage = load_path owned ~directory in
      if
        not
          (Option.value_map
             stage.owner_token
             ~default:false
             ~f:(String.equal owner_token))
      then
        Json.fail
          Conflict
          "stage ownership token differs or stage has no ownership marker";
      (match stage.state with
       | State.Unfinished _ ->
         Json.fail Conflict "unfinished execution stage cannot be cleaned"
       | Finished _ -> ());
      let expected = [ "capture.json"; "command.json"; "owner.json" ] in
      let entries = Eio.Path.read_dir owned in
      if not (List.equal String.equal entries expected)
      then
        Json.fail
          Conflict
          "cleanup refuses publication intents, published evidence or unknown stage \
           entries";
      List.iter expected ~f:(fun name ->
        match Eio.Path.kind ~follow:false Eio.Path.(owned / name) with
        | `Regular_file -> ()
        | _ -> Json.fail Conflict "cleanup requires only regular owned stage records");
      let bound = Eio.Path.stat ~follow:false owned in
      let current = Eio.Path.stat ~follow:false Eio.Path.(fs / directory) in
      if not (Int64.equal bound.dev current.dev && Int64.equal bound.ino current.ino)
      then Json.fail Conflict "stage directory identity changed; cleanup refused";
      (* Keep command.json, the stable lock identity, until the other records are gone. *)
      List.iter [ "capture.json"; "owner.json"; "command.json" ] ~f:(fun name ->
        Eio.Path.unlink Eio.Path.(owned / name));
      let current = Eio.Path.stat ~follow:false Eio.Path.(fs / directory) in
      if not (Int64.equal bound.dev current.dev && Int64.equal bound.ino current.ino)
      then Json.fail Conflict "stage directory identity changed before removal";
      Eio.Path.rmdir Eio.Path.(fs / directory);
      match Eio.Path.split Eio.Path.(fs / directory) with
      | Some (parent, _) -> Platform.sync_directory parent
      | None -> assert false)
    |> Disk.unwrap)
;;
