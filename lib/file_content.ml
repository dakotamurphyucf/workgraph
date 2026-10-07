open Core

let buffer_bytes = 256 * 1024

let check path =
  match Eio.Path.kind ~follow:false path with
  | `Regular_file -> ()
  | _ -> Json.fail Corrupt_store "blob must be a regular file"
;;

let size file ~max_bytes =
  if max_bytes <= 0 || max_bytes > 1024 * 1024 * 1024
  then Json.fail Invalid_argument "invalid streaming file bound";
  let n = Eio.File.size file in
  if Optint.Int63.compare n (Optint.Int63.of_int max_bytes) > 0
  then Json.fail Corrupt_store "file exceeds streaming byte limit";
  Optint.Int63.to_int n
;;

let with_file path ~max_bytes f =
  check path;
  Eio.Path.with_open_in path (fun file ->
    try f file (size file ~max_bytes) with
    | End_of_file -> Json.fail Corrupt_store "blob changed or was truncated during read")
;;

let scan file total ~max_bytes ~write =
  let buffer = Cstruct.create buffer_bytes in
  let rec loop offset ctx =
    if offset = total
    then Digestif.SHA256.(get ctx |> to_hex)
    else (
      let length = Int.min buffer_bytes (total - offset) in
      let chunk = Cstruct.sub buffer 0 length in
      Eio.File.pread_exact file ~file_offset:(Optint.Int63.of_int offset) [ chunk ];
      write chunk;
      loop (offset + length) (Digestif.SHA256.feed_string ctx (Cstruct.to_string chunk)))
  in
  let digest = loop 0 Digestif.SHA256.empty in
  if not (Int.equal total (size file ~max_bytes))
  then Json.fail Corrupt_store "blob changed during read";
  digest
;;

let inspect path ~max_bytes =
  Disk.protect (fun () ->
    with_file path ~max_bytes (fun file total ->
      scan file total ~max_bytes ~write:ignore, total))
;;

let read_range path ~max_bytes ~offset ~length =
  Disk.protect (fun () ->
    if offset < 0 || length < 0 || length > buffer_bytes
    then Json.fail Invalid_argument "range length must be 0..262144 bytes";
    with_file path ~max_bytes (fun file total ->
      if offset > total then Json.fail Invalid_argument "offset is beyond blob end";
      let length = Int.min length (total - offset) in
      let buffer = Cstruct.create length in
      Eio.File.pread_exact file ~file_offset:(Optint.Int63.of_int offset) [ buffer ];
      Cstruct.to_string buffer, total))
;;

let copy src ~dst ~max_bytes =
  Disk.protect (fun () ->
    with_file src ~max_bytes (fun file total ->
      let digest =
        Eio.Path.with_open_out ~create:(`Exclusive 0o600) dst (fun output ->
          let digest =
            scan file total ~max_bytes ~write:(fun bytes ->
              Eio.Flow.write output [ bytes ])
          in
          Eio.File.sync output;
          digest)
      in
      (match Eio.Path.split dst with
       | Some (parent, _) -> Platform.sync_directory parent
       | None -> assert false);
      digest, total))
;;
