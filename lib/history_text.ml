open Core

let validate path =
  Disk.protect (fun () ->
    (match Eio.Path.kind ~follow:false path with
     | `Regular_file -> ()
     | _ -> Json.fail Corrupt_store "searchable text requires regular blob");
    Eio.Path.with_open_in path (fun file ->
      let buffer = Cstruct.create (256 * 1024) in
      let decoder = Uutf.decoder ~encoding:`UTF_8 `Manual in
      let rec loop () =
        match Uutf.decode decoder with
        | `End -> ()
        | `Malformed _ ->
          Json.fail Invalid_argument "searchable text must be complete UTF-8"
        | `Uchar _ -> loop ()
        | `Await ->
          let count =
            try Eio.Flow.single_read file buffer with
            | End_of_file -> 0
          in
          let bytes = Bytes.of_string (Cstruct.to_string (Cstruct.sub buffer 0 count)) in
          Uutf.Manual.src decoder bytes 0 count;
          loop ()
      in
      loop ()))
;;
