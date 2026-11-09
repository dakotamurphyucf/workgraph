open Core
open Workgraph
open Workgraph_ui
open State_tests

let stage_id value = Transfer_helper.Stage.Id.of_string value |> Disk.unwrap
let intention value = Operation.Id.of_string value |> Disk.unwrap

let job_phase value =
  Json.field (Transfer_helper.Job.to_json value) "phase"
  |> fun v -> Json.text (Json.field v "kind")
;;

let stage_field value name = Json.field (Transfer_helper.Stage.to_json value) name

let params ?(title = "Artifact") () =
  Json.obj
    [ "workspace_id", Json.string "demo"
    ; "actor_id", Json.string "author"
    ; "resource_id", Json.string "artifact"
    ; "expected_revision", Json.int 0
    ; "title", Json.string title
    ; "filename", Json.string "artifact.txt"
    ; "mime_type", Json.string "text/plain"
    ]
;;

let plan ?(title = "Artifact") () =
  Transfer_helper.Plan.create
    ~intention_id:(intention "upload")
    ~connection:(profile ())
    ~context:(context ())
    ~stage_id:(stage_id "source")
    ~params:(params ~title ())
  |> Disk.unwrap
;;

let create env root sw calls =
  Transfer_helper.create ~sw ~env ~root ~client:(fun _ ->
    incr calls;
    Error (Problem.create Unsupported_version "synthetic unmatched daemon"))
  |> Disk.unwrap
;;

let stage helper bytes =
  let id = stage_id "source" in
  ignore
    (Transfer_helper.begin_stage
       helper
       ~id
       ~digest:(Json.hash bytes)
       ~size_bytes:(String.length bytes)
     |> Disk.unwrap
     : Transfer_helper.Stage.t);
  if not (String.is_empty bytes)
  then
    ignore
      (Transfer_helper.append_stage helper ~id ~byte_offset:0 ~bytes |> Disk.unwrap
       : Transfer_helper.Stage.t);
  Transfer_helper.seal_stage helper ~id |> Disk.unwrap
;;

let%expect_test "private staging exact ranges, sealed identity and restart inventory" =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let calls = ref 0 in
      let helper = create env root sw calls in
      let id = stage_id "source" in
      ignore
        (Transfer_helper.begin_stage helper ~id ~digest:(Json.hash "abc") ~size_bytes:3
         |> Disk.unwrap
         : Transfer_helper.Stage.t);
      problem (Transfer_helper.append_stage helper ~id ~byte_offset:1 ~bytes:"b");
      ignore
        (Transfer_helper.append_stage helper ~id ~byte_offset:0 ~bytes:"ab" |> Disk.unwrap
         : Transfer_helper.Stage.t);
      problem (Transfer_helper.append_stage helper ~id ~byte_offset:0 ~bytes:"zz");
      problem (Transfer_helper.seal_stage helper ~id);
      ignore
        (Transfer_helper.append_stage helper ~id ~byte_offset:0 ~bytes:"abc"
         |> Disk.unwrap
         : Transfer_helper.Stage.t);
      let sealed = Transfer_helper.seal_stage helper ~id |> Disk.unwrap in
      print_s [%sexp (Json.text (stage_field sealed "status") : string)];
      problem (Transfer_helper.append_stage helper ~id ~byte_offset:0 ~bytes:"abc");
      let restored = create env root sw calls in
      let same = Transfer_helper.inspect_stage restored ~id |> Disk.unwrap in
      print_s
        [%sexp
          (String.equal
             (Json.canonical (Transfer_helper.Stage.to_json sealed))
             (Json.canonical (Transfer_helper.Stage.to_json same))
           : bool)];
      problem (Transfer_helper.abandon_stage restored ~id);
      let inventory =
        Transfer_helper.list_stages restored ~offset:0 ~limit:100 |> Disk.unwrap
      in
      print_s
        [%sexp
          (Json.integer (Json.field inventory "retained_bytes") : int), (!calls : int)]));
  [%expect
    {|
    Invalid_argument
    Conflict
    Invalid_argument
    sealed
    Conflict
    true
    ok
    (0 0)
    |}]
;;

