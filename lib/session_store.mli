open Core

type t

module Capture : sig
  type t

  (** Immutable capture owns metadata and verified file inventory, never store
      mutation. Owner pins the enclosing Store root throughout export/read. *)
  val workspace : t -> Id.Workspace.t

  val head : t -> string option
  val head_bytes : t -> string
  val sequence : t -> int
  val sessions : t -> Session.t list
  val upper_bound : t -> session:Session_id.t -> int
  val events : t -> session:Session_id.t -> Session_event.t list
  val event : t -> Session.Event_ref.t -> (Session_event.t, Problem.t) Result.t
  val portable_files : t -> (string * string * int) list

  (** Durable journal audit metadata, newest first. Contains sequence bounds and
      captured scopes and each verified batch digest, never transcript/payload
      bytes. The digest binds feed lineage to exact committed content.
      Timestamp is empty when
      the journal did not record one; actor comes from actor-scoped receipt key. *)
  val activity : t -> Jsonaf.t list

  val to_json : t -> Jsonaf.t
end

(** Only the persistence owner holding Store's exclusive root lock may open/use
    this module. Missing history denotes the empty current history. A failed write
    fences further operations; reopen recovers authoritative HEAD and ignores
    orphan batches. Canonical history/blob directories cannot be symlinks.
    Cancellation propagates. No planning transaction is consumed. *)
val open_existing
  :  fs:Eio.Fs.dir_ty Eio.Path.t
  -> root:string
  -> workspace:Id.Workspace.t
  -> (t, Problem.t) Result.t

(** Last committed in-memory ancestor, readable even when fenced, solely for
    recording a close/recovery baseline. Does not verify current disk state. *)
val last_committed_head : t -> string option

val capture : t -> (Capture.t, Problem.t) Result.t
val capture_at : t -> head:string option -> (Capture.t, Problem.t) Result.t
val get : t -> session:Session_id.t -> (Session.t, Problem.t) Result.t

val create
  :  t
  -> Session.t
  -> key:string
  -> request_hash:string
  -> (Jsonaf.t, Problem.t) Result.t

val archive
  :  t
  -> session:Session_id.t
  -> key:string
  -> request_hash:string
  -> (Jsonaf.t, Problem.t) Result.t

(** 1..128 events, <=16MiB inline bytes; entire batch committed atomically.
    Same client ID/content is deduplicated across batches; changed content fails.
    Actor-scoped key and request_hash provide exact lost-acknowledgement retries.
    Success includes durable:true and the session sequence watermark. *)
val append
  :  t
  -> session:Session_id.t
  -> actor:Id.Actor.t
  -> ?run:Id.Run.t
  -> inputs:Session_event.Input.t list
  -> key:string
  -> request_hash:string
  -> unit
  -> (Jsonaf.t, Problem.t) Result.t

val lookup_receipt
  :  t
  -> key:string
  -> request_hash:string
  -> (Jsonaf.t option, Problem.t) Result.t

val read_blob_range
  :  t
  -> Session_event.Blob_ref.t
  -> offset:int
  -> length:int
  -> (string * int, Problem.t) Result.t

(** Range reader for worker-owned immutable captures; validates identity first. *)
val read_capture_blob
  :  Capture.t
  -> fs:_ Eio.Path.t
  -> root:string
  -> Session_event.Blob_ref.t
  -> offset:int
  -> length:int
  -> (string * int, Problem.t) Result.t
