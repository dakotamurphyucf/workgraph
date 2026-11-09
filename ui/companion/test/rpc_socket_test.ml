open Core
open Workgraph
open Workgraph_ui
open State_tests
open Rpc_tests

let initialization ?(version = Version.value) () =
  let data =
    Api_method.encode_response
      Daemon_methods.initialize
      { (Daemon_methods.Initialization.current ()) with version }
  in
  Protocol.Success (Api_response.project Value data |> Api_response.to_json)
;;

let with_bridge
      ?(fs_adapter = Fn.id)
      ?(after = fun _ -> ())
      ?(initialize = fun () -> Some (initialization ()))
      handler
      f
  =
  Eio_main.run (fun env ->
    let fs = Eio.Stdenv.fs env in
    let bytes = Cstruct.create 32 in
    Eio.Flow.read_exact (Eio.Stdenv.secure_random env) bytes;
    let path = "/tmp/workgraph-ui-rpc-" ^ Json.hash (Cstruct.to_string bytes) in
    Eio.Path.mkdir ~perm:0o700 Eio.Path.(fs / path);
    Exn.protect
      ~finally:(fun () -> remove Eio.Path.(fs / path))
      ~f:(fun () ->
        Eio.Time.Timeout.run_exn
          (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock env) 10.)
          (fun () ->
             Eio.Switch.run (fun root_sw ->
               let root =
                 State_root.acquire
                   ~sw:root_sw
                   ~fs:(fs_adapter fs)
                   ~random:(Eio.Stdenv.secure_random env)
                   ~path
                 |> Disk.unwrap
               in
               let store =
                 Operation_store.create ~root ~random:(Eio.Stdenv.secure_random env)
                 |> Disk.unwrap
               in
               Eio.Switch.run (fun sw ->
                 let socket = State_root.path root ^ "/s" in
                 let listener =
                   Platform.listen_unix
                     ~sw
                     ~path:socket
                     ~backlog:32
                     ~on_cleanup_error:failwith
                 in
                 let stop, stop_resolve = Eio.Promise.create () in
                 Eio.Fiber.fork ~sw (fun () ->
                   Eio.Net.run_server ~stop ~on_error:raise listener (fun flow _ ->
                     let request =
                       Framing.read flow |> Protocol.Request.of_json |> Disk.unwrap
                     in
                     let response =
                       if String.equal (Protocol.Request.method_ request) "initialize"
                       then initialize ()
                       else handler request
                     in
                     match response with
                     | None -> ()
                     | Some response ->
                       Framing.write flow (Protocol.response_json request response)));
                 let bridge =
                   Rpc_bridge.create
                     ~sw
                     ~net:(Eio.Stdenv.net env)
                     ~clock:(Eio.Stdenv.mono_clock env)
                     ~random:(Eio.Stdenv.secure_random env)
                     ~store
                     ~scheduler:(Read_scheduler.create ())
                 in
                 Exn.protect
                   ~finally:(fun () -> Eio.Promise.resolve stop_resolve ())
                   ~f:(fun () -> f env root store bridge (profile ~socket ())));
               after store))))
;;

let input
      ?(intention = "intent")
      ?(method_ = "ticket.metadata")
      ?(params =
        {|{"workspace_id":"demo","actor_id":"author","ticket_id":"task","expected_revision":"1"}|})
      connection
  =
  Operation.Preparation.create
    ~intention_id:intention
    ~connection
    ~context:(context ())
    ~method_
    ~params:(json params)
  |> Disk.unwrap
;;

let prepare bridge input =
  Rpc_bridge.prepare bridge input |> Disk.unwrap |> Operation_store.operation
;;

let observe store id = Operation_store.inspect store ~id |> Disk.unwrap

let until env predicate =
  Eio.Time.Timeout.run_exn
    (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock env) 5.)
    (fun () ->
       let rec loop () =
         if predicate ()
         then ()
         else (
           Eio.Time.Mono.sleep (Eio.Stdenv.mono_clock env) 0.001;
           loop ())
       in
       loop ())
;;

