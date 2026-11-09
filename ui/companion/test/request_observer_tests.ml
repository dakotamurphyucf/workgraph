open Core
open Workgraph
open Workgraph_ui
open State_tests

let workspace = Id.Workspace.of_string "w" |> Disk.unwrap
let request_id = Communication_id.Request.of_string "question" |> Disk.unwrap

let replace json key value =
  match json with
  | `Object fields -> Json.obj (List.Assoc.add fields ~equal:String.equal key value)
  | _ -> assert false
;;

let fixture () =
  let actor = Id.Actor.of_string "alice" |> Disk.unwrap in
  let state = State.empty ~workspace ~name:"Work" |> Disk.unwrap in
  let state =
    State.prepare
      state
      (Communication
         (Request_ask
            { id = request_id
            ; destination = New_thread { board = None; title = "Question"; ticket = None }
            ; body = "Question body"
            ; recipients = [ Actor actor ]
            ; resolver = actor
            ; kind = Clarification
            ; priority = 0
            ; deadline_unix_ms = None
            ; related = []
            ; supersedes = []
            }))
      ~actor
      ~timestamp:"now"
    |> Disk.unwrap
    |> State.candidate
  in
  State.query
    state
    ~method_:"request.get"
    ~params:(Json.obj [ "request_id", Json.string "question" ])
  |> Disk.unwrap
  |> Api_response.project (Domain_query Communication)
  |> Api_response.to_json
;;

let terminal response kind =
  let data = Json.field response "data" in
  replace
    response
    "data"
    (replace
       data
       "status"
       (Json.obj
          ([ "kind", Json.string kind; "attribution", Json.field data "created" ]
           @ if String.equal kind "resolved" then [ "answer", `Null ] else [])))
;;

let plan ?(timeout_ms = 1000) ?(poll_interval_ms = 250) profile =
  Request_observer.Plan.create
    ~profile
    ~workspace
    ~request:request_id
    ~timeout_ms
    ~poll_interval_ms
  |> Disk.unwrap
;;

let observe env scheduler profile =
  Request_observer.create
    ~net:(Eio.Stdenv.net env)
    ~clock:(Eio.Stdenv.mono_clock env)
    ~scheduler
  |> fun observer -> Request_observer.observe observer (plan profile)
;;

let wait_json observed =
  Request_observer.to_json observed
  |> fun result ->
  Json.field result "observation"
  |> fun result -> Json.field result "meta" |> fun meta -> Json.field meta "wait"
;;

let counts scheduler =
  Json.field (Read_scheduler.to_json scheduler) "lanes"
  |> Json.list
  |> List.find_exn ~f:(fun lane ->
    String.equal (Json.field lane "lane" |> Json.text) "wait")
  |> fun lane ->
  Json.field lane "active" |> Json.integer, Json.field lane "queued" |> Json.integer
;;

let%expect_test
    "qualified foreground observation preserves nullable terminal answers and exact \
     capture"
  =
  let calls = ref [] in
  List.iter [ "resolved"; "cancelled" ] ~f:(fun kind ->
    Rpc_socket_test.with_bridge
      (fun request ->
         calls := Protocol.Request.method_ request :: !calls;
         let params = Protocol.Request.params request in
         assert (String.equal (Json.field params "workspace_id" |> Json.text) "w");
         assert (String.equal (Json.field params "request_id" |> Json.text) "question");
         assert (Option.is_none (Json.optional params "include_related_messages"));
         assert (Json.field params "max_bytes" |> Json.integer = 1024 * 1024);
         Some (Protocol.Success (terminal (fixture ()) kind)))
      (fun env _ _ _ profile ->
         let scheduler = Read_scheduler.create () in
         let observed = observe env scheduler profile |> Disk.unwrap in
         print_endline (Json.canonical (wait_json observed));
         let capture =
           Request_observer.to_json observed |> fun value -> Json.field value "capture"
         in
         assert (
           String.equal
             (Json.field (Json.field capture "profile") "socket" |> Json.text)
             (Connection_profile.socket profile));
         print_s [%sexp (counts scheduler : int * int)]));
  print_s [%sexp (List.rev !calls : string list)];
  [%expect
    {|{"poll_count":"1","resolved":true,"stop":"resolved"}
(0 0)
{"poll_count":"1","resolved":false,"stop":"cancelled"}
(0 0)
(request.get request.get)|}]
;;

