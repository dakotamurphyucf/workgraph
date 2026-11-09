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

let get host target =
  "GET "
  ^ target
  ^ " HTTP/1.1\r\nHost: "
  ^ host
  ^ "\r\nX-Workgraph-UI-Capability: "
  ^ capability
  ^ "\r\n\r\n"
;;

let post host target body =
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
  ^ "\r\n\r\n"
  ^ body
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
        Eio.Flow.copy_string (post host "/ui-api/v1/read" body) active;
        Rpc_socket_test.until env (fun () -> !calls = 1);
        let queued = connect env ~sw port in
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
      print_s
        [%sexp
          (String.is_prefix (exchange env port bytes) ~prefix:("HTTP/1.1 " ^ code) : bool)]
    in
    rejected (headers "" ^ body) "403";
    rejected (headers "Content-Length: 2\r\nContent-Length: 2\r\n" ^ body) "403";
    rejected (headers "Content-Length: 4194305\r\n") "413";
    let incomplete = connect env ~sw port in
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