let%expect_test
    "descriptor Read enforcement and full read result validation precede any mutation I/O"
  =
  let calls = ref 0 in
  with_bridge
    (fun _ ->
       incr calls;
       Some (Success (json {|{"data":{},"meta":{}}|})))
    (fun _ _ _ bridge connection ->
       problem (Rpc_bridge.read bridge ~connection ~lane:Visible (metadata_request ()));
       print_s [%sexp (!calls : int)];
       problem
         (Rpc_bridge.read
            bridge
            ~connection
            ~lane:Visible
            (request "daemon.health" {|{}|}));
       print_s [%sexp (!calls : int)]);
  [%expect
    {|Invalid_argument
0
Invalid_argument
1|}]
;;

let%expect_test
    "read continuation retains the returned capture and never drains or refreshes guards"
  =
  let calls = ref 0 in
  with_bridge
    (fun _ ->
       incr calls;
       Some
         (Success
            (json
               {|{"data":{"items":[],"next_offset":"1","omitted":"1"},"meta":{"query_scope":"runs","query_revision":"7","history_capture":{"workspace_id":"demo","head":null,"sequence":"0"}}}|})))
    (fun _ _ _ bridge connection ->
       let first = request "run.list" {|{"workspace_id":"demo"}|} in
       let response =
         Rpc_bridge.read bridge ~connection ~lane:History first |> Disk.unwrap
       in
       let pagination = Json.field response "pagination" in
       let next =
         Json.field pagination "next_request" |> Protocol.Request.of_json |> Disk.unwrap
       in
       print_endline (Json.canonical (Protocol.Request.params next));
       print_s [%sexp (!calls : int)];
       problem
         (Rpc_bridge.read
            bridge
            ~connection
            ~lane:History
            (request "run.list" {|{"workspace_id":"demo","expected_revision":"8"}|}));
       print_s [%sexp (!calls : int)]);
  [%expect
    {|{"expected_revision":"7","head":null,"offset":"1","workspace_id":"demo"}
1
Conflict
2|}]
;;

let%expect_test
    "same Sending flight coalesces; definite Outcome_unknown stays uncertain; retry uses \
     exact bytes"
  =
  let calls = ref [] in
  let first_seen, first_resolve = Eio.Promise.create () in
  let release, release_resolve = Eio.Promise.create () in
  with_bridge
    (fun request ->
       calls := Json.canonical (Protocol.Request.to_json request) :: !calls;
       if List.length !calls = 1
       then (
         Eio.Promise.resolve first_resolve ();
         Eio.Promise.await release;
         Some (Failure (Problem.create Outcome_unknown "daemon uncertain")))
       else Some (Success (Api_response.to_json (committed ()))))
    (fun env _ store bridge connection ->
       let original = prepare bridge (input connection) in
       let id = Operation.id original in
       print_endline (state (Rpc_bridge.execute bridge ~id ~retry:false |> Disk.unwrap));
       Eio.Promise.await first_seen;
       print_endline (state (Rpc_bridge.execute bridge ~id ~retry:false |> Disk.unwrap));
       print_s [%sexp (List.length !calls : int)];
       Eio.Promise.resolve release_resolve ();
       until env (fun () -> String.equal (state (observe store id)) "outcome_unknown");
       print_endline (state (Rpc_bridge.execute bridge ~id ~retry:false |> Disk.unwrap));
       print_s [%sexp (List.length !calls : int)];
       ignore (Rpc_bridge.execute bridge ~id ~retry:true |> Disk.unwrap : Operation.t);
       until env (fun () -> String.equal (state (observe store id)) "committed");
       print_s
         [%sexp
           ((List.length !calls, String.equal (List.hd_exn !calls) (List.last_exn !calls))
            : int * bool)]);
  [%expect
    {|sending
sending
1
outcome_unknown
1
(2 true)|}]
;;

