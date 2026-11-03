open Core

(** Reuses transaction.apply decoding, alias resolution and State.prepare against
    one immutable snapshot. It never commits events, blobs or receipts, acquires
    durable ownership, executes an external command or mutates the supplied state.
    [fresh] supplies provisional IDs, with the same format/collision requirements
    as live ID generation. Generated IDs and the proposed revision are unreserved;
    applying later must repeat every authoritative check. Expected preparation
    failures retain their typed Problem; cancellation/unexpected errors propagate. *)
val run
  :  State.t
  -> Preflight_api.Request.t
  -> fresh:(Id_resolution.Kind.t -> string)
  -> now_unix_ms:int64
  -> timestamp:string
  -> (Preflight_api.Response.t, Problem.t) Result.t
