open Core

module Entry = struct
  type t =
    { actor : Id.Actor.t
    ; size_bytes : int
    ; digest : string
    ; received : int
    ; installed : bool
    }
end

type t =
  { directory : Eio.Fs.dir_ty Eio.Path.t
  ; mutable entries : Entry.t Id.Upload.Map.t
  }

let create ~directory =
  Disk.ensure_directory directory;
  List.iter (Eio.Path.read_dir directory) ~f:(fun name ->
    match String.chop_suffix name ~suffix:".part" with
    | None -> ()
    | Some id ->
      ignore (Id.Upload.of_string id |> Disk.unwrap : Id.Upload.t);
      let path = Eio.Path.(directory / name) in
      (match Eio.Path.kind ~follow:false path with
       | `Regular_file -> Eio.Path.unlink path
       | _ -> Json.fail Corrupt_store "invalid abandoned upload file"));
  Platform.sync_directory directory;
  { directory; entries = Id.Upload.Map.empty }
;;

let max_chunk_bytes = 256 * 1024
let path t id = Eio.Path.(t.directory / (Id.Upload.to_string id ^ ".part"))

let find t id actor =
  match Map.find t.entries id with
  | None -> Json.fail Not_found "upload is absent or was interrupted; begin a new upload"
  | Some entry ->
    if not (Id.Actor.equal entry.actor actor)
    then Json.fail Conflict "upload belongs to another actor";
    entry
;;

let response id (entry : Entry.t) =
  Json.obj
    [ "upload_id", Id.Upload.jsonaf_of_t id
    ; "received", Json.int entry.received
    ; "size_bytes", Json.int entry.size_bytes
    ; "digest", Json.string entry.digest
    ]
;;

let begin_upload t ~id ~actor ~size_bytes ~digest =
  Disk.protect (fun () ->
    if size_bytes < 0 || size_bytes > Resource.max_blob_bytes
    then Json.fail Invalid_argument "upload size must be 0..64MiB";
    if
      String.length digest <> 64
      || not
           (String.for_all digest ~f:(fun c ->
              Char.is_digit c || Char.(c >= 'a' && c <= 'f')))
    then Json.fail Invalid_argument "invalid upload digest";
    match Map.find t.entries id with
    | Some _ ->
      let entry = find t id actor in
      if not (Int.equal entry.size_bytes size_bytes && String.equal entry.digest digest)
      then Json.fail Conflict "upload ID reused with different metadata";
      response id entry
    | None ->
      let reserved =
        Map.fold t.entries ~init:0 ~f:(fun ~key:_ ~data total ->
          total + data.Entry.size_bytes)
      in
      if Map.length t.entries >= Admission.Limit.maximum Active_uploads
      then
        raise
          (Json.Decode_error
             (Admission.refusal
                Active_uploads
                ~used:(Map.length t.entries)
                ~attempted:(Map.length t.entries + 1)
                ~kind:Invalid_argument));
      if reserved + size_bytes > Admission.Limit.maximum Reserved_upload_bytes
      then
        raise
          (Json.Decode_error
             (Admission.refusal
                Reserved_upload_bytes
                ~used:reserved
                ~attempted:(reserved + size_bytes)
                ~kind:Invalid_argument));
      Disk.ensure_directory t.directory;
      (match Eio.Path.kind ~follow:false (path t id) with
       | `Not_found -> ()
       | _ -> Json.fail Conflict "staged upload exists; abort it or choose a new ID");
      Disk.write_new (path t id) "";
      let entry = { Entry.actor; size_bytes; digest; received = 0; installed = false } in
      t.entries <- Map.set t.entries ~key:id ~data:entry;
      response id entry)
;;

let status t ~id ~actor = Disk.protect (fun () -> response id (find t id actor))

