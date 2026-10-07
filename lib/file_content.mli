open Core

(** Streaming regular-file IO with explicit byte limits, no symlinks, and at most
    256KiB scratch buffers. Limits must be positive and at most 1GiB. Expected IO
    errors use Results; external cancellation propagates. Copy creates a fresh
    destination, syncing bytes and the parent directory. *)
val inspect : _ Eio.Path.t -> max_bytes:int -> (string * int, Problem.t) Result.t

val copy
  :  _ Eio.Path.t
  -> dst:_ Eio.Path.t
  -> max_bytes:int
  -> (string * int, Problem.t) Result.t

val read_range
  :  _ Eio.Path.t
  -> max_bytes:int
  -> offset:int
  -> length:int
  -> (string * int, Problem.t) Result.t
