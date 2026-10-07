open Core
open Workgraph

(* Test-only JSON-lines bridge. Actual framed service requests travel over the
   in-memory transport; no production protocol or transport policy is replaced. *)
let () =
  Eio_main.run (fun env ->
    let registry = (Sys.get_argv ()).(1) in
    Eio.Switch.run (fun sw ->
      let incoming = Eio.Stream.create 8 in
      let listener = Memory_transport.listener incoming in
      let finished =
        Eio.Fiber.fork_promise ~sw (fun () -> Service.serve ~env ~registry ~listener)
      in
      let call request =
        let flow = Memory_transport.connect incoming in
        Exn.protect
          ~finally:(fun () -> Eio.Resource.close flow)
          ~f:(fun () ->
            Framing.write flow request;
            Framing.read flow)
      in
      let input =
        Eio.Buf_read.of_flow (Eio.Stdenv.stdin env) ~max_size:Framing.max_bytes
      in
      let rec loop () =
        match Eio.Buf_read.line input with
        | line ->
          let request = Json.parse line |> Disk.unwrap in
          let response = call request in
          Eio.Flow.copy_string (Json.canonical response ^ "\n") (Eio.Stdenv.stdout env);
          if
            not (String.equal (Json.text (Json.field request "method")) "daemon.shutdown")
          then loop ()
        | exception End_of_file ->
          ignore
            (call
               (Json.obj
                  [ "jsonrpc", Json.string "2.0"
                  ; "id", Json.string "stop"
                  ; "method", Json.string "daemon.shutdown"
                  ; "params", Json.obj []
                  ])
             : Jsonaf.t)
      in
      loop ();
      Eio.Promise.await_exn finished))
;;