let%expect_test
    "incompatible qualification has no semantic read; errors retain their native kind"
  =
  let calls = ref 0 in
  Rpc_socket_test.with_bridge
    ~initialize:(fun () -> Some (Rpc_socket_test.initialization ~version:"0.7.0" ()))
    (fun _ ->
       incr calls;
       failwith "incompatible endpoint received semantic I/O")
    (fun env _ _ _ profile ->
       problem (observe env (Read_scheduler.create ()) profile);
       print_s [%sexp (!calls : int)]);
  Rpc_socket_test.with_bridge
    (fun _ -> Some (Protocol.Failure (Problem.create Not_found "missing request")))
    (fun env _ _ _ profile -> problem (observe env (Read_scheduler.create ()) profile));
  [%expect
    {|Unsupported_version
0
Not_found|}]
;;

let%expect_test
    "deadline retains last native complete observation and Wait admission is released \
     during sleep"
  =
  let calls = ref 0 in
  Rpc_socket_test.with_bridge
    (fun _ ->
       incr calls;
       Some (Protocol.Success (fixture ())))
    (fun env _ _ _ profile ->
       let scheduler = Read_scheduler.create () in
       let observer =
         Request_observer.create
           ~net:(Eio.Stdenv.net env)
           ~clock:(Eio.Stdenv.mono_clock env)
           ~scheduler
       in
       let observed =
         Request_observer.observe observer (plan ~poll_interval_ms:25000 profile)
         |> Disk.unwrap
       in
       print_endline (Json.canonical (wait_json observed));
       print_s [%sexp (!calls : int), (counts scheduler : int * int)]);
  [%expect
    {|{"poll_count":"1","resolved":false,"stop":"deadline"}
(1 (0 0))|}]
;;

(* Test-only Eio clock: real cancellation/sockets with accelerated monotonic time.
   Production has no timeout override. All scheduled deadlines remain bounded. *)
let accelerated real ~rate =
  let origin = Eio.Time.Mono.now real in
  let scheduled = ref [] in
  let now () =
    let elapsed = Mtime.span origin (Eio.Time.Mono.now real) |> Mtime.Span.to_float_ns in
    let span = Mtime.Span.of_float_ns (elapsed *. rate) |> Option.value_exn in
    Mtime.add_span origin span |> Option.value_exn
  in
  let module Clock = struct
    type t = unit
    type time = Mtime.t

    let now () = now ()

    let sleep_until () target =
      let current = now () in
      if Mtime.is_later target ~than:current
      then (
        let seconds =
          Mtime.span current target |> Mtime.Span.to_float_ns |> fun ns -> ns /. 1e9
        in
        scheduled := seconds :: !scheduled;
        Eio.Time.Mono.sleep real (seconds /. rate))
    ;;
  end
  in
  Eio.Resource.T ((), Eio.Time.Pi.clock (module Clock)), scheduled
;;

