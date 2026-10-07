open Core

let protect f =
  try Json.decode f with
  | Eio.Io _ as exn -> Error (Problem.create Storage_unavailable (Exn.to_string exn))
  | Core_unix.Unix_error _ as exn ->
    Error (Problem.create Storage_unavailable (Exn.to_string exn))
;;

let unwrap = function
  | Ok value -> value
  | Error error -> raise (Json.Decode_error error)
;;

let absolute path =
  if String.mem path '\000' then Json.fail Invalid_argument "path contains a NUL byte";
  if not (Filename.is_absolute path)
  then Json.fail Invalid_argument "path must be absolute"
;;

let parent path =
  match Eio.Path.split path with
  | Some (parent, _) -> parent
  | None -> Json.fail Invalid_argument "path has no parent"
;;

let ensure_directory path =
  match Eio.Path.kind ~follow:false path with
  | `Directory -> ()
  | `Not_found ->
    Eio.Path.mkdir ~perm:0o700 path;
    Platform.sync_directory (parent path)
  | _ -> Json.fail Invalid_argument "expected real directory, not symlink"
;;

let require_directory path =
  match Eio.Path.kind ~follow:false path with
  | `Directory -> ()
  | _ -> Json.fail Corrupt_store "expected real canonical directory"
;;

let read_with_limit path ~max_bytes =
  if max_bytes <= 0 || max_bytes > 64 * 1024 * 1024
  then Json.fail Invalid_argument "invalid file size bound";
  (match Eio.Path.kind ~follow:false path with
   | `Regular_file -> ()
   | _ -> Json.fail Corrupt_store "expected regular file");
  Eio.Path.with_open_in path (fun file ->
    if Optint.Int63.compare (Eio.File.size file) (Optint.Int63.of_int max_bytes) > 0
    then Json.fail Corrupt_store "file exceeds byte limit";
    try Eio.Buf_read.(of_flow file ~max_size:(max_bytes + 1) |> take_all) with
    | Eio.Buf_read.Buffer_limit_exceeded ->
      Json.fail Corrupt_store "file grew beyond byte limit")
;;

let read path = read_with_limit path ~max_bytes:(4 * 1024 * 1024)

let write_new path content =
  Eio.Path.with_open_out ~create:(`Exclusive 0o600) path (fun file ->
    Eio.Flow.copy_string content file;
    Eio.File.sync file);
  Platform.sync_directory (parent path)
;;

let sequence = Atomic.make 0

let replace path content =
  let directory, basename =
    match Eio.Path.split path with
    | Some pair -> pair
    | None -> Json.fail Invalid_argument "invalid path"
  in
  let temporary =
    Eio.Path.(
      directory / (basename ^ ".tmp-" ^ Int.to_string (Atomic.fetch_and_add sequence 1)))
  in
  (* An interrupted temporary file is never reused or taken as authoritative. *)
  let rec choose n =
    let path =
      if n = 0
      then temporary
      else
        Eio.Path.(
          directory
          / (basename ^ ".tmp-" ^ Int.to_string (Atomic.fetch_and_add sequence 1)))
    in
    match Eio.Path.kind ~follow:false path with
    | `Not_found -> path
    | _ -> choose (n + 1)
  in
  let temporary = choose 0 in
  write_new temporary content;
  Eio.Path.rename temporary path;
  Platform.sync_directory directory
;;
