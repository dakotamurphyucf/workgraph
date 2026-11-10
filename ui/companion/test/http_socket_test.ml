open Core
open Workgraph
open Workgraph_ui
open State_tests
open Http_tests

let with_http f =
  with_root (fun env root ->
    Eio.Switch.run (fun sw ->
      Eio.Time.Timeout.run_exn
        (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock env) 20.)
        (fun () ->
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
           let router, profiles, operations, scheduler = router env root ~sw ~host in
           let router =
             Http_router.with_live_observer
               router
               (Live_observer.create
                  ~net:(Eio.Stdenv.net env)
                  ~clock:(Eio.Stdenv.mono_clock env))
           in
           let cancel, cancel_resolve = Eio.Promise.create () in
           let stopped, stopped_resolve = Eio.Promise.create () in
           Eio.Fiber.fork ~sw (fun () ->
             (try
                Eio.Cancel.sub (fun context ->
                  Eio.Promise.resolve cancel_resolve context;
                  Http_server.serve
                    ~sw
                    ~clock:(Eio.Stdenv.mono_clock env)
                    ~listener
                    ~router)
              with
              | Eio.Cancel.Cancelled _ -> ());
             Eio.Promise.resolve stopped_resolve ());
           let cancel = Eio.Promise.await cancel in
           Exn.protect
             ~finally:(fun () ->
               Eio.Cancel.cancel cancel Exit;
               Eio.Promise.await stopped)
             ~f:(fun () -> f env root sw host port profiles operations scheduler))))
;;