let%expect_test "capacity includes prepared sources and abandonment releases bytes" =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let calls = ref 0 in
      let helper = create env root sw calls in
      let reserve id =
        Transfer_helper.begin_stage
          helper
          ~id:(stage_id id)
          ~digest:(String.make 64 'a')
          ~size_bytes:Resource.max_blob_bytes
      in
      ignore (reserve "a" |> Disk.unwrap : Transfer_helper.Stage.t);
      ignore (reserve "b" |> Disk.unwrap : Transfer_helper.Stage.t);
      problem (reserve "c");
      problem (Transfer_helper.abandon_stage helper ~id:(stage_id "a"));
      problem (reserve "c");
      let data = Transfer_helper.list_stages helper ~offset:0 ~limit:100 |> Disk.unwrap in
      print_s
        [%sexp (Json.integer (Json.field data "retained_bytes") : int), (!calls : int)]));
  [%expect
    {|
    Conflict
    ok
    ok
    (134217728 0)
    |}]
;;

let%expect_test "full-input dedup, native saved identity and qualification rejection" =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let calls = ref 0 in
      let helper = create env root sw calls in
      ignore (stage helper "abc" : Transfer_helper.Stage.t);
      let first = Transfer_helper.prepare helper (plan ()) |> Disk.unwrap in
      let again = Transfer_helper.prepare helper (plan ()) |> Disk.unwrap in
      print_s
        [%sexp
          (String.equal
             (Json.canonical (Transfer_helper.Job.to_json first))
             (Json.canonical (Transfer_helper.Job.to_json again))
           : bool)];
      problem (Transfer_helper.prepare helper (plan ~title:"Changed" ()));
      problem (Transfer_helper.abandon_stage helper ~id:(stage_id "source"));
      let restored = create env root sw calls in
      let saved =
        Transfer_helper.inspect restored ~id:(intention "upload") |> Disk.unwrap
      in
      print_s [%sexp (job_phase saved : string)];
      let reserve name =
        Transfer_helper.begin_stage
          restored
          ~id:(stage_id name)
          ~digest:(String.make 64 'a')
          ~size_bytes:Resource.max_blob_bytes
      in
      ignore (reserve "large-a" |> Disk.unwrap : Transfer_helper.Stage.t);
      (* One incoming source remains below the two-stage count, but the retained
         prepared three-byte source makes a second64MiB allocation exceed128MiB. *)
      problem (reserve "large-b");
      problem (Transfer_helper.start restored ~id:(intention "upload"));
      let after =
        Transfer_helper.inspect restored ~id:(intention "upload") |> Disk.unwrap
      in
      print_s [%sexp (job_phase after : string), (!calls : int)];
      let raw = Transfer_helper.Job.to_json after in
      let native = Json.field raw "native_plan" in
      print_s
        [%sexp (Json.text (Json.field native "mutation_id") |> String.is_empty : bool)];
      let journal = Json.text (Json.field raw "journal_path") in
      let request =
        Disk.read_with_limit
          Eio.Path.(State_root.directory root / journal)
          ~max_bytes:1048576
        |> Json.parse
        |> Disk.unwrap
        |> Protocol.Request.of_json
        |> Disk.unwrap
      in
      print_s
        [%sexp
          (String.equal
             (Json.canonical (Protocol.Request.to_json request))
             (Json.canonical (Json.field raw "saved_request"))
           : bool)]));
  [%expect
    {|
    true
    Idempotency_conflict
    Conflict
    prepared_unsent
    Conflict
    Unsupported_version
    (prepared_unsent 1)
    false
    true
    |}]
;;

let%expect_test "sealed SHA mismatch and captured writer fail before daemon contact" =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let calls = ref 0 in
      let helper = create env root sw calls in
      let id = stage_id "source" in
      ignore
        (Transfer_helper.begin_stage
           helper
           ~id
           ~digest:(Json.hash "different")
           ~size_bytes:3
         |> Disk.unwrap
         : Transfer_helper.Stage.t);
      ignore
        (Transfer_helper.append_stage helper ~id ~byte_offset:0 ~bytes:"abc"
         |> Disk.unwrap
         : Transfer_helper.Stage.t);
      problem (Transfer_helper.seal_stage helper ~id);
      problem
        (Transfer_helper.Plan.create
           ~intention_id:(intention "upload")
           ~connection:(profile ())
           ~context:(context ~actor:"other" ())
           ~stage_id:id
           ~params:(params ()));
      print_s [%sexp (!calls : int)]));
  [%expect
    {|
    Conflict
    Invalid_argument
    0
    |}]
