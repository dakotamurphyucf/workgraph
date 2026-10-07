open Core

(** Validate complete UTF-8 from a regular immutable blob using <=256KiB
    buffers. Cancellation propagates and malformed text is Invalid_argument. *)
val validate : _ Eio.Path.t -> (unit, Problem.t) Result.t
