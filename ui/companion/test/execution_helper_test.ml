open Core
open Workgraph
open Workgraph_ui
open State_tests

let id name = Operation.Id.of_string name |> Disk.unwrap
let encoded codec value = Api_codec.encode codec value |> Disk.unwrap |> Json.canonical
let fields value name = Json.field value name

let phase job =
  Execution_helper.Job.to_json job
  |> fun value -> fields value "state" |> fun value -> fields value "kind" |> Json.text
;;

let token = String.make 64 'a'

(* Synthetic native files, not Execution_stage.run: tests can prove the helper
   does not execute even when the displayed argv names a nonexistent program. *)
let fixture env root ?(finished = true) ?(name = "stage") () =
  let fs = Eio.Stdenv.fs env in
  let directory = Filename.concat (State_root.path root) name in
  Eio.Path.mkdir ~perm:0o700 Eio.Path.(fs / directory);
  let command =
    Execution_capture.Command.create
      ~argv:[ "/never-execute-this"; "literal ; $(argument)" ]
      ~cwd:"/tmp"
      ~output_limit:4
    |> Disk.unwrap
  in
  let command_bytes = encoded Execution_capture.Command.codec command in
  Disk.write_new Eio.Path.(fs / directory / "command.json") command_bytes;
  Disk.write_new
    Eio.Path.(fs / directory / "owner.json")
    (Json.canonical
       (Json.obj
          [ "version", Json.int 1
          ; "token", Json.string token
          ; "command_sha256", Json.string (Json.hash command_bytes)
          ]));
  if finished
  then (
    let stdout =
      Execution_capture.Output.create
        ~bytes:"\000\255ab"
        ~observed_bytes:9L
        ~observed_sha256:(Json.hash "\000\255abcdefg")
        ~eof:true
      |> Disk.unwrap
    in
    let stderr =
      Execution_capture.Output.create
        ~bytes:""
        ~observed_bytes:0L
        ~observed_sha256:(Json.hash "")
        ~eof:true
      |> Disk.unwrap
    in
    let capture =
      Execution_capture.create
        ~command
        ~outcome:(Exited 7)
        ~started_unix_ms:2L
        ~finished_unix_ms:1L
        ~elapsed_ms:3L
        ~stdout
        ~stderr
        ~source_before:Source_provenance.not_requested
        ~source_after:Source_provenance.not_requested
      |> Disk.unwrap
    in
    Disk.write_new
      Eio.Path.(fs / directory / "capture.json")
      (encoded Execution_capture.codec capture));
  directory
;;

let params ?(actor = "author") ?ticket ?(intention = "publish") () =
  Json.obj
    ([ "workspace_id", Json.string "demo"
     ; "actor_id", Json.string actor
     ; "mutation_id", Json.string intention
     ; "resource_id", Json.string "artifact"
     ; "expected_revision", Json.int 0
     ; "title", Json.string "Captured evidence"
     ]
     @ Option.to_list
         (Option.map ticket ~f:(fun ticket -> "ticket_id", Json.string ticket)))
;;

let plan helper connection directory ?ticket ?(intention = "publish") () =
  let stage =
    Execution_helper.inspect_stage helper ~directory
    |> Disk.unwrap
    |> Execution_helper.Inspection.to_json
  in
  Execution_helper.Plan.create
    ~intention_id:(id intention)
    ~connection
    ~context:(context ())
    ~directory
    ~capture_digest:(Json.text (fields (fields stage "capture") "digest"))
    ~params:(params ?ticket ~intention ())
  |> Disk.unwrap
;;

let create env root sw calls =
  Execution_helper.create ~sw ~env ~root ~client:(fun _ ->
    incr calls;
    Error (Problem.create Unsupported_version "synthetic mismatch"))
  |> Disk.unwrap
;;

let%expect_test "unfinished launch is literal, never executed, published or cleaned" =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let calls = ref 0 in
      let helper = create env root sw calls in
      let directory = fixture env root ~finished:false () in
      let stage =
        Execution_helper.inspect_stage helper ~directory
        |> Disk.unwrap
        |> Execution_helper.Inspection.to_json
      in
      print_s
        [%sexp
          (Json.text (fields stage "kind") : string)
        , (Json.list (fields (fields stage "command") "argv") |> List.map ~f:Json.text
           : string list)];
      problem
        (Execution_helper.inspect_output
           helper
           ~directory
           ~capture_digest:(Json.hash "missing")
           ~stream:Stdout
           ~selection:(Execution_inspect.Selection.tail ~length:4 |> Disk.unwrap));
      problem (Execution_helper.cleanup helper ~directory ~owner_token:token);
      print_s [%sexp (!calls : int)]));
  [%expect
    {|
    (unfinished (/never-execute-this "literal ; $(argument)"))
    Conflict
    Conflict
    0
    |}]