let%expect_test "unknown malformed acknowledgement and definite rejection remain distinct"
  =
  let outcomes : Protocol.response option list ref =
    ref
      [ Some
          (Protocol.Success
             (json {|{"data":{},"meta":{"durable":true,"workspace_revision":"1"}}|}))
      ; Some (Failure (Problem.create Conflict "guard mismatch"))
      ; None
      ]
  in
  with_bridge
    (fun _ ->
       let next = List.hd_exn !outcomes in
       outcomes := List.tl_exn !outcomes;
       next)
    (fun env _ store bridge connection ->
       List.iteri [ "bad"; "reject"; "drop" ] ~f:(fun index intention ->
         let original = prepare bridge (input ~intention connection) in
         let id = Operation.id original in
         ignore (Rpc_bridge.execute bridge ~id ~retry:false |> Disk.unwrap : Operation.t);
         until env (fun () -> not (String.equal (state (observe store id)) "sending"));
         print_s [%sexp (index : int)];
         print_endline (state (observe store id))));
  [%expect
    {|0
outcome_unknown
1
rejected
2
outcome_unknown|}]
;;

let%expect_test
    "known empty claim_next is observed and retries only by explicit exact request"
  =
  let requests = ref [] in
  with_bridge
    (fun request ->
       requests := Json.canonical (Protocol.Request.to_json request) :: !requests;
       Some (Success (Api_response.to_json (empty ()))))
    (fun env _ store bridge connection ->
       let original =
         prepare
           bridge
           (input
              ~method_:"ticket.claim_next"
              ~params:
                {|{"workspace_id":"demo","actor_id":"author","target_run_id":"worker","attempt_id":"attempt"}|}
              connection)
       in
       let id = Operation.id original in
       ignore (Rpc_bridge.execute bridge ~id ~retry:false |> Disk.unwrap : Operation.t);
       until env (fun () -> String.equal (state (observe store id)) "observed");
       print_endline (state (Rpc_bridge.execute bridge ~id ~retry:false |> Disk.unwrap));
       print_s [%sexp (List.length !requests : int)];
       ignore (Rpc_bridge.execute bridge ~id ~retry:true |> Disk.unwrap : Operation.t);
       until env (fun () ->
         List.length !requests = 2 && String.equal (state (observe store id)) "observed");
       print_s
         [%sexp
           (( List.length !requests
            , String.equal (List.hd_exn !requests) (List.last_exn !requests) )
            : int * bool)]);
  [%expect
    {|observed
1
(2 true)|}]
;;

let gate_fs (Eio.Resource.T (directory, ops), path) ~armed ~blocked ~release =
  let module Directory = (val Eio.Resource.get ops Eio.Fs.Pi.Dir) in
  let module Wrapped = struct
    include Directory

    let open_out directory ~sw ~append ~create name =
      let (Eio.Resource.T (file, file_ops)) =
        Directory.open_out directory ~sw ~append ~create name
      in
      let module File = (val Eio.Resource.get file_ops Eio.File.Pi.Write) in
      let module Wrapped_file = struct
        include File

        let sync file =
          if
            !armed
            && String.is_substring name ~substring:"operation-"
            && String.is_substring name ~substring:".tmp-"
          then (
            armed := false;
            Eio.Promise.resolve blocked ();
            Eio.Promise.await release);
          File.sync file
        ;;
      end
      in
      Eio.Resource.T
        ( file
        , Eio.Resource.handler
            (Eio.Resource.H (Eio.File.Pi.Write, (module Wrapped_file))
             :: Eio.Resource.bindings file_ops) )
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
    "browser waiter cancellation cannot cancel the service-owned admission sync or write"
  =
  let armed = ref false in
  let blocked, blocked_resolve = Eio.Promise.create () in
  let release, release_resolve = Eio.Promise.create () in
  let calls = ref 0 in
  with_bridge
    ~fs_adapter:(gate_fs ~armed ~blocked:blocked_resolve ~release)
    (fun _ ->
       incr calls;
       Some (Success (Api_response.to_json (committed ()))))
    (fun env _ store bridge connection ->
       Eio.Switch.run (fun caller_sw ->
         let original = prepare bridge (input connection) in
         let id = Operation.id original in
         armed := true;
         let cancel, cancel_resolve = Eio.Promise.create () in
         let stopped, stopped_resolve = Eio.Promise.create () in
         Eio.Fiber.fork ~sw:caller_sw (fun () ->
           (try
              Eio.Cancel.sub (fun context ->
                Eio.Promise.resolve cancel_resolve context;
                ignore
                  (Rpc_bridge.execute bridge ~id ~retry:false
                   : (Operation.t, Problem.t) Result.t))
            with
            | Eio.Cancel.Cancelled _ -> ());
           Eio.Promise.resolve stopped_resolve ());
         let cancel = Eio.Promise.await cancel in
         Eio.Promise.await blocked;
         Eio.Cancel.cancel cancel Exit;
         Eio.Promise.await stopped;
         print_s [%sexp (!calls : int)];
         Eio.Promise.resolve release_resolve ();
         until env (fun () -> String.equal (state (observe store id)) "committed");
         print_s [%sexp (!calls : int)];
         print_endline (state (observe store id))));
  [%expect
    {|0
1
committed|}]
;;

