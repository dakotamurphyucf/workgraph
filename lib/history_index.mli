open Core

type t

(** Rebuildable disk-backed lexical documents, one immutable file per event
    under .local/history-index/<identity_hash>. Search streams <=256KiB chunks
    with overlap; full searchable text is indexed, including beyond 64KiB.
    One worker owns t. Source journal/blobs remain authoritative. *)
val create : fs:Eio.Fs.dir_ty Eio.Path.t -> root:string -> t

val rebuild : t -> Session_store.Capture.t -> (unit, Problem.t) Result.t

(** Fixed upper vector captured by caller. Continuation is session/sequence;
    concurrent appends outside capture do not change results. Kinds filter event
    kinds explicitly. Response discloses index watermark, omissions and source
    events with no searchable text. An incomplete empty result is not absence.
    Search query <=256 bytes; result budget 4KiB..1MiB, limit 1..100. *)
val search
  :  t
  -> Session_store.Capture.t
  -> text:string
  -> ?session:Session_id.t
  -> ?kinds:string list
  -> ?after:Session.Event_ref.t
  -> limit:int
  -> max_bytes:int
  -> unit
  -> (Jsonaf.t, Problem.t) Result.t