;;

let replace value name replacement =
  match value with
  | `Object fields ->
    Json.obj (List.Assoc.add fields ~equal:String.equal name replacement)
  | _ -> assert false
;;

let%expect_test
    "restart fences admitted work and failed qualification preserves exact unknown"
  =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let calls = ref 0 in
      let helper = create env root sw calls in
      ignore (stage helper "abc" : Transfer_helper.Stage.t);
      let prepared = Transfer_helper.prepare helper (plan ()) |> Disk.unwrap in
      let name = "resource-transfer-1.json" in
      let saved = State_root.read root ~name |> Disk.unwrap |> Option.value_exn in
      let running =
        replace
          (Transfer_helper.Job.to_json prepared)
          "phase"
          (Json.obj [ "kind", Json.string "running"; "previous", `Null ])
      in
      State_root.save root ~name ~value:(replace saved "jobs" (`Array [ running ]))
      |> Disk.unwrap;
      let restarted = create env root sw calls in
      let before =
        Transfer_helper.inspect restarted ~id:(intention "upload")
        |> Disk.unwrap
        |> Transfer_helper.Job.to_json
      in
      print_s [%sexp (Json.text (Json.field (Json.field before "phase") "kind") : string)];
      problem (Transfer_helper.retry_exact restarted ~id:(intention "upload"));
      problem (Transfer_helper.recover restarted ~id:(intention "upload"));
      let after =
        Transfer_helper.inspect restarted ~id:(intention "upload")
        |> Disk.unwrap
        |> Transfer_helper.Job.to_json
      in
      print_s
        [%sexp
          (String.equal (Json.canonical before) (Json.canonical after) : bool)
        , (!calls : int)];
      let source =
        Transfer_helper.inspect_stage restarted ~id:(stage_id "source") |> Disk.unwrap
      in
      print_s
        [%sexp
          (String.equal
             (Json.canonical (stage_field source "source_retained"))
             (Json.canonical `True)
           : bool)];
      (* A cleaned source without a verified finish must never reopen as a
       recoverable unknown with its only retry bytes silently lost. *)
      let saved = State_root.read root ~name |> Disk.unwrap |> Option.value_exn in
      let sources =
        Json.list (Json.field saved "stages")
        |> List.map ~f:(fun source -> replace source "source_retained" `False)
      in
      State_root.save root ~name ~value:(replace saved "stages" (`Array sources))
      |> Disk.unwrap;
      problem (Transfer_helper.create ~sw ~env ~root ~client:(fun _ -> assert false))));
  [%expect
    {|
    outcome_unknown
    Unsupported_version
    Unsupported_version
    (true 2)
    true
    Corrupt_store
    |}]
;;

(* Real private filesystem providers; a controlled monotonic timer expires at
   the selected publication boundary, without a production timeout hook. *)
let boundary_fs (Eio.Resource.T (directory, ops), path) ~armed ~at_cleanup ~expire =
  let module Directory = (val Eio.Resource.get ops Eio.Fs.Pi.Dir) in
  let hit () =
    if !armed
    then (
      armed := false;
      !expire ();
      Eio.Fiber.yield ())
  in
  let module Wrapped = struct
    include Directory

    let unlink directory name =
      if at_cleanup && String.is_suffix name ~suffix:"source.part" then hit ();
      Directory.unlink directory name
    ;;

    let rename directory source destination target =
      Directory.rename directory source destination target;
      if (not at_cleanup) && String.is_suffix target ~suffix:"resource-transfer-1.json"
      then hit ()
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

let timed_environment env timer : Eio_unix.Stdenv.base =
  object
    method stdin = env#stdin
    method stdout = env#stdout
    method stderr = env#stderr
    method net = env#net
    method process_mgr = env#process_mgr
    method clock = env#clock
    method mono_clock = timer
    method fs = env#fs
    method cwd = env#cwd
    method secure_random = env#secure_random
    method debug = env#debug
    method backend_id = env#backend_id
    method domain_mgr = env#domain_mgr
  end
;;