let chunk t ~id ~actor ~offset ~bytes =
  Disk.protect (fun () ->
    let entry = find t id actor in
    if entry.installed
    then Json.fail Conflict "upload already installed; retry finish or abort";
    let length = String.length bytes in
    if
      length = 0
      || length > max_chunk_bytes
      || offset < 0
      || offset > entry.size_bytes - length
    then Json.fail Invalid_argument "invalid upload chunk bounds";
    if offset < entry.received
    then (
      if offset + length > entry.received
      then Json.fail Conflict "chunk partially overlaps received bytes";
      let previous, _ = Blob.read_range (path t id) ~offset ~length |> Disk.unwrap in
      if not (String.equal previous bytes) then Json.fail Conflict "retried chunk differs";
      response id entry)
    else (
      if offset <> entry.received then Json.fail Conflict "chunk offset is not contiguous";
      (match Eio.Path.kind ~follow:false (path t id) with
       | `Regular_file -> ()
       | _ -> Json.fail Corrupt_store "invalid upload file");
      Eio.Path.with_open_out ~create:`Never (path t id) (fun file ->
        Eio.File.pwrite_all
          file
          ~file_offset:(Optint.Int63.of_int offset)
          [ Cstruct.of_string bytes ]);
      let entry = { entry with received = offset + length } in
      t.entries <- Map.set t.entries ~key:id ~data:entry;
      response id entry))
;;

let finish t ~id ~actor ~blobs =
  Disk.protect (fun () ->
    let entry = find t id actor in
    if entry.received <> entry.size_bytes then Json.fail Conflict "upload is incomplete";
    let target = Eio.Path.(blobs / entry.digest) in
    if not entry.installed
    then (
      let verify path kind message =
        let digest, size_bytes = Blob.inspect path |> Disk.unwrap in
        if not (String.equal digest entry.digest && Int.equal size_bytes entry.size_bytes)
        then Json.fail kind message
      in
      (match Eio.Path.kind ~follow:false (path t id) with
       | `Regular_file ->
         verify (path t id) Invalid_argument "upload checksum or size mismatch";
         Eio.Path.with_open_out ~create:`Never (path t id) Eio.File.sync;
         (match Eio.Path.kind ~follow:false target with
          | `Not_found -> Eio.Path.rename (path t id) target
          | `Regular_file ->
            verify target Corrupt_store "existing blob is corrupt";
            Eio.Path.unlink (path t id)
          | _ -> Json.fail Corrupt_store "invalid blob path")
       | `Not_found ->
         (* A previous attempt may have renamed successfully before directory
            sync failed. Reverify and sync its destination before acknowledging. *)
         verify target Corrupt_store "installed upload is missing or corrupt"
       | _ -> Json.fail Corrupt_store "invalid upload path");
      Eio.Path.with_open_out ~create:`Never target Eio.File.sync;
      Platform.sync_directory blobs;
      Platform.sync_directory t.directory;
      t.entries <- Map.set t.entries ~key:id ~data:{ entry with installed = true });
    entry.digest, entry.size_bytes)
;;

let abort t ~id ~actor =
  Disk.protect (fun () ->
    Option.iter (Map.find t.entries id) ~f:(fun _ -> ignore (find t id actor : Entry.t));
    (match Eio.Path.kind ~follow:false (path t id) with
     | `Not_found -> ()
     | `Regular_file ->
       Eio.Path.unlink (path t id);
       Platform.sync_directory t.directory
     | _ -> Json.fail Corrupt_store "invalid upload path");
    t.entries <- Map.remove t.entries id)
;;

let forget t ~id = t.entries <- Map.remove t.entries id

let admission t =
  [ Admission.create Active_uploads ~used:(Map.length t.entries) |> Disk.unwrap
  ; Admission.create
      Reserved_upload_bytes
      ~used:
        (Map.fold t.entries ~init:0 ~f:(fun ~key:_ ~data total ->
           total + data.Entry.size_bytes))
    |> Disk.unwrap
  ]
;;