let connect env ~sw port =
  Eio.Net.connect ~sw (Eio.Stdenv.net env) (`Tcp (Eio.Net.Ipaddr.V4.loopback, port))
;;

let response flow =
  Eio.Buf_read.of_flow ~max_size:(17 * 1024 * 1024) flow |> Eio.Buf_read.take_all
;;

let exchange env port bytes =
  Eio.Switch.run (fun sw ->
    let flow = connect env ~sw port in
    Eio.Flow.copy_string bytes flow;
    response flow)
;;

let connection_header keep_alive = if keep_alive then "" else "Connection: close\r\n"

let get ?(keep_alive = false) host target =
  "GET "
  ^ target
  ^ " HTTP/1.1\r\nHost: "
  ^ host
  ^ "\r\nX-Workgraph-UI-Capability: "
  ^ capability
  ^ "\r\n"
  ^ connection_header keep_alive
  ^ "\r\n"
;;

let post ?(keep_alive = false) host target body =
  "POST "
  ^ target
  ^ " HTTP/1.1\r\nHost: "
  ^ host
  ^ "\r\nOrigin: http://"
  ^ host
  ^ "\r\nX-Workgraph-UI-Capability: "
  ^ capability
  ^ "\r\nContent-Type: application/json\r\nContent-Length: "
  ^ Int.to_string (String.length body)
  ^ "\r\n"
  ^ connection_header keep_alive
  ^ "\r\n"
  ^ body
;;

(* Independent fixed-length response reader: retaining the buffered reader across
   requests detects missing framing or response bytes leaking into the next reply. *)
let framed_response input =
  let status = Eio.Buf_read.line input in
  let rec headers acc =
    match Eio.Buf_read.line input with
    | "" -> List.rev acc
    | line ->
      let name, value = String.lsplit2_exn line ~on:':' in
      headers ((String.lowercase name, String.strip value) :: acc)
  in
  let headers = headers [] in
  assert (not (List.Assoc.mem headers ~equal:String.equal "transfer-encoding"));
  let length = List.Assoc.find_exn headers ~equal:String.equal "content-length" in
  status, headers, Eio.Buf_read.take (Int.of_string length) input
;;

let prime_connection flow host =
  Eio.Flow.copy_string (get ~keep_alive:true host "/ui-api/v1/connections") flow;
  let input = Eio.Buf_read.of_flow ~max_size:(17 * 1024 * 1024) flow in
  let status, _, _ = framed_response input in
  assert (String.is_prefix status ~prefix:"HTTP/1.1 200");
  assert (Eio.Buf_read.buffered_bytes input = 0)
;;

let%expect_test "assets and API reads and writes reuse one HTTP/1.1 socket" =
  with_http (fun env _ sw host port profiles _ _ ->
    let flow = connect env ~sw port in
    let input = Eio.Buf_read.of_flow ~max_size:(17 * 1024 * 1024) flow in
    let round_trip bytes =
      Eio.Flow.copy_string bytes flow;
      let status, headers, body = framed_response input in
      assert (String.is_prefix status ~prefix:"HTTP/1.1 200");
      assert (
        String.equal
          (List.Assoc.find_exn headers ~equal:String.equal "connection")
          "keep-alive");
      body
    in
    let index = round_trip (get ~keep_alive:true host "/") in
    print_s [%sexp (String.is_substring index ~substring:"<!doctype html>" : bool)];
    for index = 1 to 24 do
      let body =
        Json.canonical
          (Json.obj
             [ "id", Json.string ("profile-" ^ Int.to_string index)
             ; "label", Json.string "Kept alive λ"
             ; "socket", Json.string "/tmp/keepalive-test.sock"
             ])
      in
      ignore
        (round_trip (post ~keep_alive:true host "/ui-api/v1/connections" body) : string);
      let listed =
        round_trip (get ~keep_alive:true host "/ui-api/v1/connections")
        |> Json.parse
        |> Disk.unwrap
      in
      assert (
        List.length (Json.field (Json.field listed "data") "items" |> Json.list) = index)
    done;
    print_s [%sexp (List.length (Connection_profile.Store.list profiles) : int)];
    Eio.Flow.copy_string (get host "/ui-api/v1/connections") flow;
    let status, headers, _ = framed_response input in
    print_s
      [%sexp
        ((status, List.Assoc.find_exn headers ~equal:String.equal "connection")
         : string * string)];
    print_s [%sexp (String.is_empty (Eio.Buf_read.take_all input) : bool)]);
  [%expect
    {|true
24
("HTTP/1.1 200 OK" close)
true|}]
;;

let%expect_test "header accounting resets and authorization is checked on reused sockets" =
  with_http (fun env _ sw host port profiles _ _ ->
    let flow = connect env ~sw port in
    let input = Eio.Buf_read.of_flow ~max_size:(17 * 1024 * 1024) flow in
    (* Together these exceed the header budget; separately both are valid. *)
    for _ = 1 to 2 do
      Eio.Flow.copy_string
        ("GET / HTTP/1.1\r\nHost: "
         ^ host
         ^ "\r\nX-Padding: "
         ^ String.make (20 * 1024) 'x'
         ^ "\r\n\r\n")
        flow;
      let status, _, _ = framed_response input in
      print_s [%sexp (String.is_prefix status ~prefix:"HTTP/1.1 200" : bool)]
    done;
    (* A prior authorized request never supplies authority for the next one. *)
    Eio.Flow.copy_string
      ("POST /ui-api/v1/connections HTTP/1.1\r\nHost: "
       ^ host
       ^ "\r\nContent-Length: 2\r\n\r\n{}")
      flow;
    let status, headers, _ = framed_response input in
    print_s
      [%sexp
        (( String.is_prefix status ~prefix:"HTTP/1.1 403"
         , List.Assoc.find_exn headers ~equal:String.equal "connection"
         , List.length (Connection_profile.Store.list profiles) )
         : bool * string * int)];
    print_s [%sexp (String.is_empty (Eio.Buf_read.take_all input) : bool)]);
  [%expect
    {|true
true
(true close 0)
true|}]
;;

let%expect_test "oversized second headers and HTTP/1.0 do not keep a socket alive" =
  with_http (fun env _ sw host port _ _ _ ->
    let flow = connect env ~sw port in
    let input = Eio.Buf_read.of_flow ~max_size:(17 * 1024 * 1024) flow in
    Eio.Flow.copy_string (get ~keep_alive:true host "/") flow;
    ignore (framed_response input : string * (string * string) list * string);
    Eio.Flow.copy_string
      ("GET / HTTP/1.1\r\nHost: "
       ^ host
       ^ "\r\nX-Large: "
       ^ String.make (33 * 1024) 'x'
       ^ "\r\n\r\n")
      flow;
    print_s
      [%sexp
        ((try String.is_empty (Eio.Buf_read.take_all input) with
          | Eio.Io _ -> true)
         : bool)];
    let legacy =
      exchange
        env
        port
        ("GET / HTTP/1.0\r\nHost: " ^ host ^ "\r\nConnection: keep-alive\r\n\r\n")
    in
    print_s
      [%sexp
        (( String.is_prefix legacy ~prefix:"HTTP/1.1 200"
         , String.is_substring legacy ~substring:"connection: close" )
         : bool * bool)]);
  [%expect
    {|true
(true true)|}]
;;

let%expect_test
    "real TCP Cohttp boundary, chunked rejection and invalid host remain structured and \
     bounded"
  =
  with_http (fun env _ _ host port _ _ _ ->
    let first = exchange env port (get host "/ui-api/v1/connections") in
    print_s
      [%sexp
        (( String.is_prefix first ~prefix:"HTTP/1.1 200"
         , String.is_substring first ~substring:{|{"data":{"items":[]},"ok":true}|} )
         : bool * bool)];
    let forbidden = exchange env port (get "evil.example" "/ui-api/v1/connections") in
    print_s
      [%sexp
        (( String.is_prefix forbidden ~prefix:"HTTP/1.1 403"
         , String.is_substring forbidden ~substring:"\"ok\":false" )
         : bool * bool)];
    let body = {|{"id":"local","label":"Local","socket":"/tmp/http-no-daemon.sock"}|} in
    let bytes =
      "POST /ui-api/v1/connections HTTP/1.1\r\nHost: "
      ^ host
      ^ "\r\nOrigin: http://"
      ^ host
      ^ "\r\nX-Workgraph-UI-Capability: "
      ^ capability
      ^ "\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n"
      ^ Printf.sprintf "%x" (String.length body)
      ^ "\r\n"
      ^ body
      ^ "\r\n0\r\n\r\n"
    in
    let rejected = exchange env port bytes in
    print_s
      [%sexp
        (( String.is_prefix rejected ~prefix:"HTTP/1.1 403"
         , String.is_substring rejected ~substring:"\"ok\":false" )
         : bool * bool)]);
  [%expect
    {|(true true)
(true true)
(true true)|}]
;;

let%expect_test
    "aggregate oversize headers never dispatch; service remains usable after malformed \
     transport"
  =
  with_http (fun env _ _ host port _ _ _ ->
    let oversized =
      "GET / HTTP/1.1\r\nHost: "
      ^ host
      ^ "\r\nX-Large: "
      ^ String.make (33 * 1024) 'x'
      ^ "\r\n\r\n"
    in
    let closed =
      try String.is_empty (exchange env port oversized) with
      | Eio.Io _ -> true
    in
    print_s [%sexp (closed : bool)];
    print_s
      [%sexp
        (String.is_prefix
           (exchange env port (get host "/ui-api/v1/connections"))
           ~prefix:"HTTP/1.1 200"
         : bool)]);
  [%expect
    {|true
true|}]
;;

let search_counts scheduler =
  let lane =
    Json.field (Read_scheduler.to_json scheduler) "lanes"
    |> Json.list
    |> List.find_exn ~f:(fun value ->
      String.equal (Json.field value "lane" |> Json.text) "search")
  in
  Json.field lane "active" |> Json.integer, Json.field lane "queued" |> Json.integer
;;

let fake_daemon root ~sw handler =
  let socket = State_root.path root ^ "/s" in
  let listener =
    Platform.listen_unix ~sw ~path:socket ~backlog:32 ~on_cleanup_error:failwith
  in
  let stop, resolve = Eio.Promise.create () in
  Eio.Fiber.fork ~sw (fun () ->
    Eio.Net.run_server
      ~stop
      ~on_error:(function
        | Eio.Io _ -> ()
        | exn -> raise exn)
      listener
      (fun flow _ ->
         let request = Framing.read flow |> Protocol.Request.of_json |> Disk.unwrap in
         let response =
           if String.equal (Protocol.Request.method_ request) "initialize"
           then Rpc_socket_test.initialization ()
           else handler request
         in
         Framing.write flow (Protocol.response_json request response)));
  socket, resolve
;;

let%expect_test
    "browser close cancels a queued read and releases its lane while a fully open read \
     succeeds"
  =
  with_http (fun env root sw host port profiles _ scheduler ->
    let release, resolve = Eio.Promise.create () in
    let calls = ref 0 in
    let socket, stop =
      fake_daemon root ~sw (fun _ ->
        incr calls;
        Eio.Promise.await release;
        Success (json {|{"data":{"status":"absent"},"meta":{}}|}))
    in
    Exn.protect
      ~finally:(fun () -> Eio.Promise.resolve stop ())
      ~f:(fun () ->
        Connection_profile.Store.put
          profiles
          (profile ~socket ())
          ~expected_generation:None
        |> Disk.unwrap;
        let body =
          {|{"connection_id":"local","generation":"1","method":"workspace.receipt","params":{"workspace_id":"demo","actor_id":"author","mutation_id":"saved"},"lane":"search"}|}
        in
        let active = connect env ~sw port in
        prime_connection active host;
        Eio.Flow.copy_string (post host "/ui-api/v1/read" body) active;
        Rpc_socket_test.until env (fun () -> !calls = 1);
        let queued = connect env ~sw port in
        prime_connection queued host;
        Eio.Flow.copy_string (post host "/ui-api/v1/read" body) queued;
        Rpc_socket_test.until env (fun () ->
          let _, queued = search_counts scheduler in
          queued = 1);
        print_s [%sexp (search_counts scheduler : int * int)];
        Eio.Flow.shutdown queued `All;
        Rpc_socket_test.until env (fun () ->
          let _, queued = search_counts scheduler in
          queued = 0);
        print_s [%sexp ((search_counts scheduler, !calls) : (int * int) * int)];
        Eio.Promise.resolve resolve ();
        print_s [%sexp (String.is_prefix (response active) ~prefix:"HTTP/1.1 200" : bool)];
        print_s [%sexp (search_counts scheduler : int * int)]));
  [%expect
    {|(1 1)
((1 0) 1)
true
(0 0)|}]
;;