let%expect_test
    "concurrent receipt recovery rebases stale definitive results and never loses an \
     earlier commit"
  =
  List.iter [ false; true ] ~f:(fun receipt_first ->
    let write_seen, write_seen_resolve = Eio.Promise.create () in
    let lookup_seen, lookup_seen_resolve = Eio.Promise.create () in
    let write_release, write_release_resolve = Eio.Promise.create () in
    let lookup_release, lookup_release_resolve = Eio.Promise.create () in
    let saved_hash = ref "" in
    let saved_id = ref None in
    with_bridge
      ~after:(fun store ->
        print_endline ("settled " ^ state (observe store (Option.value_exn !saved_id))))
      (fun request ->
         if String.equal (Protocol.Request.method_ request) "workspace.receipt"
         then (
           Eio.Promise.resolve lookup_seen_resolve ();
           Eio.Promise.await lookup_release;
           Some
             (Success
                (Json.obj
                   [ ( "data"
                     , Json.obj
                         [ "status", Json.string "committed"
                         ; "request_hash", Json.string !saved_hash
                         ; "response", Api_response.to_json (committed ())
                         ] )
                   ; "meta", Json.obj []
                   ])))
         else (
           Eio.Promise.resolve write_seen_resolve ();
           Eio.Promise.await write_release;
           Some (Failure (Problem.create Outcome_unknown "late uncertain transport"))))
      (fun env _ store bridge connection ->
         Eio.Switch.run (fun sw ->
           let original = prepare bridge (input connection) in
           let id = Operation.id original in
           saved_id := Some id;
           let entry = Operation_store.journal_entry store original |> Disk.unwrap in
           saved_hash
           := (Request_journal.Entry.mutation entry |> Option.value_exn).request_hash;
           ignore
             (Rpc_bridge.execute bridge ~id ~retry:false |> Disk.unwrap : Operation.t);
           Eio.Promise.await write_seen;
           let recovered, recovered_resolve = Eio.Promise.create () in
           Eio.Fiber.fork ~sw (fun () ->
             Eio.Promise.resolve recovered_resolve (Rpc_bridge.recover bridge ~id));
           Eio.Promise.await lookup_seen;
           if receipt_first
           then (
             Eio.Promise.resolve lookup_release_resolve ();
             let result = Eio.Promise.await recovered |> Disk.unwrap in
             print_endline (state result);
             Eio.Promise.resolve write_release_resolve ();
             (* A following explicit execute joins the same task and does not send. *)
             print_endline
               (state (Rpc_bridge.execute bridge ~id ~retry:false |> Disk.unwrap)))
           else (
             Eio.Promise.resolve write_release_resolve ();
             until env (fun () ->
               String.equal (state (observe store id)) "outcome_unknown");
             let revision = Operation.revision (observe store id) in
             Eio.Promise.resolve lookup_release_resolve ();
             let result = Eio.Promise.await recovered |> Disk.unwrap in
             print_s [%sexp (Operation.revision result > revision : bool)];
             print_endline (state result)))));
  [%expect
    {|true
committed
settled committed
committed
committed
settled committed|}]
;;

