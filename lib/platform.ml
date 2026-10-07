open Core
module Unix = Caml_unix

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

let write_string sink text =
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
