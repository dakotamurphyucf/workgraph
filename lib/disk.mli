open Core

val protect : (unit -> 'a) -> ('a, Problem.t) Result.t
val unwrap : ('a, Problem.t) Result.t -> 'a
val absolute : string -> unit
val read : _ Eio.Path.t -> string
val read_with_limit : _ Eio.Path.t -> max_bytes:int -> string
val write_new : _ Eio.Path.t -> string -> unit
val replace : _ Eio.Path.t -> string -> unit
val ensure_directory : _ Eio.Path.t -> unit

(** Reject missing directories, symlinks and other entry kinds. Raises
    Json.Decode_error Corrupt_store; callers normally use [protect]. *)
val require_directory : _ Eio.Path.t -> unit