let%expect_test
    "write flight saturation rejects before admission, coalesces existing work, and \
     releases capacity"
  =
  let release, release_resolve = Eio.Promise.create () in
  let calls = ref 0 in
  with_bridge
    (fun _ ->
       incr calls;
       Eio.Promise.await release;
       Some (Success (Api_response.to_json (committed ()))))
    (fun env _ store bridge connection ->
       let operations =
         List.init 64 ~f:(fun index ->
           let operation =
             prepare
               bridge
               (input ~intention:("flight-" ^ Int.to_string index) connection)
           in
           ignore
             (Rpc_bridge.execute bridge ~id:(Operation.id operation) ~retry:false
              |> Disk.unwrap
              : Operation.t);
           operation)
       in
       until env (fun () -> !calls = 64);
       let overflow = prepare bridge (input ~intention:"overflow" connection) in
       problem (Rpc_bridge.execute bridge ~id:(Operation.id overflow) ~retry:false);
       print_endline (state (observe store (Operation.id overflow)));
       print_endline
         (state
            (Rpc_bridge.execute
               bridge
               ~id:(Operation.id (List.hd_exn operations))
               ~retry:false
             |> Disk.unwrap));
       print_s [%sexp (!calls : int)];
       Eio.Promise.resolve release_resolve ();
       until env (fun () ->
         List.for_all operations ~f:(fun operation ->
           String.equal (state (observe store (Operation.id operation))) "committed"));
       ignore
         (Rpc_bridge.execute bridge ~id:(Operation.id overflow) ~retry:false
          |> Disk.unwrap
          : Operation.t);
       until env (fun () ->
         String.equal (state (observe store (Operation.id overflow))) "committed");
       print_s [%sexp (!calls : int)]);
  [%expect
    {|Blocked
prepared_unsent
sending
64
65|}]
;;

let%expect_test
    "API0.7 older package cannot bypass qualification through direct reads or preparation"
  =
  let version = ref "0.7.0" in
  let calls = ref 0 in
  with_bridge
    ~initialize:(fun () -> Some (initialization ~version:!version ()))
    (fun request ->
       incr calls;
       if String.equal (Protocol.Request.method_ request) "run.list"
       then
         Some
           (Success
              (json
                 {|{"data":{"items":[],"next_offset":null,"omitted":"0"},"meta":{"query_scope":"runs","query_revision":"1","history_capture":{"workspace_id":"demo","head":null,"sequence":"0"}}}|}))
       else Some (Success (Api_response.to_json (committed ()))))
    (fun env _ store bridge connection ->
       let read () =
         Rpc_bridge.read
           bridge
           ~connection
           ~lane:Visible
           (request "run.list" {|{"workspace_id":"demo"}|})
       in
       problem (read ());
       problem (Rpc_bridge.prepare bridge (input ~intention:"blocked" connection));
       print_s [%sexp (!calls : int)];
       problem
         (Operation_store.inspect
            store
            ~id:(Operation.Id.of_string "blocked" |> Disk.unwrap));
       version := Version.value;
       ignore (read () |> Disk.unwrap : Jsonaf.t);
       let operation = prepare bridge (input connection) in
       let id = Operation.id operation in
       version := "0.7.0";
       problem (read ());
       problem (Rpc_bridge.execute bridge ~id ~retry:false);
       print_endline (state (observe store id));
       print_s [%sexp (!calls : int)];
       (* Identical durable input remains locally inspectable while incompatible. *)
       print_endline (state (prepare bridge (input connection)));
       version := Version.value;
       ignore (Rpc_bridge.execute bridge ~id ~retry:false |> Disk.unwrap : Operation.t);
       until env (fun () -> String.equal (state (observe store id)) "committed");
       print_s [%sexp (!calls : int)]);
  [%expect
    {|Unsupported_version
Unsupported_version
0
Not_found
Unsupported_version
Unsupported_version
prepared_unsent
1
prepared_unsent
2|}]
;;

