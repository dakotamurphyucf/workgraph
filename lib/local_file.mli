open Core

(** Interpret expected local filesystem failures only around a local operation.
    Missing/non-directory paths and exclusive destination collisions produce
    Invalid_argument; other Eio/Unix I/O failures produce Local_io. Diagnostics
    identify operation and path. Existing typed errors, cancellation and unexpected
    exceptions propagate unchanged. Never wrap daemon mutation execution here. *)
val protect : operation:string -> path:string -> (unit -> 'a) -> ('a, Problem.t) Result.t

(** Bounded regular-file input, rejecting links, pipes/devices and missing files
    before opening. At most 4 MiB; oversize/growing input is Invalid_argument.
    Raises Json.Decode_error for expected failures; cancellation propagates. *)
val read : _ Eio.Path.t -> operation:string -> string

val require_directory : _ Eio.Path.t -> operation:string -> unit

(** Exclusive local file creation with file and parent durability before return.
    Existing destinations reject as Invalid_argument and are never overwritten. *)
val write_new : _ Eio.Path.t -> operation:string -> string -> unit

(** Atomically publish a local file without replacement. An existing destination
    is Invalid_argument with operation/path; durability syncing is caller-owned. *)
val link_exclusive : src:_ Eio.Path.t -> dst:_ Eio.Path.t -> operation:string -> unit
