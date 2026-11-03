open Core
open Workgraph

let unwrap = function
  | Ok value -> value
  | Error error -> failwith error.Problem.message
;;

let with_repository f =
  Eio_main.run (fun env ->
    let fs = Eio.Stdenv.fs env in
    let nonce = Cstruct.create 16 in
    Eio.Flow.read_exact (Eio.Stdenv.secure_random env) nonce;
    let directory = "/tmp/workgraph-source-" ^ Json.hash (Cstruct.to_string nonce) in
    Eio.Path.mkdir ~perm:0o700 Eio.Path.(fs / directory);
    Exn.protect
      ~finally:(fun () -> Eio.Path.rmtree Eio.Path.(fs / directory))
      ~f:(fun () ->
        let root = Filename.concat directory "repo" in
        Eio.Path.mkdir ~perm:0o700 Eio.Path.(fs / root);
        let git args =
          Eio.Process.run
            (Eio.Stdenv.process_mgr env)
            ([ "git"
             ; "-c"
             ; "core.hooksPath=/dev/null"
             ; "-c"
             ; "commit.gpgsign=false"
             ; "-c"
             ; "user.name=Workgraph Test"
             ; "-c"
             ; "user.email=test@example.invalid"
             ; "-C"
             ; root
             ]
             @ args)
        in
        git [ "init"; "--quiet" ];
        Disk.write_new Eio.Path.(fs / root / "tracked") "first";
        Disk.write_new Eio.Path.(fs / root / ".gitignore") "ignored\n";
        git [ "add"; "tracked"; ".gitignore" ];
        git [ "commit"; "--quiet"; "-m"; "initial" ];
        f env fs directory root git))
;;

let%expect_test
    "dirty, untracked, executable mode, symlink targets and deletion affect source \
     identity"
  =
  with_repository (fun env fs _directory root _git ->
    let observe () = Source_provenance.capture ~env ~root in
    let initial = observe () in
    let changed () =
      print_s
        [%sexp
          (Source_provenance.drift ~before:initial ~after:(observe ()) : bool option)]
    in
    print_s [%sexp (Option.is_some (Source_provenance.identity initial) : bool)];
    Disk.replace Eio.Path.(fs / root / "tracked") "dirty";
    changed ();
    Disk.replace Eio.Path.(fs / root / "tracked") "first";
    changed ();
    Disk.write_new Eio.Path.(fs / root / "new") "untracked";
    changed ();
    Eio.Path.unlink Eio.Path.(fs / root / "new");
    Eio.Process.run
      (Eio.Stdenv.process_mgr env)
      [ "chmod"; "755"; Filename.concat root "tracked" ];
    changed ();
    Eio.Process.run
      (Eio.Stdenv.process_mgr env)
      [ "chmod"; "600"; Filename.concat root "tracked" ];
    Eio.Path.symlink ~link_to:"tracked" Eio.Path.(fs / root / "link");
    let linked = observe () in
    Eio.Path.unlink Eio.Path.(fs / root / "link");
    Eio.Path.symlink ~link_to:"missing" Eio.Path.(fs / root / "link");
    print_s
      [%sexp (Source_provenance.drift ~before:linked ~after:(observe ()) : bool option)];
    Eio.Path.unlink Eio.Path.(fs / root / "link");
    Disk.write_new Eio.Path.(fs / root / "ignored") "excluded by declared scope";
    changed ();
    Eio.Path.unlink Eio.Path.(fs / root / "tracked");
    changed ());
  [%expect
    {|
    true
    (true)
    (false)
    (true)
    (true)
    (true)
    (false)
    (true)
  |}]
;;