let with_http ?(rate = 1.) handler f =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      Eio.Time.Timeout.run_exn
        (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock env) 20.)
        (fun () ->
           let clock, scheduled = accelerated (Eio.Stdenv.mono_clock env) ~rate in
           let listener =
             Eio.Net.listen
               ~sw
               ~backlog:64
               ~reuse_addr:false
               (Eio.Stdenv.net env)
               (`Tcp (Eio.Net.Ipaddr.V4.loopback, 0))
           in
           let port =
             match Eio.Net.listening_addr listener with
             | `Tcp (_, port) -> port
             | `Unix _ -> assert false
           in
           let host = "127.0.0.1:" ^ Int.to_string port in
           let router, profiles, _, scheduler = Http_tests.router env root ~sw ~host in
           let socket, daemon_stop = Http_socket_test.fake_daemon root ~sw handler in
           let profile =
             Connection_profile.create
               ~id:(Connection_profile.Id.of_string "wait" |> Disk.unwrap)
               ~generation:Connection_profile.Generation.initial
               ~label:"Wait"
               ~socket
             |> Disk.unwrap
           in
           Connection_profile.Store.put profiles profile ~expected_generation:None
           |> Disk.unwrap;
           let observer =
             Request_observer.create ~net:(Eio.Stdenv.net env) ~clock ~scheduler
           in
           let router = Http_router.with_request_observer router observer in
           let cancel, cancel_resolve = Eio.Promise.create () in
           let stopped, stopped_resolve = Eio.Promise.create () in
           Eio.Fiber.fork ~sw (fun () ->
             (try
                Eio.Cancel.sub (fun context ->
                  Eio.Promise.resolve cancel_resolve context;
                  Http_server.serve ~sw ~clock ~listener ~router)
              with
              | Eio.Cancel.Cancelled _ -> ());
             Eio.Promise.resolve stopped_resolve ());
           let cancel = Eio.Promise.await cancel in
           Exn.protect
             ~finally:(fun () ->
               Eio.Cancel.cancel cancel Exit;
               Eio.Promise.await stopped;
               Eio.Promise.resolve daemon_stop ())
             ~f:(fun () -> f env sw host port scheduler scheduled))))
;;

let body ?(timeout = "300000") ?(poll = "25000") () =
  Json.obj
    [ "connection_id", Json.string "wait"
    ; "generation", Json.string "1"
    ; "workspace_id", Json.string "w"
    ; "request_id", Json.string "question"
    ; "timeout_ms", Json.string timeout
    ; "poll_interval_ms", Json.string poll
    ]
  |> Json.canonical
;;

let%expect_test
    "authorized exact wait survives former90s HTTP cutoff with bounded native total and \
     staged transport"
  =
  let calls = ref 0 in
  with_http
    ~rate:20.
    (fun _ ->
       incr calls;
       Protocol.Success
         (if !calls >= 5 then terminal (fixture ()) "resolved" else fixture ()))
    (fun env _ host port scheduler scheduled ->
       let response =
         Http_socket_test.exchange
           env
           port
           (Http_socket_test.post host "/ui-api/v1/request-waits" (body ()))
       in
       assert (String.is_prefix response ~prefix:"HTTP/1.1 200");
       assert (String.is_substring response ~substring:{|"stop":"resolved"|});
       assert (
         List.exists !scheduled ~f:(fun seconds ->
           Float.(seconds > 419. && seconds <= 420.)));
       assert (
         List.exists !scheduled ~f:(fun seconds ->
           Float.(seconds > 309. && seconds <= 310.)));
       print_s [%sexp (!calls : int), (counts scheduler : int * int)]);
  [%expect {|(5 (0 0))|}]
;;

let%expect_test
    "EOF cancels queued active and sleeping foreground waits without semantic side \
     effects"
  =
  List.iter [ "queued"; "active"; "sleep" ] ~f:(fun mode ->
    let calls = ref 0 in
    let block, release = Eio.Promise.create () in
    with_http
      (fun _ ->
         incr calls;
         if String.equal mode "active" then Eio.Promise.await block;
         Protocol.Success (fixture ()))
      (fun env sw host port scheduler _ ->
         if String.equal mode "queued"
         then (
           for _ = 1 to 2 do
             Eio.Fiber.fork ~sw (fun () ->
               Read_scheduler.run scheduler ~lane:Wait ~f:(fun () ->
                 Eio.Promise.await block;
                 Ok ())
               |> Disk.unwrap)
           done;
           Rpc_socket_test.until env (fun () -> fst (counts scheduler) = 2));
         let flow = Http_socket_test.connect env ~sw port in
         Eio.Flow.copy_string
           (Http_socket_test.post host "/ui-api/v1/request-waits" (body ()))
           flow;
         Rpc_socket_test.until env (fun () ->
           if String.equal mode "queued"
           then snd (counts scheduler) = 1
           else if String.equal mode "active"
           then !calls = 1 && fst (counts scheduler) = 1
           else !calls = 1 && fst (counts scheduler) = 0);
         Eio.Flow.shutdown flow `Send;
         let closed =
           Eio.Time.Timeout.run_exn
             (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock env) 1.)
             (fun () -> Http_socket_test.response flow)
         in
         assert (String.is_empty closed);
         Rpc_socket_test.until env (fun () -> snd (counts scheduler) = 0);
         Eio.Promise.resolve release ();
         Rpc_socket_test.until env (fun () -> fst (counts scheduler) = 0);
         print_s [%sexp (mode : string), (!calls : int), (counts scheduler : int * int)]));
  [%expect
    {|(queued 0 (0 0))
(active 1 (0 0))
(sleep 1 (0 0))|}]
;;