let publication =
  let version =
    Json.obj
      [ "revision", Json.int 1
      ; "digest", Json.string (Json.hash "abc")
      ; "size_bytes", Json.int 3
      ; "actor_id", Json.string "author"
      ; "timestamp", Json.string "2026-11-07T00:00:00Z"
      ; "filename", Json.string "artifact.txt"
      ; "mime_type", Json.string "text/plain"
      ]
  in
  Json.obj
    [ ( "data"
      , Json.obj
          [ "resource_id", Json.string "artifact"
          ; "revision", Json.int 1
          ; "version", version
          ] )
    ; "meta", Json.obj [ "durable", `True; "workspace_revision", Json.int 5 ]
    ]
;;

let timeout_boundary ~at_cleanup =
  let armed = ref false in
  let expire = ref ignore in
  let sends = ref [] in
  let invalid_link_receipt = ref false in
  Rpc_socket_test.with_bridge
    ~fs_adapter:(boundary_fs ~armed ~at_cleanup ~expire)
    (fun request ->
       let method_ = Protocol.Request.method_ request in
       sends := method_ :: !sends;
       Some
         (Protocol.Success
            (match method_ with
             | "workspace.receipt" ->
               if !invalid_link_receipt
               then (
                 let mutation =
                   Json.text (Json.field (Protocol.Request.params request) "mutation_id")
                 in
                 Json.obj
                   [ ( "data"
                     , if String.is_prefix mutation ~prefix:"link_"
                       then Json.obj [ "status", Json.string "committed" ]
                       else Json.obj [ "status", Json.string "absent" ] )
                   ; "meta", Json.obj [ "workspace_revision", Json.int 6 ]
                   ])
               else
                 Json.obj
                   [ "data", Json.obj [ "status", Json.string "committed" ]
                   ; "meta", Json.obj []
                   ]
             | "resource.finish_upload" -> publication
             | "resource.link" ->
               Json.obj
                 [ "data", Json.obj [ "revision", Json.int 2 ]
                 ; "meta", Json.obj [ "durable", `True; "workspace_revision", Json.int 6 ]
                 ]
             | _ -> failwith ("unexpected transfer request " ^ method_))))
    (fun env root _store _bridge connection ->
       Eio.Switch.run (fun sw ->
         let elapsed, resolve = Eio.Promise.create () in
         (expire := fun () -> Eio.Promise.resolve resolve ());
         let module Clock = struct
           type t = unit
           type time = Mtime.t

           let now () = Mtime.of_uint64_ns 0L
           let sleep_until () _ = Eio.Promise.await elapsed
         end
         in
         let timer = Eio.Resource.T ((), Eio.Time.Pi.clock (module Clock)) in
         let factory _ =
           Client.create
             ~net:(Eio.Stdenv.net env)
             ~clock:(Eio.Stdenv.mono_clock env)
             ~socket:(Connection_profile.socket connection)
             ~timeout_seconds:2.
         in
         let helper =
           Transfer_helper.create
             ~sw
             ~env:(timed_environment env timer)
             ~root
             ~client:factory
           |> Disk.unwrap
         in
         ignore (stage helper "abc" : Transfer_helper.Stage.t);
         let input =
           Transfer_helper.Plan.create
             ~intention_id:(intention "upload")
             ~connection
             ~context:(context ())
             ~stage_id:(stage_id "source")
             ~params:(replace (params ()) "ticket_id" (Json.string "ticket"))
           |> Disk.unwrap
         in
         ignore
           (Transfer_helper.prepare helper input |> Disk.unwrap : Transfer_helper.Job.t);
         armed := true;
         ignore
           (Transfer_helper.start helper ~id:(intention "upload")
            : (Transfer_helper.Job.t, Problem.t) Result.t);
         Rpc_socket_test.until env (fun () ->
           let value =
             Transfer_helper.inspect helper ~id:(intention "upload") |> Disk.unwrap
           in
           String.equal
             (job_phase value)
             (if at_cleanup then "published" else "outcome_unknown"));
         let value =
           Transfer_helper.inspect helper ~id:(intention "upload") |> Disk.unwrap
         in
         let phase = Json.field (Transfer_helper.Job.to_json value) "phase" in
         print_s [%sexp (job_phase value : string), (List.rev !sends : string list)];
         if at_cleanup
         then
           print_s
             [%sexp (Json.text (Json.field (Json.field phase "link") "kind") : string)];
         let reloaded =
           Transfer_helper.create ~sw ~env ~root ~client:factory |> Disk.unwrap
         in
         print_s
           [%sexp
             (job_phase
                (Transfer_helper.inspect reloaded ~id:(intention "upload") |> Disk.unwrap)
              : string)];
         if at_cleanup
         then (
           invalid_link_receipt := true;
           problem (Transfer_helper.recover reloaded ~id:(intention "upload"));
           let saved =
             Transfer_helper.inspect reloaded ~id:(intention "upload")
             |> Disk.unwrap
             |> Transfer_helper.Job.to_json
           in
           let phase = Json.field saved "phase" in
           print_s
             [%sexp
               (Json.text (Json.field phase "kind") : string)
             , (Json.text (Json.field (Json.field phase "link") "kind") : string)
             , (not (String.equal (Json.canonical (Json.field saved "diagnostic")) "null")
                : bool)])))