;;

let%expect_test
    "binary retained-prefix inspection, changed capture and exact owned cleanup"
  =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let calls = ref 0 in
      let helper = create env root sw calls in
      let directory = fixture env root () in
      let stage =
        Execution_helper.inspect_stage helper ~directory
        |> Disk.unwrap
        |> Execution_helper.Inspection.to_json
      in
      let digest = Json.text (fields (fields stage "capture") "digest") in
      let output =
        Execution_helper.inspect_output
          helper
          ~directory
          ~capture_digest:digest
          ~stream:Stdout
          ~selection:(Execution_inspect.Selection.tail ~length:4 |> Disk.unwrap)
        |> Disk.unwrap
      in
      print_s
        [%sexp
          (Json.text (fields output "data_base64") : string)
        , (fields output "text_lossy" : Jsonaf.t)
        , (fields output "truncated" : Jsonaf.t)
        , (Json.text (fields output "observed_bytes") : string)];
      problem
        (Execution_helper.inspect_output
           helper
           ~directory
           ~capture_digest:(Json.hash "other")
           ~stream:Stdout
           ~selection:(Execution_inspect.Selection.tail ~length:4 |> Disk.unwrap));
      problem
        (Execution_helper.cleanup helper ~directory ~owner_token:(String.make 64 'b'));
      Disk.write_new Eio.Path.(Eio.Stdenv.fs env / directory / "extra") "x";
      problem (Execution_helper.cleanup helper ~directory ~owner_token:token);
      Eio.Path.unlink Eio.Path.(Eio.Stdenv.fs env / directory / "extra");
      problem (Execution_helper.cleanup helper ~directory ~owner_token:token);
      print_s [%sexp (!calls : int)]));
  [%expect
    {|
    (AP9hYg== True True 9)
    Conflict
    Conflict
    Conflict
    ok
    0
    |}]
;;

let%expect_test
    "new preparation is durable offline, exact input deduplication and intent prevents \
     cleanup"
  =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let calls = ref 0 in
      let helper = create env root sw calls in
      let directory = fixture env root () in
      let input = plan helper (profile ()) directory () in
      let first = Execution_helper.prepare helper input |> Disk.unwrap in
      print_s [%sexp (phase first : string), (!calls : int)];
      let second = Execution_helper.prepare helper input |> Disk.unwrap in
      print_s
        [%sexp
          (String.equal
             (Json.canonical (Execution_helper.Job.to_json first))
             (Json.canonical (Execution_helper.Job.to_json second))
           : bool)];
      problem
        (Execution_helper.prepare
           helper
           (plan helper (profile ()) directory ~ticket:"different" ()));
      problem (Execution_helper.cleanup helper ~directory ~owner_token:token);
      let restored = create env root sw calls in
      print_s
        [%sexp
          (phase (Execution_helper.inspect restored ~id:(id "publish") |> Disk.unwrap)
           : string)
        , (!calls : int)];
      problem (Execution_helper.start restored ~id:(id "publish"));
      print_s
        [%sexp
          (phase (Execution_helper.inspect restored ~id:(id "publish") |> Disk.unwrap)
           : string)]));
  [%expect
    {|
    (prepared_unsent 0)
    true
    Idempotency_conflict
    Conflict
    (prepared_unsent 0)
    Unsupported_version
    prepared_unsent
    |}]
;;