let http_data bytes =
  let offset = String.substr_index_exn bytes ~pattern:"\r\n\r\n" + 4 in
  String.drop_prefix bytes offset
  |> Json.parse
  |> Disk.unwrap
  |> fun value -> Json.field value "data"
;;

let%expect_test
    "admitted native write survives browser disconnect and a second execute never resends"
  =
  with_http (fun env root sw host port profiles operations _ ->
    let release, resolve = Eio.Promise.create () in
    let calls = ref 0 in
    let socket, stop =
      fake_daemon root ~sw (fun _ ->
        incr calls;
        Eio.Promise.await release;
        Success (Api_response.to_json (Rpc_tests.committed ())))
    in
    Exn.protect
      ~finally:(fun () -> Eio.Promise.resolve stop ())
      ~f:(fun () ->
        Connection_profile.Store.put
          profiles
          (profile ~socket ())
          ~expected_generation:None
        |> Disk.unwrap;
        let body =
          {|{"intention_id":"intent","connection_id":"local","generation":"1","context":{"workspace_id":"demo","project_id":null,"writer":{"actor_id":"author","run_id":null}},"method":"ticket.metadata","params":{"workspace_id":"demo","actor_id":"author","ticket_id":"task","expected_revision":"1"}}|}
        in
        let prepared =
          exchange env port (post host "/ui-api/v1/operations/prepare" body) |> http_data
        in
        let id = Json.field prepared "operation_id" |> Json.text in
        let operation_id = Operation.Id.of_string id |> Disk.unwrap in
        let flow = connect env ~sw port in
        prime_connection flow host;
        Eio.Flow.copy_string
          (post host ("/ui-api/v1/operations/" ^ id ^ "/execute") "{}")
          flow;
        Rpc_socket_test.until env (fun () -> !calls = 1);
        Eio.Flow.shutdown flow `All;
        Eio.Promise.resolve resolve ();
        Rpc_socket_test.until env (fun () ->
          String.equal
            (state (Operation_store.inspect operations ~id:operation_id |> Disk.unwrap))
            "committed");
        let observed =
          exchange env port (post host ("/ui-api/v1/operations/" ^ id ^ "/execute") "{}")
          |> http_data
        in
        print_endline (Json.field (Json.field observed "state") "kind" |> Json.text);
        print_s [%sexp (!calls : int)]));
  [%expect
    {|committed
1|}]
;;

let%expect_test "pipelined second request is never dispatched" =
  with_http (fun env _ _ host port profiles _ _ ->
    let bytes =
      get host "/ui-api/v1/connections"
      ^ post
          host
          "/ui-api/v1/connections"
          {|{"id":"unexpected","label":"Unexpected","socket":"/tmp/unexpected.sock"}|}
    in
    let reply = exchange env port bytes in
    print_s
      [%sexp
        (( List.length
             (String.substr_index_all reply ~pattern:"HTTP/1.1" ~may_overlap:false)
           <= 1
         , List.length (Connection_profile.Store.list profiles) )
         : bool * int)]);
  [%expect {|(true 0)|}]
;;

let%expect_test
    "fixed body framing rejects missing duplicate oversized incomplete and extra lengths \
     before effects"
  =
  with_http (fun env _ sw host port profiles _ _ ->
    let body = {|{"id":"local","label":"Local","socket":"/tmp/http-framing.sock"}|} in
    let headers length =
      "POST /ui-api/v1/connections HTTP/1.1\r\nHost: "
      ^ host
      ^ "\r\nOrigin: http://"
      ^ host
      ^ "\r\nX-Workgraph-UI-Capability: "
      ^ capability
      ^ "\r\nContent-Type: application/json\r\n"
      ^ length
      ^ "\r\n"
    in
    let rejected bytes code =
      let flow = connect env ~sw port in
      prime_connection flow host;
      Eio.Flow.copy_string bytes flow;
      print_s
        [%sexp (String.is_prefix (response flow) ~prefix:("HTTP/1.1 " ^ code) : bool)]
    in
    rejected (headers "" ^ body) "403";
    rejected (headers "Content-Length: 2\r\nContent-Length: 2\r\n" ^ body) "403";
    rejected (headers "Content-Length: 4194305\r\n") "413";
    let incomplete = connect env ~sw port in
    prime_connection incomplete host;
    Eio.Flow.copy_string
      (headers ("Content-Length: " ^ Int.to_string (String.length body + 1) ^ "\r\n")
       ^ body)
      incomplete;
    Eio.Flow.shutdown incomplete `Send;
    print_s [%sexp (String.is_prefix (response incomplete) ~prefix:"HTTP/1.1 400" : bool)];
    rejected
      (headers ("Content-Length: " ^ Int.to_string (String.length body) ^ "\r\n")
       ^ body
       ^ "extra")
      "400";
    print_s [%sexp (List.length (Connection_profile.Store.list profiles) : int)]);
  [%expect
    {|true
true
true
true
true
0|}]
;;

let%expect_test "server cancellation finishes a live response and reuses its HTTP socket" =
  with_http (fun env root sw host port _ _ _ ->
    let socket = State_root.path root ^ "/s" in
    let listener =
      Platform.listen_unix ~sw ~path:socket ~backlog:16 ~on_cleanup_error:failwith
    in
    let stop, stop_resolve = Eio.Promise.create () in
    let waiting = ref false in
    let release = Eio.Condition.create () in
    let released = ref false in
    Eio.Fiber.fork ~sw (fun () ->
      Eio.Net.run_server ~stop ~on_error:raise listener (fun flow _ ->
        let request = Framing.read flow |> Protocol.Request.of_json |> Disk.unwrap in
        let method_ = Protocol.Request.method_ request in
        if String.equal method_ "changes.wait"
        then (
          waiting := true;
          Eio.Condition.loop_no_mutex release (fun () ->
            if !released then Some () else None))
        else (
          let reply =
            if String.equal method_ "initialize"
            then Rpc_socket_test.initialization ()
            else
              Protocol.Success
                (Api_response.project
                   Value
                   (Json.obj
                      [ "source", Json.string "planning"
                      ; "through", Json.int 0
                      ; "items", `Array []
                      ; "cursor", Json.string "cursor"
                      ; "has_more", `False
                      ; "needs_larger_budget", `False
                      ])
                 |> Api_response.to_json)
          in
          Framing.write flow (Protocol.response_json request reply))));
    Exn.protect
      ~finally:(fun () ->
        released := true;
        Eio.Condition.broadcast release;
        Eio.Promise.resolve stop_resolve ())
      ~f:(fun () ->
        let flow = connect env ~sw port in
        let input = Eio.Buf_read.of_flow ~max_size:(17 * 1024 * 1024) flow in
        Eio.Flow.copy_string
          (post
             ~keep_alive:true
             host
             "/ui-api/v1/connections"
             (Json.canonical
                (Json.obj
                   [ "id", Json.string "live"
                   ; "label", Json.string "Live"
                   ; "socket", Json.string socket
                   ])))
          flow;
        ignore (framed_response input : string * (string * string) list * string);
        let identity = Json.string (String.make 32 'a') in
        let base = [ "connection_id", Json.string "live"; "generation", Json.int 1 ] in
        let scope = [ "workspace_id", Json.string "w"; "observation_id", identity ] in
        let plan =
          Json.obj
            (scope
             @ [ "planning_cursor", Json.string "cursor"
               ; "history", `False
               ; "history_cursor", `Null
               ; "runtime", `False
               ; "runtime_signature", `Null
               ; "wait", `True
               ])
        in
        Eio.Flow.copy_string
          (post
             ~keep_alive:true
             host
             "/ui-api/v1/live-observations"
             (Json.canonical (Json.obj (base @ [ "observation", plan ]))))
          flow;
        Rpc_socket_test.until env (fun () -> !waiting);
        ignore
          (exchange
             env
             port
             (post
                host
                "/ui-api/v1/live-observations/cancel"
                (Json.canonical (Json.obj (base @ [ "cancellation", Json.obj scope ]))))
           : string);
        let status, headers, body = framed_response input in
        print_endline status;
        print_endline (List.Assoc.find_exn headers ~equal:String.equal "connection");
        let value = Json.parse body |> Disk.unwrap in
        print_endline (Json.canonical (Json.field value "data"));
        Eio.Flow.copy_string (get host "/ui-api/v1/connections") flow;
        let status, _, body = framed_response input in
        print_endline status;
        let value = Json.parse body |> Disk.unwrap in
        print_s
          [%sexp
            (List.length (Json.list (Json.field (Json.field value "data") "items")) : int)]));
  [%expect
    {|HTTP/1.1 200 OK
keep-alive
{"cancelled":true}
HTTP/1.1 200 OK
1|}]
;;
