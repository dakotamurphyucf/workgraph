open Core

let max_bytes = 4 * 1024 * 1024

let read flow =
  let header = Cstruct.create 4 in
  Eio.Flow.read_exact flow header;
  let n = Cstruct.BE.get_uint32 header 0 |> Int32.to_int_exn in
  if n <= 0 || n > max_bytes then Json.fail Invalid_argument "frame length out of bounds";
  let body = Cstruct.create n in
  Eio.Flow.read_exact flow body;
  Json.parse (Cstruct.to_string body) |> Disk.unwrap
;;

let write flow value =
  let bytes = Json.canonical value in
  let n = String.length bytes in
  if n > max_bytes
  then Json.fail Invalid_argument "response exceeds frame limit; reduce query limit";
  let header = Cstruct.create 4 in
  Cstruct.BE.set_uint32 header 0 (Int32.of_int_exn n);
  Eio.Flow.write flow [ header; Cstruct.of_string bytes ]
;;
