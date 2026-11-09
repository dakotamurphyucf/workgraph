open Core

type t

val create
  :  sw:Eio.Switch.t
  -> net:_ Eio.Net.t
  -> clock:_ Eio.Time.Mono.t
  -> random:_ Eio.Flow.source
  -> store:Operation_store.t
  -> scheduler:Read_scheduler.t
  -> t

(** Descriptor Read only, enforced before I/O. Each call independently qualifies
    the daemon package before its semantic request, including retained profiles;
    attachment never caches compatibility. Full method result and exact
    continuation metadata are validated; original daemon data/meta is retained. *)
val read
  :  t
  -> connection:Connection_profile.t
  -> lane:Read_scheduler.Lane.t
  -> Workgraph.Protocol.Request.t
  -> (Jsonaf.t, Workgraph.Problem.t) Result.t

(** New materialization qualifies the daemon before generating a missing durable
    identity, only after store deduplication. An existing identical preparation
    remains locally inspectable without contacting its daemon. Ephemeral writes
    retain their immutable preparation context. *)
val prepare
  :  t
  -> Operation.Preparation.t
  -> (Operation_store.prepared, Workgraph.Problem.t) Result.t

(** Nonblocking companion-owned task. Ordinary repeated execute while Sending
    coalesces; it never sends twice. HTTP caller cancellation detaches only its
    observation. At most 64 distinct service-owned write tasks may be pending;
    capacity rejection occurs before admission and leaves a new preparation
    unsent. Existing tasks still coalesce at capacity. Retry is explicit and
    never regenerates request bytes/guards. Qualification belongs to that service
    task and precedes admission: failure leaves a new preparation unsent and a
    previously uncertain operation unknown, with its original exact request. *)
val execute
  :  t
  -> id:Operation.Id.t
  -> retry:bool
  -> (Operation.t, Workgraph.Problem.t) Result.t

val recover : t -> id:Operation.Id.t -> (Operation.t, Workgraph.Problem.t) Result.t
