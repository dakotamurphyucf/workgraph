open Core
module Unix = Caml_unix

external socket_path_max_bytes : unit -> int = "workgraph_socket_path_max_bytes"

let validate_socket_path path =
  Json.decode (fun () ->
    if String.mem path '\000'
    then Json.fail Invalid_argument "socket path contains a NUL byte";
    if not (Filename.is_absolute path)
    then Json.fail Invalid_argument "socket path must be absolute";
    let maximum = socket_path_max_bytes () in
    if String.length path > maximum
    then
      Json.fail
        Invalid_argument
        (sprintf
           "socket path %S is %d bytes; maximum is %d bytes plus the NUL terminator"
           path
           (String.length path)
           maximum))
;;

exception Broken_pipe

let with_fd file f =
  match Eio_unix.Resource.fd_opt file with
  | None -> Json.fail Storage_unavailable "native file descriptor required"
  | Some fd ->
    Eio_unix.Fd.use_exn "workgraph filesystem durability" fd (fun descriptor ->
      Eio_unix.run_in_systhread (fun () -> f descriptor))
;;

let sync_directory path =
  Eio.Path.with_open_in path (fun file -> with_fd file Core_unix.fsync)
;;

let lock_exclusive file =
  with_fd file (fun fd -> Core_unix.flock fd Core_unix.Flock_command.lock_exclusive)
;;

let restrict_socket path =
  Eio_unix.run_in_systhread (fun () -> Core_unix.chmod path ~perm:0o600)
;;

let realpath path = Eio_unix.run_in_systhread (fun () -> Unix.realpath path)

let listen_unix ~sw ~path ~backlog ~on_cleanup_error =
  (match validate_socket_path path with
   | Ok () -> ()
   | Error error -> raise (Json.Decode_error error));
  Eio.Cancel.protect (fun () ->
    let descriptor =
      Eio_unix.run_in_systhread (fun () ->
        Unix.socket ~cloexec:true Unix.PF_UNIX Unix.SOCK_STREAM 0)
    in
    let listener = Eio_unix.Net.import_socket_listening ~sw ~close_unix:true descriptor in
    let identity =
      with_fd listener (fun descriptor ->
        Unix.bind descriptor (Unix.ADDR_UNIX path);
        Unix.lstat path)
    in
    Eio.Switch.on_release sw (fun () ->
      try
        Eio_unix.run_in_systhread (fun () ->
          match Unix.lstat path with
          | current ->
            if
              Int.equal current.st_dev identity.Unix.st_dev
              && Int.equal current.st_ino identity.st_ino
            then Unix.unlink path
          | exception Unix.Unix_error (ENOENT, _, _) -> ())
      with
      | Unix.Unix_error _ as exn -> on_cleanup_error (Exn.to_string exn)
      | Eio.Io _ as exn -> on_cleanup_error (Exn.to_string exn));
    with_fd listener (fun descriptor -> Unix.listen descriptor backlog);
    (listener :> [ `Generic ] Eio.Net.listening_socket_ty Eio.Resource.t))
;;

let link_exclusive ~src ~dst =
  let target = Eio.Path.native_exn src
  and link_name = Eio.Path.native_exn dst in
  Eio_unix.run_in_systhread (fun () ->
    try Core_unix.link ~force:false ~target ~link_name () with
    | Core_unix.Unix_error (EEXIST, _, _) ->
      Json.fail Conflict "destination already exists")
;;

external rename_exclusive_native : string -> string -> unit = "workgraph_rename_exclusive"

let rename_exclusive ~src ~dst =
  let source = Eio.Path.native_exn src
  and destination = Eio.Path.native_exn dst in
  Eio_unix.run_in_systhread (fun () ->
    try rename_exclusive_native source destination with
    | Unix.Unix_error ((EEXIST | ENOTEMPTY), _, _) ->
      Json.fail Conflict "destination already exists"
    | Unix.Unix_error _ as error ->
      Json.fail Storage_unavailable (Core.Exn.to_string error))
;;

let write_string_unchecked sink text =
  match Eio_unix.Resource.fd_opt sink with
  | None -> Eio.Flow.copy_string text sink
  | Some fd ->
    let is_null =
      Eio_unix.Fd.use_exn "workgraph output device" fd (fun descriptor ->
        Eio_unix.run_in_systhread (fun () ->
          let metadata = Unix.fstat descriptor in
          match metadata.st_kind with
          | Unix.S_CHR -> Int.equal metadata.st_rdev (Unix.stat "/dev/null").st_rdev
          | S_REG | S_DIR | S_BLK | S_LNK | S_FIFO | S_SOCK -> false))
    in
    if not is_null
    then Eio.Flow.copy_string text sink
    else
      Eio_unix.Fd.use_exn "workgraph null-device output" fd (fun descriptor ->
        Eio_unix.run_in_systhread (fun () ->
          let rec write offset =
            if offset < String.length text
            then (
              match
                Unix.write_substring descriptor text offset (String.length text - offset)
              with
              | 0 -> Json.fail Storage_unavailable "null-device write made no progress"
              | written -> write (offset + written)
              | exception Unix.Unix_error (EINTR, _, _) -> write offset)
          in
          write 0))
;;

let write_string sink text =
  try write_string_unchecked sink text with
  | Unix.Unix_error (EPIPE, _, _)
  | Eio.Io (Eio.Net.E (Connection_reset (Eio_unix.Unix_error (EPIPE, _, _))), _) ->
    raise Broken_pipe
  | (Unix.Unix_error _ | Eio.Io _) as exn ->
    Json.fail Local_io ("write local output: " ^ Exn.to_string exn)
;;
