open Core
open Workgraph
open Memory_transport

let ok = Disk.unwrap

let request method_ params =
  Json.obj
    [ "jsonrpc", Json.string "2.0"
    ; "id", Json.string "test"
    ; "method", Json.string method_
    ; "params", Json.obj params
    ]
;;

let%expect_test "service history workers, feeds, restart and shutdown over memory flows" =
  Eio_main.run (fun env ->
    let fs = Eio.Stdenv.fs env in
    let nonce = Cstruct.create 16 in
    Eio.Flow.read_exact (Eio.Stdenv.secure_random env) nonce;
    let root = "/tmp/workgraph-service-" ^ Json.hash (Cstruct.to_string nonce) in
    Disk.ensure_directory Eio.Path.(fs / root);
    Exn.protect
      ~finally:(fun () -> Eio.Path.rmtree Eio.Path.(fs / root))
      ~f:(fun () ->
        let registry = root ^ "/registry" in
        let run f =
          Eio.Time.with_timeout_exn (Eio.Stdenv.clock env) 10. (fun () ->
            Eio.Switch.run (fun sw ->
              let incoming = Eio.Stream.create 8 in
              let listener =
                Eio.Resource.T (incoming, Eio.Net.Pi.listening_socket (module Listener))
              in
              let finished =
                Eio.Fiber.fork_promise ~sw (fun () ->
                  Service.serve ~env ~registry ~listener)
              in
              let connect () =
                let client, server = Flow.pair () in
                Eio.Stream.add incoming server;
                client
              in
              let call method_ params =
                let flow = connect () in
                Exn.protect
                  ~finally:(fun () -> Eio.Resource.close flow)
                  ~f:(fun () ->
                    Framing.write flow (request method_ params);
                    let response = Framing.read flow in
                    match Json.optional response "result" with
                    | Some result -> result
                    | None -> failwith (Json.canonical response))
              in
              f ~sw ~connect ~call;
              ignore (call "daemon.shutdown" [] : Jsonaf.t);
              Eio.Promise.await_exn finished))
        in
        let workspace = "service" in
        let scope = [ "workspace_id", Json.string workspace ] in
        let mutate call method_ mutation fields =
          call
            method_
            (scope
             @ [ "actor_id", Json.string "agent"; "mutation_id", Json.string mutation ]
             @ fields)
        in
        run (fun ~sw ~connect ~call ->
          ignore
            (mutate
               call
               "workspace.create"
               "create"
               [ "name", Json.string "Service"
               ; "root", Json.string (root ^ "/workspace")
               ]
             : Jsonaf.t);
          ignore
            (mutate
               call
               "session.create"
               "session"
               [ "session_id", Json.string "chat"; "title", Json.string "Chat" ]
             : Jsonaf.t);
          List.iter
            [ "board.list"; "run.list"; "manifest.list"; "template.list" ]
            ~f:(fun method_ -> ignore (call method_ scope : Jsonaf.t));
          printf "all extension query families accept workspace envelope\n";
          let event =
            Session_event.Input.create
              ~client_id:"e1"
              ~phase:"completed"
              ~attachments:[]
              ~role:"user"
              ~kind:"message"
              ~payload:(Inline "fact")
              ~searchable_text:(Inline "remembered fact")
              ()
            |> ok
            |> Session_event.Input.to_json
          in
          ignore
            (mutate
               call
               "session.append"
               "append"
               [ "session_id", Json.string "chat"; "events", `Array [ event ] ]
             : Jsonaf.t);
          let search =
            call "history.search" (scope @ [ "text", Json.string "remembered" ])
          in
          printf
            "history hits: %d\n"
            (List.length (Json.list (Json.field search "items")));
          let first = call "changes.read" scope in
          let wait = connect () in
          Framing.write
            wait
            (request
               "changes.wait"
               (scope
                @ [ "cursor", Json.field first "cursor"; "timeout_ms", Json.int 1000 ]));
          let waiting = Eio.Fiber.fork_promise ~sw (fun () -> Framing.read wait) in
          ignore
            (mutate
               call
               "ticket.create"
               "ticket"
               [ "ticket_id", Json.string "task"; "title", Json.string "Task" ]
             : Jsonaf.t);
          let changed =
            Eio.Promise.await_exn waiting |> fun response -> Json.field response "result"
          in
          printf "feed mutation delivered: %b\n" (Change_feed.has_items changed);
          Eio.Resource.close wait;
          for _ = 1 to 70 do
            let disconnected = connect () in
            Framing.write
              disconnected
              (request "changes.wait" (scope @ [ "cursor", Json.field changed "cursor" ]));
            Eio.Fiber.yield ();
            Eio.Resource.close disconnected;
            ignore (call "daemon.health" [] : Jsonaf.t)
          done;
          printf "70 disconnected waiters released without exhausting connection slots\n";
          let timed =
            call
              "changes.wait"
              (scope
               @ [ "cursor", Json.field changed "cursor"; "timeout_ms", Json.int 100 ])
          in
          printf "timeout has no phantom items: %b\n" (not (Change_feed.has_items timed));
          let parked = connect () in
          Framing.write
            parked
            (request "changes.wait" (scope @ [ "cursor", Json.field timed "cursor" ]));
          Eio.Fiber.fork ~sw (fun () ->
            match Framing.read parked with
            | _ -> failwith "parked wait unexpectedly returned before shutdown"
            | exception End_of_file -> printf "shutdown canceled parked waiter\n"));
        run (fun ~sw:_ ~connect:_ ~call ->
          let read =
            call
              "history.read"
              (scope
               @ [ "session_id", Json.string "chat"
                 ; "direction", Json.string "after"
                 ; "anchor", Json.int 0
                 ])
          in
          printf
            "history after restart: %d events\n"
            (List.length (Json.list (Json.field read "items"))))));
  [%expect
    {|
    all extension query families accept workspace envelope
    history hits: 1
    feed mutation delivered: true
    70 disconnected waiters released without exhausting connection slots
    timeout has no phantom items: true
    shutdown canceled parked waiter
    history after restart: 1 events
    |}]
;;
