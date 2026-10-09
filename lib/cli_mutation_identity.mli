open Core

(** CLI durable mutation methods, including local resource.upload. Read-only and
    non-mutation write methods do not require mutation identity. *)
val required : Protocol.Request.t -> bool

(** Preserve the request and any supplied identity. If a required identity is
    absent, generate one only when [allow_generate] is true. The caller must sync
    the complete resulting request before transmitting any generated identity.
    Request ID and every supplied field are preserved; cancellation propagates. *)
val ensure
  :  Protocol.Request.t
  -> random:_ Eio.Flow.source
  -> allow_generate:bool
  -> (Protocol.Request.t, Problem.t) Result.t