let%expect_test
    "external association is operator asserted, offline and never proves unsent"
  =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let calls = ref 0 in
      let helper = create env root sw calls in
      let directory = fixture env root () in
      let stage =
        Execution_stage.load ~fs:(Eio.Stdenv.fs env) ~directory |> Disk.unwrap
      in
      ignore
        (Execution_publication.prepare
           stage
           ~fs:(Eio.Stdenv.fs env)
           ~random:(Eio.Stdenv.secure_random env)
           ~params:(params ~actor:"external-author" ~intention:"external-write" ())
         |> Disk.unwrap
         : Execution_publication.t);
      (* The intent could already be committed; association cannot determine that. *)
      problem (Execution_helper.prepare helper (plan helper (profile ()) directory ()));
      let observed = Execution_helper.inspect_intent helper ~directory |> Disk.unwrap in
      let input =
        Execution_helper.Plan.external_binding
          ~intention_id:(id "associate")
          ~connection:(profile ())
          ~directory
          ~intent_digest:(Json.text (fields observed "intent_digest"))
        |> Disk.unwrap
      in
      let associated = Execution_helper.prepare helper input |> Disk.unwrap in
      let raw = Execution_helper.Job.to_json associated in
      print_s
        [%sexp
          (phase associated : string)
        , (!calls : int)
        , (Json.text (fields (fields (fields raw "native_request") "params") "actor_id")
           : string)];
      ignore
        (Execution_helper.start helper ~id:(id "associate") |> Disk.unwrap
         : Execution_helper.Job.t);
      print_s [%sexp (!calls : int)];
      let restored = create env root sw calls in
      print_s
        [%sexp
          (phase (Execution_helper.inspect restored ~id:(id "associate") |> Disk.unwrap)
           : string)];
      let changed =
        Execution_helper.Plan.external_binding
          ~intention_id:(id "associate")
          ~connection:(profile ~socket:"/tmp/other.sock" ())
          ~directory
          ~intent_digest:(Json.text (fields observed "intent_digest"))
        |> Disk.unwrap
      in
      problem (Execution_helper.prepare restored changed);
      problem (Execution_helper.retry_exact restored ~id:(id "associate"));
      print_s
        [%sexp
          (phase (Execution_helper.inspect restored ~id:(id "associate") |> Disk.unwrap)
           : string)]));
  [%expect
    {|
    Conflict
    (outcome_unknown 0 external-author)
    0
    outcome_unknown
    Idempotency_conflict
    Unsupported_version
    outcome_unknown
    |}]
;;

let%expect_test "external changed bytes and corrupt replay are never reset to unsent" =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let calls = ref 0 in
      let helper = create env root sw calls in
      let directory = fixture env root () in
      let stage =
        Execution_stage.load ~fs:(Eio.Stdenv.fs env) ~directory |> Disk.unwrap
      in
      ignore
        (Execution_publication.prepare
           stage
           ~fs:(Eio.Stdenv.fs env)
           ~random:(Eio.Stdenv.secure_random env)
           ~params:(params ())
         |> Disk.unwrap
         : Execution_publication.t);
      let observed = Execution_helper.inspect_intent helper ~directory |> Disk.unwrap in
      let input =
        Execution_helper.Plan.external_binding
          ~intention_id:(id "associate")
          ~connection:(profile ())
          ~directory
          ~intent_digest:(Json.text (fields observed "intent_digest"))
        |> Disk.unwrap
      in
      let saved = Filename.concat directory "publication.json" in
      let bytes = Disk.read Eio.Path.(Eio.Stdenv.fs env / saved) in
      let original = Json.parse bytes |> Disk.unwrap in
      let changed_params =
        Transfer_helper_tests.replace
          (Json.field original "params")
          "title"
          (Json.string "Changed external title")
      in
      let changed_bytes =
        Transfer_helper_tests.replace original "params" changed_params |> Json.canonical
      in
      Disk.replace Eio.Path.(Eio.Stdenv.fs env / saved) changed_bytes;
      problem (Execution_helper.prepare helper input);
      print_s [%sexp (!calls : int)];
      let good =
        Execution_helper.Plan.external_binding
          ~intention_id:(id "associate")
          ~connection:(profile ())
          ~directory
          ~intent_digest:(Json.hash changed_bytes)
        |> Disk.unwrap
      in
      ignore
        (Execution_helper.prepare helper good |> Disk.unwrap : Execution_helper.Job.t);
      let name = "execution-associate.json" in
      let stored = State_root.read root ~name |> Disk.unwrap |> Option.value_exn in
      let false_unsent =
        Transfer_helper_tests.replace
          stored
          "state_text"
          (Json.string
             (Json.canonical (Json.obj [ "kind", Json.string "prepared_unsent" ])))
      in
      State_root.save root ~name ~value:false_unsent |> Disk.unwrap;
      problem (Execution_helper.create ~sw ~env ~root ~client:(fun _ -> assert false));
      let bad = Transfer_helper_tests.replace stored "intent" (Json.string bytes) in
      State_root.save root ~name ~value:bad |> Disk.unwrap;
      problem (Execution_helper.create ~sw ~env ~root ~client:(fun _ -> assert false))));
  [%expect
    {|
    Idempotency_conflict
    0
    Corrupt_store
    Corrupt_store
    |}]
