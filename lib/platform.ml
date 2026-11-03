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

let listen_unix_with_identity ~sw ~path ~backlog ~on_cleanup_error ~on_bound =
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
    on_bound identity;
    with_fd listener (fun descriptor -> Unix.listen descriptor backlog);
    (listener :> [ `Generic ] Eio.Net.listening_socket_ty Eio.Resource.t))
;;

let listen_unix ~sw ~path ~backlog ~on_cleanup_error =
  listen_unix_with_identity ~sw ~path ~backlog ~on_cleanup_error ~on_bound:ignore
;;

module Socket_owner = struct
  type t =
    { path : string
    ; canonical_path : string
    ; guard_path : string
    ; guard : Eio.File.rw_ty Eio.Resource.t
    ; guard_identity : Unix.stats
    }

  let occupied () =
    Json.fail
      Conflict
      "socket path is occupied by an unrecognized owner; stop all possible owners before \
       explicitly removing an abandoned socket, or choose another socket path"
  ;;

  let same_identity a b =
    Int.equal a.Unix.st_dev b.Unix.st_dev && Int.equal a.st_ino b.st_ino
  ;;

  let verify_guard t =
    Eio_unix.run_in_systhread (fun () ->
      let current = Unix.lstat t.guard_path in
      match current.st_kind with
      | S_REG when same_identity current t.guard_identity -> ()
      | S_REG | S_DIR | S_CHR | S_BLK | S_LNK | S_FIFO | S_SOCK ->
        Json.fail Conflict "socket owner guard was replaced")
  ;;

  let recognized t identity =
    let length = Eio.File.size t.guard in
    if
      Optint.Int63.compare length Optint.Int63.zero <= 0
      || Optint.Int63.compare length (Optint.Int63.of_int 4096) > 0
    then false
    else (
      let bytes = Cstruct.create (Optint.Int63.to_int length) in
      Eio.File.pread_exact t.guard ~file_offset:Optint.Int63.zero [ bytes ];
      match
        Json.decode (fun () ->
          let value =
            match Json.parse (Cstruct.to_string bytes) with
            | Ok value -> value
            | Error error -> raise (Json.Decode_error error)
          in
          Json.fields
            value
            ~allowed:
              [ "workgraph_socket_owner"; "path"; "device"; "inode"; "change_time" ];
          String.equal (Json.text (Json.field value "workgraph_socket_owner")) "1"
          && String.equal (Json.text (Json.field value "path")) t.canonical_path
          && Int.equal (Json.integer (Json.field value "device")) identity.Unix.st_dev
          && Int.equal (Json.integer (Json.field value "inode")) identity.st_ino
          && String.equal
               (Json.text (Json.field value "change_time"))
               (Int64.to_string (Int64.bits_of_float identity.st_ctime)))
      with
      | Ok matches -> matches
      | Error _ -> false)
  ;;

  let acquire ~sw ~fs ~path =
    (match validate_socket_path path with
     | Ok () -> ()
     | Error error -> raise (Json.Decode_error error));
    let directory = realpath (Filename.dirname path) in
    let canonical_path = Filename.concat directory (Filename.basename path) in
    let guard_path =
      Filename.concat directory (".workgraph-socket-" ^ Json.hash canonical_path ^ ".lock")
    in
    let guard_location = Eio.Path.(fs / guard_path) in
    (match Eio.Path.kind ~follow:false guard_location with
     | `Not_found | `Regular_file -> ()
     | _ -> Json.fail Conflict "socket owner guard must be a real regular file");
    let guard = Eio.Path.open_out ~sw ~create:(`If_missing 0o600) guard_location in
    let guard_identity = with_fd guard Unix.fstat in
    let t = { path; canonical_path; guard_path; guard; guard_identity } in
    verify_guard t;
    if not (lock_exclusive guard)
    then
      raise
        (Json.Decode_error
           (Problem.with_details
              (Problem.create
                 Conflict
                 "socket path already has an active Workgraph owner")
              (Socket_owner { socket_path = canonical_path })));
    sync_directory Eio.Path.(fs / directory);
    let identity =
      Eio_unix.run_in_systhread (fun () ->
        match Unix.lstat path with
        | identity -> Some identity
        | exception Unix.Unix_error (ENOENT, _, _) -> None)
    in
    Option.iter identity ~f:(fun identity ->
      match identity.Unix.st_kind with
      | S_SOCK when recognized t identity ->
        verify_guard t;
        Eio_unix.run_in_systhread (fun () ->
          let current = Unix.lstat path in
          match current.st_kind with
          | S_SOCK
            when same_identity current identity
                 && Float.equal current.st_ctime identity.st_ctime -> Unix.unlink path
          | S_REG | S_DIR | S_CHR | S_BLK | S_LNK | S_FIFO | S_SOCK -> occupied ());
        sync_directory Eio.Path.(fs / directory)
      | S_REG | S_DIR | S_CHR | S_BLK | S_LNK | S_FIFO | S_SOCK -> occupied ());
    t
  ;;

  let listen t ~sw ~backlog ~on_cleanup_error =
    verify_guard t;
    listen_unix_with_identity
      ~sw
      ~path:t.path
      ~backlog
      ~on_cleanup_error
      ~on_bound:(fun identity ->
        verify_guard t;
        restrict_socket t.path;
        let current = Eio_unix.run_in_systhread (fun () -> Unix.lstat t.path) in
        if not (same_identity current identity) then occupied ();
        let marker =
          Json.canonical
            (Json.obj
               [ "workgraph_socket_owner", Json.string "1"
               ; "path", Json.string t.canonical_path
               ; "device", Json.int identity.Unix.st_dev
               ; "inode", Json.int identity.st_ino
               ; ( "change_time"
                 , Json.string (Int64.to_string (Int64.bits_of_float current.st_ctime)) )
               ])
        in
        Eio.File.pwrite_all
          t.guard
          ~file_offset:Optint.Int63.zero
          [ Cstruct.of_string marker ];
        Eio.File.truncate t.guard (Optint.Int63.of_int (String.length marker));
        Eio.File.sync t.guard;
        (* Graceful release must invalidate the marker before removing its
           socket: an unrelated later inode can reuse the same device/number. *)
        Eio.Switch.on_release sw (fun () ->
          try
            verify_guard t;
            Eio.File.truncate t.guard Optint.Int63.zero;
            Eio.File.sync t.guard
          with
          | Unix.Unix_error _ as exn -> on_cleanup_error (Exn.to_string exn)
          | Eio.Io _ as exn -> on_cleanup_error (Exn.to_string exn)
          | Json.Decode_error problem -> on_cleanup_error problem.message))
  ;;
end

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

let write_diagnostic sink text =
  try write_string sink text with
  | Broken_pipe -> ()
  | Json.Decode_error { kind = Local_io; _ } -> ()
;;
