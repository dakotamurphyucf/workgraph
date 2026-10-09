open Core
open Workgraph

let require condition message = if not condition then failwith message

let expect_error kind = function
  | Error error -> require (Problem.equal_kind error.Problem.kind kind) error.message
  | Ok _ -> failwith "expected typed failure"
;;

let () =
  Eio_main.run (fun env ->
    let root = Array.get (Sys.get_argv ()) 1 in
    let fs = Eio.Stdenv.fs env in
    let maximum = Platform.socket_path_max_bytes () in
    require (maximum > 0) "invalid native socket bound";
    let boundary = "/" ^ String.make (maximum - 1) 'a' in
    Platform.validate_socket_path boundary |> Disk.unwrap;
    expect_error Invalid_argument (Platform.validate_socket_path (boundary ^ "a"));
    let multibyte = "/" ^ String.concat (List.init maximum ~f:(fun _ -> "é")) in
    expect_error Invalid_argument (Platform.validate_socket_path multibyte);
    let local f = Local_file.protect ~operation:"fixture" ~path:root f in
    expect_error
      Local_io
      (local (fun () -> raise (Caml_unix.Unix_error (EACCES, "open", root))));
    expect_error
      Invalid_argument
      (local (fun () -> raise (Caml_unix.Unix_error (ENOTDIR, "open", root))));
    expect_error
      Outcome_unknown
      (local (fun () -> Json.fail Outcome_unknown "durable uncertainty"));
    expect_error
      Corrupt_store
      (local (fun () -> Json.fail Corrupt_store "durable corruption"));
    (match local (fun () -> raise Exit) with
     | exception Exit -> ()
     | _ -> failwith "unexpected exception was hidden");
    (match local (fun () -> raise (Eio.Cancel.Cancelled Exit)) with
     | exception Eio.Cancel.Cancelled Exit -> ()
     | _ -> failwith "cancellation was hidden");
    let socket = Filename.concat root "bound.sock" in
    let cleanup_errors = ref [] in
    let listener sw =
      Platform.listen_unix ~sw ~path:socket ~backlog:8 ~on_cleanup_error:(fun message ->
        cleanup_errors := message :: !cleanup_errors)
    in
    Eio.Switch.run (fun sw ->
      ignore (listener sw : [ `Generic ] Eio.Net.listening_socket_ty Eio.Resource.t);
      (match Eio.Switch.run (fun sw -> listener sw) with
       | exception Caml_unix.Unix_error (EADDRINUSE, _, _) -> ()
       | _ -> failwith "bind collision did not preserve EADDRINUSE");
      require
        (match Eio.Path.kind ~follow:false Eio.Path.(fs / socket) with
         | `Socket -> true
         | _ -> false)
        "failed bind unlinked live socket";
      Eio.Path.unlink Eio.Path.(fs / socket);
      Local_file.write_new
        Eio.Path.(fs / socket)
        ~operation:"replace socket fixture"
        "replacement");
    require (List.is_empty !cleanup_errors) "unexpected cleanup error";
    require
      (String.equal
         (Local_file.read Eio.Path.(fs / socket) ~operation:"verify replacement")
         "replacement")
      "cleanup removed replacement";
    let restricted = Filename.concat root "restricted" in
    Eio.Path.mkdir ~perm:0o700 Eio.Path.(fs / restricted);
    let restricted_socket = Filename.concat restricted "socket" in
    Exn.protect
      ~f:(fun () ->
        Eio.Switch.run (fun sw ->
          ignore
            (Platform.listen_unix
               ~sw
               ~path:restricted_socket
               ~backlog:8
               ~on_cleanup_error:(fun message ->
                 cleanup_errors := message :: !cleanup_errors)
             : [ `Generic ] Eio.Net.listening_socket_ty Eio.Resource.t);
          Eio_unix.run_in_systhread (fun () -> Core_unix.chmod restricted ~perm:0o500)))
      ~finally:(fun () ->
        Eio_unix.run_in_systhread (fun () -> Core_unix.chmod restricted ~perm:0o700));
    require (List.length !cleanup_errors = 1) "expected cleanup failure was not reported";
    let missing = Filename.concat root "missing/failed.sock" in
    (match
       Eio.Switch.run (fun sw ->
         Platform.listen_unix ~sw ~path:missing ~backlog:8 ~on_cleanup_error:(fun _ ->
           failwith "failed bind cleaned up"))
     with
     | exception Caml_unix.Unix_error (ENOENT, _, _) -> ()
     | _ -> failwith "missing parent did not preserve ENOENT");
    let request =
      Protocol.Request.create
        ~id:"local-io"
        ~method_:"daemon.health"
        ~params:(Json.obj [])
      |> Disk.unwrap
    in
    let original = Protocol.Failure (Problem.create Local_io "fixture local error") in
    let decoded =
      Protocol.decode_response request (Protocol.response_json request original)
      |> Disk.unwrap
    in
    (match decoded with
     | Failure error ->
       require (Problem.equal_kind error.kind Local_io) "Local_io wire discriminator"
     | Success _ -> failwith "Local_io wire error became success");
    Eio.Flow.copy_string (Int.to_string maximum ^ "\n") (Eio.Stdenv.stdout env))
;;