;;

let await_published env helper intention =
  Eio.Time.Timeout.run_exn
    (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock env) 5.)
    (fun () ->
       let rec loop () =
         let job = Execution_helper.inspect helper ~id:(id intention) |> Disk.unwrap in
         match phase job with
         | "running" ->
           Eio.Time.sleep (Eio.Stdenv.clock env) 0.001;
           loop ()
         | _ -> job
       in
       loop ())
;;

let receipt_response ~fs request response =
  let entry = Request_journal.Entry.create request ~fs |> Disk.unwrap in
  let identity = Request_journal.Entry.mutation entry |> Option.value_exn in
  Json.obj
    [ ( "data"
      , Json.obj
          [ "status", Json.string "committed"
          ; "request_hash", Json.string identity.request_hash
          ; "response", response
          ] )
    ; "meta", Json.obj []
    ]
;;

let publication params =
  let get name = Json.field params name in
  Json.obj
    [ ( "data"
      , Json.obj
          [ "resource_id", get "resource_id"
          ; "revision", Json.int 1
          ; ( "version"
            , Json.obj
                [ "revision", Json.int 1
                ; "digest", get "digest"
                ; "size_bytes", get "size_bytes"
                ; "actor_id", get "actor_id"
                ; "timestamp", Json.string "2026-11-07T00:00:00Z"
                ; "filename", get "filename"
                ; "mime_type", get "mime_type"
                ] )
          ] )
    ; "meta", Json.obj [ "durable", `True; "workspace_revision", Json.int 5 ]
    ]
;;

let%expect_test
    "known publication survives lost link, original actor/profile and source-removed \
     receipt recovery"
  =
  let finish = ref None in
  let link = ref None in
  let fs_ref = ref None in
  let sent = ref [] in
  let seen_socket = ref [] in
  let lost = ref true in
  let committed_link =
    Json.obj
      [ "data", Json.obj [ "revision", Json.int 2 ]
      ; "meta", Json.obj [ "durable", `True; "workspace_revision", Json.int 6 ]
      ]
  in
  Rpc_socket_test.with_bridge
    (fun request ->
       let method_ = Protocol.Request.method_ request in
       sent := method_ :: !sent;
       match method_ with
       | "workspace.receipt" ->
         let mutation =
           Json.text (Json.field (Protocol.Request.params request) "mutation_id")
         in
         let fs = Option.value_exn !fs_ref in
         if String.is_prefix mutation ~prefix:"link_"
         then (
           let request = Option.value_exn !link in
           Some (Protocol.Success (receipt_response ~fs request committed_link)))
         else (
           let request, response = Option.value_exn !finish in
           Some (Protocol.Success (receipt_response ~fs request response)))
       | "resource.finish_upload" ->
         let _, response = Option.value_exn !finish in
         Some (Protocol.Success response)
       | "resource.link" ->
         link := Some request;
         if !lost
         then (
           lost := false;
           None)
         else Some (Protocol.Success committed_link)
       | _ -> failwith ("unexpected local evidence RPC " ^ method_))
    (fun env root _store _bridge connection ->
       Eio.Switch.run (fun sw ->
         fs_ref := Some (Eio.Stdenv.fs env);
         let factory captured =
           seen_socket := Connection_profile.socket captured :: !seen_socket;
           Client.create
             ~net:(Eio.Stdenv.net env)
             ~clock:(Eio.Stdenv.mono_clock env)
             ~socket:(Connection_profile.socket captured)
             ~timeout_seconds:1.
         in
         let helper =
           Execution_helper.create ~sw ~env ~root ~client:factory |> Disk.unwrap
         in
         let directory = fixture env root () in
         let input = plan helper connection directory ~ticket:"task" () in
         let prepared = Execution_helper.prepare helper input |> Disk.unwrap in
         let raw = Execution_helper.Job.to_json prepared in
         let request =
           Json.field raw "native_request" |> Protocol.Request.of_json |> Disk.unwrap
         in
         let native =
           Transfer.Upload_plan.prepare
             ~fs:(Eio.Stdenv.fs env)
             ~params:(Protocol.Request.params request)
           |> Disk.unwrap
         in
         let pub = publication (Transfer.Upload_plan.params native) in
         finish := Some (Transfer.Upload_plan.finish_request native, pub);
         ignore
           (Execution_helper.start helper ~id:(id "publish") |> Disk.unwrap
            : Execution_helper.Job.t);
         let observed = await_published env helper "publish" in
         let state =
           Execution_helper.Job.to_json observed |> fun value -> Json.field value "state"
         in
         if not (String.equal (phase observed) "published")
         then print_endline (Json.canonical state);
         print_s
           [%sexp
             (phase observed : string)
           , (Json.text (Json.field (Json.field state "link") "kind") : string)];
         (* Remove original capture only after the externally committed resource is
         known. Explicit recovery must consult exact receipts, never file source. *)
         Eio.Path.unlink Eio.Path.(Eio.Stdenv.fs env / directory / "capture.json");
         let before = List.length !sent in
         let restored =
           Execution_helper.create ~sw ~env ~root ~client:factory |> Disk.unwrap
         in
         let recovered =
           Execution_helper.recover restored ~id:(id "publish") |> Disk.unwrap
         in
         let recovered = Execution_helper.Job.to_json recovered in
         let state = Json.field recovered "state" in
         let original =
           Json.field recovered "native_request" |> fun value -> Json.field value "params"
         in
         print_s
           [%sexp
             (Json.text (Json.field state "kind") : string)
           , (Json.text (Json.field (Json.field state "link") "kind") : string)
           , (Json.text (Json.field original "actor_id") : string)];
         print_s
           [%sexp
             (List.for_all
                !seen_socket
                ~f:(String.equal (Connection_profile.socket connection))
              : bool)
           , (List.take !sent (List.length !sent - before) |> List.rev : string list)];
         problem (Execution_helper.cleanup restored ~directory ~owner_token:token);
         let name = "execution-publish.json" in
         let stored = State_root.read root ~name |> Disk.unwrap |> Option.value_exn in
         let raw_state =
           Json.parse (Json.text (Json.field stored "state_text")) |> Disk.unwrap
         in
         List.iter
           [ Problem.Outcome_unknown; Local_io; Storage_unavailable ]
           ~f:(fun kind ->
             let bad_link =
               Json.obj
                 [ "kind", Json.string "rejected"
                 ; "problem", Problem.to_json (Problem.create kind "uncertain")
                 ]
             in
             let bad_state = Transfer_helper_tests.replace raw_state "link" bad_link in
             let bad =
               Transfer_helper_tests.replace
                 stored
                 "state_text"
                 (Json.string (Json.canonical bad_state))
             in
             State_root.save root ~name ~value:bad |> Disk.unwrap;
             problem (Execution_helper.create ~sw ~env ~root ~client:factory))));
  [%expect
    {|
    (published unknown)
    (published linked author)
    (true (workspace.receipt workspace.receipt))
    Conflict
    Corrupt_store
    Corrupt_store
    Corrupt_store
    |}]
