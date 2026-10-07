open Core

(** Worker-domain streaming operations. Verify bounded regular files, rejecting
    symlinks. No operation retains full blob bytes; scratch buffers are <=256KiB.
    Expected filesystem/validation errors use Results and preserve cancellation. *)
val inspect : _ Eio.Path.t -> (string * int, Problem.t) Result.t

val read_range
  :  _ Eio.Path.t
  -> offset:int
  -> length:int
  -> (string * int, Problem.t) Result.t

val copy : _ Eio.Path.t -> dst:_ Eio.Path.t -> (string * int, Problem.t) Result.t
