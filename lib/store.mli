open Core

type t

type receipt =
  { request_hash : string
  ; response : Jsonaf.t
  }

(** An opened store exclusively owns its workspace directory until [close].
    All operations on a store run on the persistence domain. Paths are absolute.
    Canonical data directories must be real directories, including on later
    guarded operations; replacement by symlinks fences the opened store.
    An unsuccessful or canceled open releases its writer lock before returning
    or propagating the exception.
    [create] requires a nonexistent root with an existing parent, or an installed
    root bearing the same private creation marker. Its secure token must already
    belong to a synced registry intent. Only that token's staging tree is resumed;
    installed workspace content is never rewritten by a retry. *)
val create
  :  fs:Eio.Fs.dir_ty Eio.Path.t
  -> root:string
  -> workspace:Id.Workspace.t
  -> name:string
  -> creation_token:string
  -> (unit, Problem.t) Result.t

val open_existing
  :  sw:Eio.Switch.t
  -> fs:Eio.Fs.dir_ty Eio.Path.t
  -> root:string
  -> (t * State.t, Problem.t) Result.t

val close : t -> unit

(** Process-local cache identity, changes on every open; never persisted. *)
val cache_generation : t -> int

val root : t -> string
val head : t -> string option

(** Last committed cached journal ancestor; available for closing a fenced store. *)
val known_history_head : t -> string option

(** Checks the verified authoritative chain held by this opened store; orphan
    transaction files cannot establish ancestry. Linear in retained transactions. *)
val has_ancestor : t -> digest:string -> bool

val receipt : t -> key:string -> receipt option
val lookup_receipt : t -> key:string -> (receipt option, Problem.t) Result.t

(** [prepared] must come from this store's latest recovered/published state.
    Rejects a different workspace/revision, invalid receipt identity, or duplicate
    receipt before publication. The dispatcher owns pairing the exact immutable
    state root with this store; arbitrary same-revision forks are not merge inputs.
    Cancellation propagates. Once HEAD publication begins, any interrupted attempt
    fences the store until close/recovery, including cancellation after rename. *)
val commit
  :  t
  -> prepared:State.prepared
  -> key:string
  -> request_hash:string
  -> (Jsonaf.t, Problem.t) Result.t

val read_blob : t -> digest:string -> (string, Problem.t) Result.t

val read_blob_range
  :  t
  -> digest:string
  -> offset:int
  -> length:int
  -> (string * int, Problem.t) Result.t

(** Private upload state is owned by this store's worker domain. Publication uses
    [commit] after [finish_upload] installs verified bytes. Finish can be retried
    until the durable receipt is returned; [forget_upload] then drops local state. *)
val begin_upload
  :  t
  -> id:Id.Upload.t
  -> actor:Id.Actor.t
  -> size_bytes:int
  -> digest:string
  -> (Jsonaf.t, Problem.t) Result.t

val upload_chunk
  :  t
  -> id:Id.Upload.t
  -> actor:Id.Actor.t
  -> offset:int
  -> bytes:string
  -> (Jsonaf.t, Problem.t) Result.t

val upload_status
  :  t
  -> id:Id.Upload.t
  -> actor:Id.Actor.t
  -> (Jsonaf.t, Problem.t) Result.t

val abort_upload : t -> id:Id.Upload.t -> actor:Id.Actor.t -> (unit, Problem.t) Result.t

val finish_upload
  :  t
  -> id:Id.Upload.t
  -> actor:Id.Actor.t
  -> (string * int, Problem.t) Result.t

val forget_upload : t -> id:Id.Upload.t -> unit

(** Current text versions only: at most 32 files, 64KiB per file and 1MiB total.
    Never caches body bytes in authoritative state. Invalid UTF-8 is reported. *)
val extract_search_texts
  :  t
  -> resources:Resource.t list
  -> (Search.Text.t list, Problem.t) Result.t

val export : t -> state:State.t -> destination:string -> (Jsonaf.t, Problem.t) Result.t
val capture : t -> state:State.t -> (Snapshot.t, Problem.t) Result.t

(** Rebuild an earlier revision from this store's verified authoritative chain.
    Used to retry interrupted exports without changing their captured identity. *)
val capture_at : t -> revision:int -> (Snapshot.t, Problem.t) Result.t

(** Guarded access on the persistence owner.
    The callback must not retain the mutable journal outside this operation. *)
val with_history
  :  t
  -> f:(Session_store.t -> ('a, Problem.t) Result.t)
  -> ('a, Problem.t) Result.t

val history_capture : t -> (Session_store.Capture.t, Problem.t) Result.t

val capture_at_history
  :  t
  -> revision:int
  -> history_head:string option
  -> (Snapshot.t, Problem.t) Result.t

(** Advisory liveness observations never renew durable ownership. *)
val heartbeat
  :  t
  -> run:Id.Run.t
  -> actor:Id.Actor.t
  -> now_unix_ms:int64
  -> (Jsonaf.t, Problem.t) Result.t

val heartbeat_get : t -> run:Id.Run.t -> (Jsonaf.t, Problem.t) Result.t
val flush_heartbeats : t -> (unit, Problem.t) Result.t
val heartbeat_observations : t -> ((Id.Run.t * int64) list, Problem.t) Result.t