let%expect_test "partial and unavailable provenance never imply unchanged inputs" =
  with_repository (fun env fs directory root _git ->
    let unavailable = Source_provenance.capture ~env ~root:directory in
    print_s
      [%sexp
        (Source_provenance.drift ~before:unavailable ~after:unavailable : bool option)];
    Disk.write_new
      Eio.Path.(fs / root / "too-large")
      (String.make ((8 * 1024 * 1024) + 1) 'a');
    let partial = Source_provenance.capture ~env ~root in
    let value = Api_codec.encode Source_provenance.codec partial |> unwrap in
    print_endline (Json.canonical (Json.field value "omissions"));
    print_s [%sexp (Source_provenance.drift ~before:partial ~after:partial : bool option)];
    let command =
      Execution_capture.Command.create
        ~argv:[ "/bin/sh"; "-c"; "printf changed > tracked" ]
        ~cwd:root
        ~output_limit:8
      |> unwrap
      |> fun command -> Execution_capture.Command.with_source_root command root |> unwrap
    in
    Eio.Path.unlink Eio.Path.(fs / root / "too-large");
    let stage =
      Execution_stage.run command ~env ~directory:(Filename.concat directory "stage")
      |> unwrap
    in
    match Execution_stage.state stage with
    | Unfinished _ -> failwith "expected finished command"
    | Finished capture ->
      print_s
        [%sexp
          (Source_provenance.drift
             ~before:(Execution_capture.source_before capture)
             ~after:(Execution_capture.source_after capture)
           : bool option)]);
  [%expect
    {|
    ()
    {"file_byte_limit":"1"}
    ()
    (true)
  |}]
;;

let%expect_test "declared source scopes validate independently and cannot widen on replay"
  =
  List.iter
    [ {|{"kind":"paths","paths":[]}|}
    ; {|{"kind":"paths","paths":["../escape"]}|}
    ; {|{"kind":"paths","paths":["a","a"]}|}
    ; {|{"kind":"paths","paths":[".git/config"]}|}
    ]
    ~f:(fun json ->
      match Api_codec.decode Source_provenance.Scope.codec (Jsonaf.of_string json) with
      | Ok _ -> print_endline "incorrect scope"
      | Error error -> print_endline error.message);
  with_repository (fun env _fs _directory root _git ->
    let selected = Source_provenance.Scope.paths [ "tracked" ] |> unwrap in
    let observation = Source_provenance.capture_scope selected ~env ~root in
    let encoded = Api_codec.encode Source_provenance.codec observation |> unwrap in
    let fields =
      match encoded with
      | `Object fields -> fields
      | _ -> assert false
    in
    let malformed =
      Json.obj (List.Assoc.add fields ~equal:String.equal "listed_paths" (Json.int 2))
    in
    (match Api_codec.decode Source_provenance.codec malformed with
     | Ok _ -> print_endline "incorrect count"
     | Error error -> print_endline error.message);
    let malformed_manifest =
      Json.obj
        (List.Assoc.add
           fields
           ~equal:String.equal
           "paths_sha256"
           (Json.string (Json.hash "wrong")))
    in
    (match Api_codec.decode Source_provenance.codec malformed_manifest with
     | Ok _ -> print_endline "incorrect manifest"
     | Error error -> print_endline error.message);
    print_s
      [%sexp
        (Source_provenance.drift
           ~before:observation
           ~after:(Source_provenance.capture ~env ~root)
         : bool option)];
    let command =
      Execution_capture.Command.create ~argv:[ "true" ] ~cwd:root ~output_limit:8
      |> unwrap
      |> fun command -> Execution_capture.Command.with_source_root command root |> unwrap
    in
    let output =
      Execution_capture.Output.create
        ~bytes:""
        ~observed_bytes:0L
        ~observed_sha256:(Json.hash "")
        ~eof:true
      |> unwrap
    in
    match
      Execution_capture.create
        ~command
        ~outcome:(Exited 0)
        ~started_unix_ms:0L
        ~finished_unix_ms:0L
        ~elapsed_ms:0L
        ~stdout:output
        ~stderr:output
        ~source_before:observation
        ~source_after:observation
    with
    | Ok _ -> print_endline "incorrect capture scope"
    | Error error -> print_endline error.message);
  [%expect
    {|
    source selection requires 1..256 file paths
    source paths must be canonical root-relative files outside Git metadata
    duplicate selected source path
    source paths must be canonical root-relative files outside Git metadata
    selected source count differs from declared paths
    selected source manifest differs from declared paths
    ()
    source provenance differs from requested scope
    |}]
;;
