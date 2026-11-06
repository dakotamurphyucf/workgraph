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

  (** Membership in the verified ancestor chain; no filesystem access. *)
  val contains_head : t -> string option -> bool

  (** Retained canonical batch bytes, used as a cache admission weight; this is
      not an estimate of OCaml heap size. *)
  val metadata_bytes : t -> int

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

(** Worker-owned last committed in-memory ancestor, readable even when fenced.
    Used for close/recovery baselines and comparing publication before/after a
    serialized history mutation. Does not verify current disk state or authorize
    writes; an unchanged head also identifies exact receipt retries. *)
val last_committed_head : t -> string option

(** On the persistence owner, check open/fenced state and capture exact journal
    admission counters. Independent from planning transaction revisions. *)
val admission : t -> (Admission.t list, Problem.t) Result.t

(** Worker-owned last committed counters, without filesystem probing. A fenced
    owner rejects; reads do not validate external directory/head changes. Advisory
    health only; commit/open retain authoritative integrity/admission checks. *)
val cached_admission : t -> (Admission.t list, Problem.t) Result.t

val capture : t -> (Capture.t, Problem.t) Result.t
val capture_at : t -> head:string option -> (Capture.t, Problem.t) Result.t

(** Resolve an ancestor of an immutable capture without accessing the mutable
    journal owner. The caller must pin the root against close/restore throughout
    this operation. Current/empty captures require no replay; older heads verify
    their complete durable chain and blobs on the calling read worker. *)
val resolve_capture
  :  Capture.t
  -> fs:Eio.Fs.dir_ty Eio.Path.t
  -> root:string
  -> head:string option
  -> (Capture.t, Problem.t) Result.t

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
    [now_unix_ms] is a nonnegative server observation in epoch milliseconds,
    persisted with this batch. New events update session last-event time; a
    dedup-only batch or exact retry preserves it. Omission records unknown time
    for migrated/library inputs. Success includes durable:true and the session
    sequence watermark. *)
val append
  :  t
  -> session:Session_id.t
  -> actor:Id.Actor.t
  -> ?run:Id.Run.t
  -> ?now_unix_ms:int64
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