;;

let%expect_test "compact saved pages preserve every intention without receipt bodies" =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let calls = ref 0 in
      let helper = create env root sw calls in
      List.iter [ "a"; "b"; "c" ] ~f:(fun name ->
        let directory = fixture env root ~name () in
        ignore
          (Execution_helper.prepare
             helper
             (plan helper (profile ()) directory ~intention:name ())
           |> Disk.unwrap
           : Execution_helper.Job.t));
      let first = Execution_helper.list helper ~offset:0 ~limit:2 |> Disk.unwrap in
      let second =
        Execution_helper.list
          helper
          ~offset:(Json.integer (Json.field first "next_offset"))
          ~limit:2
        |> Disk.unwrap
      in
      let items =
        Json.list (Json.field first "items") @ Json.list (Json.field second "items")
      in
      print_s
        [%sexp
          (List.map items ~f:(fun value ->
             Json.field (Json.field value "plan") "intention_id" |> Json.text)
           : string list)
        , (Json.integer (Json.field first "total") : int)
        , (List.for_all items ~f:(fun value ->
             Option.is_none (Json.optional value "native_request")
             && Option.is_none (Json.optional value "state"))
           : bool)];
      problem (Execution_helper.list helper ~offset:0 ~limit:26);
      print_s [%sexp (!calls : int)]));
  [%expect
    {|
    ((a b c) 3 true)
    Invalid_argument
    0
    |}]
