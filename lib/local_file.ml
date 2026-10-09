open Core

let diagnostic ~operation ~path message = sprintf "%s %S: %s" operation path message

let protect ~operation ~path f =
  let failure kind exn =
    Error (Problem.create kind (diagnostic ~operation ~path (Exn.to_string exn)))
  in
  try Json.decode f with
  | Eio.Io (Eio.Fs.E (Not_found _ | Already_exists _), _) as exn ->
    failure Invalid_argument exn
  | Eio.Io (Eio.Exn.X (Eio_unix.Unix_error (ENOTDIR, _, _)), _) as exn ->
    failure Invalid_argument exn
  | Core_unix.Unix_error ((ENOENT | ENOTDIR | EEXIST), _, _) as exn ->
    failure Invalid_argument exn
  | Eio.Io _ as exn -> failure Local_io exn
  | Core_unix.Unix_error _ as exn -> failure Local_io exn
;;

let with_path path ~operation f =
  protect ~operation ~path:(Eio.Path.native_exn path) f |> Disk.unwrap
;;

let invalid path ~operation message =
  Json.fail
    Invalid_argument
    (diagnostic ~operation ~path:(Eio.Path.native_exn path) message)
;;

let require_directory path ~operation =
  with_path path ~operation (fun () ->
    match Eio.Path.kind ~follow:false path with
    | `Directory -> ()
    | _ -> invalid path ~operation "requires an existing real directory")
;;

let read path ~operation =
  with_path path ~operation (fun () ->
    let max_bytes = 4 * 1024 * 1024 in
    (match Eio.Path.kind ~follow:false path with
     | `Regular_file -> ()
     | _ ->
       invalid path ~operation "requires an existing regular file (no pipes or devices)");
    Eio.Path.with_open_in path (fun file ->
      if Optint.Int63.compare (Eio.File.size file) (Optint.Int63.of_int max_bytes) > 0
      then invalid path ~operation "file exceeds 4194304-byte limit";
      let bytes =
        try Eio.Buf_read.(of_flow file ~max_size:(max_bytes + 1) |> take_all) with
        | Eio.Buf_read.Buffer_limit_exceeded ->
          invalid path ~operation "file grew beyond 4194304-byte limit"
      in
      if String.length bytes > max_bytes
      then invalid path ~operation "file grew beyond 4194304-byte limit";
      bytes))
;;

let write_new path ~operation content =
  with_path path ~operation (fun () -> Disk.write_new path content)
;;

let link_exclusive ~src ~dst ~operation =
  with_path dst ~operation (fun () ->
    try Platform.link_exclusive ~src ~dst with
    | Json.Decode_error { kind = Conflict; _ } ->
      invalid dst ~operation "destination already exists")
;;