let%expect_test
    "qualification failure preserves unknown exact request across retained profile \
     restart"
  =
  let version = ref Version.value in
  let calls = ref [] in
  with_bridge
    ~initialize:(fun () -> Some (initialization ~version:!version ()))
    (fun request ->
       calls := Json.canonical (Protocol.Request.to_json request) :: !calls;
       if List.length !calls = 1
       then None
       else Some (Success (Api_response.to_json (committed ()))))
    (fun env root store bridge connection ->
       let operation = prepare bridge (input connection) in
       let id = Operation.id operation in
       let original =
         Json.canonical (Protocol.Request.to_json (Operation.request operation))
       in
       ignore (Rpc_bridge.execute bridge ~id ~retry:false |> Disk.unwrap : Operation.t);
       until env (fun () -> String.equal (state (observe store id)) "outcome_unknown");
       version := "0.7.0";
       problem (Rpc_bridge.execute bridge ~id ~retry:true);
       problem (Rpc_bridge.recover bridge ~id);
       print_endline (state (observe store id));
       print_s [%sexp (List.length !calls : int)];
       let recovered =
         Operation_store.create ~root ~random:(Eio.Stdenv.secure_random env)
         |> Disk.unwrap
       in
       Eio.Switch.run (fun sw ->
         let resumed =
           Rpc_bridge.create
             ~sw
             ~net:(Eio.Stdenv.net env)
             ~clock:(Eio.Stdenv.mono_clock env)
             ~random:(Eio.Stdenv.secure_random env)
             ~store:recovered
             ~scheduler:(Read_scheduler.create ())
         in
         problem (Rpc_bridge.execute resumed ~id ~retry:true);
         print_endline (state (observe recovered id));
         print_s
           [%sexp
             (String.equal
                original
                (Json.canonical
                   (Protocol.Request.to_json (Operation.request (observe recovered id))))
              : bool)];
         version := Version.value;
         ignore (Rpc_bridge.execute resumed ~id ~retry:true |> Disk.unwrap : Operation.t);
         until env (fun () -> String.equal (state (observe recovered id)) "committed");
         print_s
           [%sexp
             (( List.length !calls
              , String.equal (List.hd_exn !calls) (List.last_exn !calls) )
              : int * bool)]));
  [%expect
    {|Unsupported_version
Unsupported_version
outcome_unknown
1
Unsupported_version
outcome_unknown
true
(2 true)|}]
;;

let%expect_test "qualification honors a smaller caller deadline and caller cancellation" =
  let sleep = ref (fun () -> ()) in
  with_bridge
    ~initialize:(fun () ->
      !sleep ();
      None)
    (fun _ -> failwith "no semantic request authorized")
    (fun env _ _ _ connection ->
       let clock = Eio.Stdenv.mono_clock env in
       (sleep := fun () -> Eio.Time.Mono.sleep clock 0.2);
       let client =
         Client.create
           ~net:(Eio.Stdenv.net env)
           ~clock
           ~socket:(Connection_profile.socket connection)
           ~timeout_seconds:60.
         |> Disk.unwrap
       in
       let qualification = Daemon_qualification.create ~clock in
       let before = Eio.Time.Mono.now clock in
       problem (Daemon_qualification.check qualification ~timeout_seconds:0.03 client);
       let elapsed =
         Mtime.Span.to_float_ns (Mtime.span before (Eio.Time.Mono.now clock)) /. 1e9
       in
       print_s [%sexp (Float.(elapsed < 0.15) : bool)];
       let canceled =
         Eio.Fiber.first
           (fun () ->
              ignore
                (Daemon_qualification.check qualification client
                 : (unit, Problem.t) Result.t);
              false)
           (fun () ->
              Eio.Time.Mono.sleep clock 0.02;
              true)
       in
       print_s [%sexp (canceled : bool)]);
  [%expect
    {|Storage_unavailable
true
true|}]
;;