;;

let%expect_test
    "outer timeout during Running barrier leaves explicit unknown and no native send"
  =
  timeout_boundary ~at_cleanup:false;
  [%expect
    {|
    (outcome_unknown ())
    outcome_unknown
    |}]
;;

let%expect_test
    "outer timeout at source cleanup retains durable finish and completed link"
  =
  timeout_boundary ~at_cleanup:true;
  [%expect
    {|
    (published (workspace.receipt resource.finish_upload resource.link))
    committed
    published
    ok
    (published committed true)
    |}]
;;

let%expect_test
    "closed staging HTTP routes preserve boundary, byte codec and retained capture"
  =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      let calls = ref 0 in
      let helper = create env root sw calls in
      let router, profiles, _, _ = Http_tests.router env root ~sw ~host:Http_tests.host in
      let router = Http_router.with_transfer_helper router helper in
      Connection_profile.Store.put profiles (profile ()) ~expected_generation:None
      |> Disk.unwrap;
      let post path body =
        Http_tests.call router ~method_:"POST" ~body:(Json.canonical body) path
      in
      let start =
        Json.obj
          [ "stage_id", Json.string "source"
          ; "digest", Json.string (Json.hash "abc")
          ; "size_bytes", Json.int 3
          ]
      in
      print_s [%sexp ((post "/ui-api/v1/resource-stages/prepare" start).status : int)];
      print_s
        [%sexp
          ((post
              "/ui-api/v1/resource-stages/source/chunks"
              (Json.obj [ "offset", Json.int 0; "data_base64", Json.string "YWJj\n" ]))
             .status
           : int)];
      print_s
        [%sexp
          ((post
              "/ui-api/v1/resource-stages/source/chunks"
              (Json.obj [ "offset", Json.int 0; "data_base64", Json.string "YWJj" ]))
             .status
           : int)];
      print_s
        [%sexp
          ((post "/ui-api/v1/resource-stages/source/seal" (Json.obj [])).status : int)];
      let input =
        Json.obj
          [ "stage_id", Json.string "source"
          ; ( "preparation"
            , Json.obj
                [ "intention_id", Json.string "upload"
                ; "connection_id", Json.string "local"
                ; "generation", Json.string "1"
                ; "context", Operation.Context.to_json (context ())
                ; "method", Json.string "resource.upload"
                ; "params", params ()
                ] )
          ]
      in
      let prepared = post "/ui-api/v1/resource-uploads/prepare" input in
      print_s [%sexp (prepared.status : int)];
      print_s
        [%sexp
          ((Http_tests.call router "/ui-api/v1/resource-stages?offset=0&limit=1").status
           : int)
        , ((Http_tests.call router "/ui-api/v1/resource-uploads?limit=1").status : int)
        , ((Http_tests.call router "/ui-api/v1/resource-uploads/upload?limit=1").status
           : int)];
      print_s
        [%sexp
          ((post "/ui-api/v1/resource-stages/source/abandon" (Json.obj [])).status : int)];
      let started = post "/ui-api/v1/resource-uploads/upload/start" (Json.obj []) in
      print_s [%sexp (started.status : int), (!calls : int)];
      let response =
        Http_tests.call
          router
          ~headers:[ "Host", Http_tests.host ]
          "/ui-api/v1/resource-stages"
      in
      print_s [%sexp (response.status : int)]));
  [%expect
    {|
    200
    400
    200
    200
    200
    (200 200 400)
    409
    (400 1)
    403
    |}]
;;