;;

let%expect_test "package mismatch sends only initialize and preserves prepared identity" =
  let semantic = ref 0 in
  Rpc_socket_test.with_bridge
    ~initialize:(fun () -> Some (Rpc_socket_test.initialization ~version:"0.0.0" ()))
    (fun _ ->
       incr semantic;
       failwith "qualification must precede publication")
    (fun env root _store _bridge connection ->
       Eio.Switch.run (fun sw ->
         let helper =
           Execution_helper.create ~sw ~env ~root ~client:(fun captured ->
             Client.create
               ~net:(Eio.Stdenv.net env)
               ~clock:(Eio.Stdenv.mono_clock env)
               ~socket:(Connection_profile.socket captured)
               ~timeout_seconds:1.)
           |> Disk.unwrap
         in
         let directory = fixture env root () in
         let before =
           Execution_helper.prepare helper (plan helper connection directory ())
           |> Disk.unwrap
         in
         problem (Execution_helper.start helper ~id:(id "publish"));
         let after = Execution_helper.inspect helper ~id:(id "publish") |> Disk.unwrap in
         print_s
           [%sexp
             (String.equal
                (Json.canonical (Execution_helper.Job.to_json before))
                (Json.canonical (Execution_helper.Job.to_json after))
              : bool)
           , (!semantic : int)]));
  [%expect
    {|
    Unsupported_version
    (true 0)
    |}]
;;

