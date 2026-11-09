open Core
open Workgraph

type t =
  { path : string
  ; directory : Eio.Fs.dir_ty Eio.Path.t
  ; guard : Eio.File.rw_ty Eio.Resource.t
  ; identity : Eio.File.Stat.t
  }

let path t = t.path
let directory t = t.directory
let journal_directory t = Filename.concat t.path "requests"

let verify t =
  let held = Eio.File.stat t.guard in
  let current = Eio.Path.stat ~follow:false Eio.Path.(t.directory / ".owner.lock") in
  if
    not
      (Int64.equal held.dev t.identity.dev
       && Int64.equal held.ino t.identity.ino
       && Int64.equal current.dev t.identity.dev
       && Int64.equal current.ino t.identity.ino)
  then Json.fail Conflict "companion state-root guard was replaced";
  match current.kind with
  | `Regular_file -> ()
  | _ -> Json.fail Conflict "companion state-root guard must remain a regular file"
;;

let private_directory directory =
  let stat = Eio.Path.stat ~follow:false directory in
  match stat.kind with
  | `Directory when stat.perm land 0o077 = 0 -> ()
  | `Directory ->
    Json.fail Invalid_argument "companion state directory must be private (0700)"
  | _ -> Json.fail Invalid_argument "companion state root must be a real directory"
;;

let acquire ~sw ~fs ~random:_ ~path =
  Disk.protect (fun () ->
    Disk.absolute path;
    let location = Eio.Path.(fs / path) in
    (match Eio.Path.kind ~follow:true location with
     | `Not_found -> Disk.ensure_directory location
     | `Directory -> ()
     | _ -> Json.fail Invalid_argument "companion state root is not a directory");
    let path = Platform.realpath path in
    let directory = Eio.Path.(fs / path) in
    private_directory directory;
    let guard_path = Eio.Path.(directory / ".owner.lock") in
    (match Eio.Path.kind ~follow:false guard_path with
     | `Not_found | `Regular_file -> ()
     | _ -> Json.fail Conflict "companion state-root guard must be a regular file");
    let guard = Eio.Path.open_out ~sw ~create:(`If_missing 0o600) guard_path in
    let identity = Eio.File.stat guard in
    let t = { path; directory; guard; identity } in
    verify t;
    if not (Platform.lock_exclusive guard)
    then Json.fail Conflict "companion state root already has an active owner";
    verify t;
    if identity.perm land 0o077 <> 0
    then Json.fail Invalid_argument "companion state-root guard must be private (0600)";
    Platform.sync_directory directory;
    let requests = Eio.Path.(directory / "requests") in
    Disk.ensure_directory requests;
    private_directory requests;
    t)
;;

let location t name =
  if
    String.is_empty name
    || String.length name > 192
    || (not (String.equal name (Filename.basename name)))
    || String.equal name "."
    || String.equal name ".."
    || String.mem name '\000'
    || not (String.is_suffix name ~suffix:".json")
  then Json.fail Invalid_argument "state document name must be a JSON basename";
  verify t;
  Eio.Path.(t.directory / name)
;;

let read t ~name =
  Disk.protect (fun () ->
    let path = location t name in
    match Eio.Path.kind ~follow:false path with
    | `Not_found -> None
    | `Regular_file ->
      Some
        (Disk.read_with_limit path ~max_bytes:(32 * 1024 * 1024)
         |> Json.parse_with_limit ~max_bytes:(32 * 1024 * 1024)
         |> Disk.unwrap)
    | _ -> Json.fail Corrupt_store "state document must be a real regular file")
;;

let names t =
  Disk.protect (fun () ->
    verify t;
    let names = Eio.Path.read_dir t.directory in
    if List.length names > 10032
    then Json.fail Corrupt_store "too many companion state files";
    List.filter names ~f:(fun name -> String.is_suffix name ~suffix:".json")
    |> List.sort ~compare:String.compare)
;;

let save t ~name ~value =
  Disk.protect (fun () ->
    let path = location t name in
    (match Eio.Path.kind ~follow:false path with
     | `Not_found | `Regular_file -> ()
     | _ -> Json.fail Corrupt_store "state document target must be a regular file");
    let bytes = Json.canonical value in
    ignore
      (Json.parse_with_limit ~max_bytes:(32 * 1024 * 1024) bytes |> Disk.unwrap
       : Jsonaf.t);
    Disk.replace path bytes;
    verify t)
;;