let%expect_test "write qualification belongs to service even when browser waiter cancels" =
  let probes = ref 0 in
  let seen, notify = Eio.Promise.create () in
  let release, resume = Eio.Promise.create () in
  let writes = ref 0 in
  with_bridge
    ~initialize:(fun () ->
      incr probes;
      if !probes = 2
      then (
        Eio.Promise.resolve notify ();
        Eio.Promise.await release);
      Some (initialization ()))
    (fun _ ->
       incr writes;
       Some (Success (Api_response.to_json (committed ()))))
    (fun env _ store bridge connection ->
       let operation = prepare bridge (input connection) in
       let id = Operation.id operation in
       let detached =
         Eio.Fiber.first
           (fun () ->
              ignore
                (Rpc_bridge.execute bridge ~id ~retry:false |> Disk.unwrap : Operation.t);
              false)
           (fun () ->
              Eio.Promise.await seen;
              true)
       in
       print_s [%sexp (detached : bool)];
       print_endline (state (observe store id));
       print_s [%sexp (!writes : int)];
       Eio.Promise.resolve resume ();
       until env (fun () -> String.equal (state (observe store id)) "committed");
       print_s [%sexp ((!probes, !writes) : int * int)]);
  [%expect
    {|true
prepared_unsent
0
(2 1)|}]
;;

