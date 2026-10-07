open Core

type t

(** Advisory liveness cache under .local, owned by the persistence worker.
    It is not ownership, never renews a lease, and is excluded from portable
    workspace history. Coalesced observations may be lost on abrupt shutdown;
    responses disclose the last durable observation. At most 1000 runs. *)
val open_existing : fs:Eio.Fs.dir_ty Eio.Path.t -> root:string -> (t, Problem.t) Result.t

val observe
  :  t
  -> run:Id.Run.t
  -> actor:Id.Actor.t
  -> now_unix_ms:int64
  -> (Jsonaf.t, Problem.t) Result.t

val get : t -> run:Id.Run.t -> (Jsonaf.t, Problem.t) Result.t
val flush : t -> (unit, Problem.t) Result.t
val observations : t -> (Id.Run.t * int64) list