let%expect_test
    "invalid public budgets reject before I/O and clipped terminal data remains \
     incomplete"
  =
  let response = terminal (fixture ()) "resolved" in
  let meta = Json.field response "meta" in
  let budget = Json.field meta "budget" in
  let budget =
    replace budget "truncated" `True
    |> fun budget ->
    replace budget "omitted_fields" (Json.int 1)
    |> fun budget -> replace budget "details_complete" `False
  in
  let clipped = replace response "meta" (replace meta "budget" budget) in
  let calls = ref 0 in
  Rpc_socket_test.with_bridge
    (fun _ ->
       incr calls;
       Some (Protocol.Success clipped))
    (fun env _ _ _ profile ->
       List.iter
         [ 999, 250; 300001, 250; 1000, 249; 1000, 25001 ]
         ~f:(fun (timeout_ms, poll_interval_ms) ->
           problem
             (Request_observer.Plan.create
                ~profile
                ~workspace
                ~request:request_id
                ~timeout_ms
                ~poll_interval_ms));
       print_s [%sexp (!calls : int)];
       observe env (Read_scheduler.create ()) profile
       |> Disk.unwrap
       |> wait_json
       |> Json.canonical
       |> print_endline);
  [%expect
    {|Invalid_argument
Invalid_argument
Invalid_argument
Invalid_argument
0
{"poll_count":"1","resolved":false,"stop":"incomplete"}|}]
;;

let%expect_test
    "HTTP wait route is closed and malformed bodies cannot initiate native reads"
  =
  let calls = ref 0 in
  with_http
    (fun _ ->
       incr calls;
       Protocol.Success (fixture ()))
    (fun env _ host port scheduler scheduled ->
       List.iter
         [ "/ui-api/v1/request-waits", "{}"
         ; "/ui-api/v1/request-waits", body ~timeout:"999" ()
         ; "/ui-api/v1/request-waits", body ~poll:"25001" ()
         ; "/ui-api/v1/request-waits?extra=1", body ()
         ; "/ui-api/v1/%72equest-waits", body ()
         ]
         ~f:(fun (target, body) ->
           let response =
             Http_socket_test.exchange env port (Http_socket_test.post host target body)
           in
           assert (not (String.is_prefix response ~prefix:"HTTP/1.1 200")));
       print_s [%sexp (!calls : int), (counts scheduler : int * int)];
       assert (List.for_all !scheduled ~f:(fun seconds -> Float.(seconds <= 420.))));
  [%expect {|(0 (0 0))|}]
;;

let%expect_test
    "maximum300s foreground deadline returns the last complete read within staged HTTP \
     lifetime"
  =
  let calls = ref 0 in
  with_http
    ~rate:20.
    (fun _ ->
       incr calls;
       Protocol.Success (fixture ()))
    (fun env _ host port scheduler _ ->
       let response =
         Http_socket_test.exchange
           env
           port
           (Http_socket_test.post host "/ui-api/v1/request-waits" (body ()))
       in
       assert (String.is_prefix response ~prefix:"HTTP/1.1 200");
       assert (String.is_substring response ~substring:{|"stop":"deadline"|});
       assert (String.is_substring response ~substring:{|"poll_count":"12"|});
       print_s [%sexp (!calls : int), (counts scheduler : int * int)]);
  [%expect {|(12 (0 0))|}]
;;