let%expect_test
    "startup incompatibility sends no semantic listing and spawns no child; default CLI \
     stays policy free"
  =
  let calls = ref 0 in
  with_bridge
    ~initialize:(fun () -> Some (initialization ~version:"0.7.0" ()))
    (fun _ ->
       incr calls;
       let data =
         Api_codec.encode
           Administration_wire.Health.codec
           { registry_requires_restart = false
           ; pending_creates = 0
           ; pending_restores = 0
           ; active_exports = 0
           ; workspaces = []
           }
         |> Disk.unwrap
       in
       Some (Success (Api_response.project Value data |> Api_response.to_json)))
    (fun env root _ _ connection ->
       let fs = Eio.Stdenv.fs env in
       let marker = State_root.path root ^ "/spawn-marker" in
       let executable = State_root.path root ^ "/child" in
       Eio.Path.save
         ~create:(`Exclusive 0o700)
         Eio.Path.(fs / executable)
         ("#!/bin/sh\nprintf 'spawned' > " ^ marker ^ "\nexit 99\n");
       let start ?before_probe () =
         Cli_bootstrap.start_daemon
           ?before_probe
           ~env
           ~executable
           ~socket:(Connection_profile.socket connection)
           ~registry:(State_root.path root ^ "/registry")
           ~log:(State_root.path root ^ "/child.log")
           ~timeout_seconds:0.5
           ()
       in
       let qualification =
         Daemon_qualification.create ~clock:(Eio.Stdenv.mono_clock env)
       in
       problem
         (start
            ~before_probe:(fun client -> Daemon_qualification.check qualification client)
            ());
       let absent =
         match Eio.Path.kind ~follow:false Eio.Path.(fs / marker) with
         | `Not_found -> true
         | `Block_device
         | `Character_special
         | `Directory
         | `Fifo
         | `Regular_file
         | `Socket
         | `Symbolic_link
         | `Unknown -> false
       in
       print_s [%sexp ((!calls, absent) : int * bool)];
       let observed = start () |> Disk.unwrap in
       print_s [%sexp (observed.observation : Cli_bootstrap.Daemon_start.observation)];
       print_s [%sexp (!calls : int)]);
  [%expect
    {|Unsupported_version
(0 true)
Existing
1|}]
;;

let qualification_wait_plan connection =
  Operation.Preparation.create
    ~intention_id:"qualification-wait"
    ~connection
    ~context:(context ~run:(Some "invocation") ())
    ~method_:"reservation.acquire"
    ~params:
      (json
         {|{"workspace_id":"demo","actor_id":"author","run_id":"invocation","target_run_id":"waiter","requests":[{"reservation_id":"compiler","mode":"exclusive"}]}|})
  |> Disk.unwrap
  |> fun preparation ->
  Wait_helper.Plan.create ~preparation ~timeout_ms:1000 ~max_attempts:2 ~wait_slice_ms:5
  |> Disk.unwrap
;;

let qualification_wait_state job =
  Json.field (Wait_helper.Job.to_json job) "state"
  |> fun state -> Json.field state "kind" |> Json.text
;;

let qualification_wait_id = Operation.Id.of_string "qualification-wait" |> Disk.unwrap

let%expect_test "native wait entry qualification preserves unknown exact retry identity" =
  let version = ref "0.7.0" in
  let exchanges = ref 0 in
  with_bridge
    ~initialize:(fun () -> Some (initialization ~version:!version ()))
    (fun request ->
       incr exchanges;
       match Protocol.Request.method_ request with
       | "workspace.get" ->
         Some (Success (json {|{"data":{},"meta":{"workspace_revision":"5"}}|}))
       | "changes.read" | "changes.wait" ->
         Some
           (Success
              (json
                 {|{"data":{"source":"planning","through":"5","items":[],"cursor":"cursor","has_more":false,"needs_larger_budget":false},"meta":{"workspace_revision":"5"}}|}))
       | _ -> None)
    (fun env root _ _ connection ->
       Eio.Switch.run (fun sw ->
         let helper = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
         let inspect () =
           Wait_helper.inspect helper ~id:qualification_wait_id |> Disk.unwrap
         in
         ignore
           (Wait_helper.prepare helper (qualification_wait_plan connection) |> Disk.unwrap
            : Wait_helper.Job.t);
         problem (Wait_helper.start helper ~id:qualification_wait_id);
         print_endline (qualification_wait_state (inspect ()));
         print_s [%sexp (!exchanges : int)];
         version := Version.value;
         ignore
           (Wait_helper.start helper ~id:qualification_wait_id |> Disk.unwrap
            : Wait_helper.Job.t);
         until env (fun () ->
           not (String.equal (qualification_wait_state (inspect ())) "running"));
         print_endline (qualification_wait_state (inspect ()));
         let original = Json.canonical (Wait_helper.Job.to_json (inspect ())) in
         let count = !exchanges in
         version := "0.7.0";
         problem (Wait_helper.retry_exact helper ~id:qualification_wait_id);
         print_s
           [%sexp
             (( !exchanges = count
              , String.equal
                  original
                  (Json.canonical (Wait_helper.Job.to_json (inspect ()))) )
              : bool * bool)];
         let restored = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
         print_endline
           (qualification_wait_state
              (Wait_helper.inspect restored ~id:qualification_wait_id |> Disk.unwrap))));
  [%expect
    {|Unsupported_version
prepared_unsent
0
outcome_unknown
Unsupported_version
(true true)
outcome_unknown|}]
;;

let%expect_test "native wait total deadline includes qualification and semantic read" =
  let sleep = ref (fun (_ : float) -> ()) in
  let writes = ref 0 in
  with_bridge
    ~initialize:(fun () ->
      !sleep 0.55;
      Some (initialization ()))
    (fun request ->
       if String.equal (Protocol.Request.method_ request) "workspace.get"
       then (
         !sleep 0.85;
         None)
       else (
         incr writes;
         None))
    (fun env root _ _ connection ->
       Eio.Switch.run (fun sw ->
         let clock = Eio.Stdenv.mono_clock env in
         sleep := Eio.Time.Mono.sleep clock;
         let helper = Wait_helper.create ~sw ~env ~root |> Disk.unwrap in
         ignore
           (Wait_helper.prepare helper (qualification_wait_plan connection) |> Disk.unwrap
            : Wait_helper.Job.t);
         let before = Eio.Time.Mono.now clock in
         ignore
           (Wait_helper.start helper ~id:qualification_wait_id |> Disk.unwrap
            : Wait_helper.Job.t);
         let inspect () =
           Wait_helper.inspect helper ~id:qualification_wait_id |> Disk.unwrap
         in
         until env (fun () ->
           not (String.equal (qualification_wait_state (inspect ())) "running"));
         let elapsed =
           Mtime.Span.to_float_ns (Mtime.span before (Eio.Time.Mono.now clock)) /. 1e9
         in
         print_s [%sexp ((Float.(elapsed < 1.3), !writes) : bool * int)];
         print_endline (qualification_wait_state (inspect ()));
         let value = Wait_helper.Job.to_json (inspect ()) in
         print_endline
           (Json.field value "state"
            |> fun state ->
            Json.field state "outcome"
            |> fun outcome ->
            Json.field outcome "data"
            |> fun data ->
            Json.field data "wait" |> fun wait -> Json.field wait "stop" |> Json.text)));
  [%expect
    {|(true 0)
stopped
deadline|}]
;;