let%expect_test
    "pending link retains known publication as running, coalesces start and finishes once"
  =
  let finish = ref None in
  let fs_ref = ref None in
  let links = ref 0 in
  let arrived, signal_arrived = Eio.Promise.create () in
  let gate, release = Eio.Promise.create () in
  let committed_link =
    Json.obj
      [ "data", Json.obj [ "revision", Json.int 2 ]
      ; "meta", Json.obj [ "durable", `True; "workspace_revision", Json.int 6 ]
      ]
  in
  Rpc_socket_test.with_bridge
    (fun request ->
       match Protocol.Request.method_ request with
       | "workspace.receipt" ->
         let request, response = Option.value_exn !finish in
         Some
           (Protocol.Success
              (receipt_response ~fs:(Option.value_exn !fs_ref) request response))
       | "resource.finish_upload" ->
         let _, response = Option.value_exn !finish in
         Some (Protocol.Success response)
       | "resource.link" ->
         incr links;
         Eio.Promise.resolve signal_arrived ();
         Eio.Promise.await gate;
         Some (Protocol.Success committed_link)
       | method_ -> failwith ("unexpected local evidence RPC " ^ method_))
    (fun env root _store _bridge connection ->
       Eio.Switch.run (fun sw ->
         fs_ref := Some (Eio.Stdenv.fs env);
         let helper =
           Execution_helper.create ~sw ~env ~root ~client:(fun captured ->
             Client.create
               ~net:(Eio.Stdenv.net env)
               ~clock:(Eio.Stdenv.mono_clock env)
               ~socket:(Connection_profile.socket captured)
               ~timeout_seconds:2.)
           |> Disk.unwrap
         in
         let directory = fixture env root () in
         let prepared =
           Execution_helper.prepare
             helper
             (plan helper connection directory ~ticket:"task" ())
           |> Disk.unwrap
         in
         let request =
           Execution_helper.Job.to_json prepared
           |> fun value ->
           Json.field value "native_request" |> Protocol.Request.of_json |> Disk.unwrap
         in
         let native =
           Transfer.Upload_plan.prepare
             ~fs:(Eio.Stdenv.fs env)
             ~params:(Protocol.Request.params request)
           |> Disk.unwrap
         in
         finish
         := Some
              ( Transfer.Upload_plan.finish_request native
              , publication (Transfer.Upload_plan.params native) );
         ignore
           (Execution_helper.start helper ~id:(id "publish") |> Disk.unwrap
            : Execution_helper.Job.t);
         Eio.Promise.await arrived;
         let running =
           Execution_helper.inspect helper ~id:(id "publish") |> Disk.unwrap
         in
         let raw =
           Execution_helper.Job.to_json running |> fun value -> Json.field value "state"
         in
         print_s
           [%sexp
             (phase running : string)
           , (Option.is_some (Json.optional (Json.field raw "previous") "publication")
              : bool)
           , (!links : int)];
         ignore
           (Execution_helper.start helper ~id:(id "publish") |> Disk.unwrap
            : Execution_helper.Job.t);
         problem (Execution_helper.retry_exact helper ~id:(id "publish"));
         print_s [%sexp (!links : int)];
         Eio.Promise.resolve release ();
         let final = await_published env helper "publish" in
         let raw =
           Execution_helper.Job.to_json final |> fun value -> Json.field value "state"
         in
         print_s
           [%sexp
             (phase final : string)
           , (Json.field (Json.field raw "link") "kind" |> Json.text : string)
           , (!links : int)]));
  [%expect
    {|
    (running true 1)
    Blocked
    1
    (published linked 1)
    |}]
;;

let publication_save_fault (Eio.Resource.T (directory, ops), path) ~armed ~renames =
  let module Directory = (val Eio.Resource.get ops Eio.Fs.Pi.Dir) in
  let module Wrapped = struct
    include Directory

    let rename directory source destination target =
      Directory.rename directory source destination target;
      if String.is_suffix target ~suffix:"execution-publish.json"
      then (
        incr renames;
        if !armed && !renames = 2
        then (
          armed := false;
          Json.fail Local_io "controlled execution metadata publication failure"))
    ;;
  end
  in
  ( Eio.Resource.T
      ( directory
      , Eio.Resource.handler
          (Eio.Resource.H (Eio.Fs.Pi.Dir, (module Wrapped)) :: Eio.Resource.bindings ops)
      )
  , path )
;;

let%expect_test
    "failed local acknowledgement finishes only the same binding and exact native intent"
  =
  let armed = ref true in
  let renames = ref 0 in
  let calls = ref 0 in
  Rpc_socket_test.with_bridge
    ~fs_adapter:(publication_save_fault ~armed ~renames)
    (fun _ -> failwith "local preparation must not send")
    (fun env root _store _bridge connection ->
       Eio.Switch.run (fun sw ->
         let helper = create env root sw calls in
         let directory = fixture env root () in
         let input = plan helper connection directory () in
         problem (Execution_helper.prepare helper input);
         let saved = Filename.concat directory "publication.json" in
         let before = Disk.read Eio.Path.(Eio.Stdenv.fs env / saved) in
         let recovered = Execution_helper.prepare helper input |> Disk.unwrap in
         let after = Disk.read Eio.Path.(Eio.Stdenv.fs env / saved) in
         let restarted = create env root sw calls in
         let same =
           Execution_helper.inspect restarted ~id:(id "publish") |> Disk.unwrap
         in
         print_s
           [%sexp
             (phase recovered : string)
           , (phase same : string)
           , (String.equal before after : bool)
           , (!calls : int)];
         problem
           (Execution_helper.prepare
              restarted
              (plan restarted connection directory ~ticket:"changed" ()))));
  [%expect
    {|
    Local_io
    (prepared_unsent prepared_unsent true 0)
    Idempotency_conflict
    |}]
;;

let%expect_test "execution summary list admits only exact bounded GET collection queries" =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let calls = ref 0 in
      let helper = create env root sw calls in
      let router, _, _, _ = Http_tests.router env root ~sw ~host:Http_tests.host in
      let router = Http_router.with_execution_helper router helper in
      List.iter
        [ "/ui-api/v1/execution-publications?offset=0&limit=25"
        ; "/ui-api/v1/execution-publications?limit=1"
        ; "/ui-api/v1/execution-publications?offset=0&offset=1"
        ; "/ui-api/v1/execution-publications?other=1"
        ; "/ui-api/v1/execution-publications?limit=26"
        ; "/ui-api/v1/execution-publications/missing?limit=1"
        ]
        ~f:(fun target -> printf "%d\n" (Http_tests.call router target).status);
      printf
        "post=%d calls=%d\n"
        (Http_tests.call
           router
           ~method_:"POST"
           ~body:"{}"
           "/ui-api/v1/execution-publications/prepare?limit=1")
          .status
        !calls));
  [%expect
    {|200
200
400
400
400
400
post=400 calls=0|}]
;;
