open Core

(** Single-domain, serialized preparation and status owner. No callback is called
    under a cross-domain lock. The root guard must outlive this store. *)
type t

type prepared

val create
  :  root:State_root.t
  -> random:_ Eio.Flow.source
  -> (t, Workgraph.Problem.t) Result.t

(** Match complete input before calling materialize. An identical intention
    returns its original operation; conflicting reuse rejects. Fresh durable
    request and intention mapping are synced before returning. A request orphan
    is retained for journal inspection, never automatically adopted. *)
val prepare
  :  t
  -> Operation.Preparation.t
  -> materialize:(unit -> (Workgraph.Protocol.Request.t, Workgraph.Problem.t) Result.t)
  -> (prepared, Workgraph.Problem.t) Result.t

val operation : prepared -> Operation.t
val inspect : t -> id:Operation.Id.t -> (Operation.t, Workgraph.Problem.t) Result.t
val list : t -> offset:int -> limit:int -> (Jsonaf.t, Workgraph.Problem.t) Result.t

(** Publish and sync the monotone Sending barrier before any exchange. Only
    Prepared_unsent may enter ordinarily. Retry is explicit and accepts only
    Outcome_unknown (or the known nondurable empty allocation observation).
    A barrier sync error never permits exchange or restoring an unsent state. *)
val admit
  :  t
  -> id:Operation.Id.t
  -> retry:bool
  -> (Operation.t, Workgraph.Problem.t) Result.t

(** Retain observed in-memory outcome even if persistence fails, returning it
    with a persistence diagnostic. Cancellation/unexpected failures propagate;
    the durable Sending barrier remains recoverably uncertain. *)
val record : t -> Operation.t -> Operation.t

val journal_entry
  :  t
  -> Operation.t
  -> (Workgraph.Request_journal.Entry.t, Workgraph.Problem.t) Result.t
