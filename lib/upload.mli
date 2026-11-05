open Core

type t

(** Owned and accessed exclusively by the persistence worker. Uploads are private,
    bounded staging files. Chunks are contiguous; identical retries are accepted.
    Upload acknowledgement is not a durable workspace publication. On restart,
    abandoned .part files are discarded while holding the workspace writer lock. *)
val create : directory:Eio.Fs.dir_ty Eio.Path.t -> t

val begin_upload
  :  t
  -> id:Id.Upload.t
  -> actor:Id.Actor.t
  -> now_unix_ms:int64
  -> size_bytes:int
  -> digest:string
  -> (Jsonaf.t, Problem.t) Result.t

val chunk
  :  t
  -> id:Id.Upload.t
  -> actor:Id.Actor.t
  -> now_unix_ms:int64
  -> offset:int
  -> bytes:string
  -> (Jsonaf.t, Problem.t) Result.t

val status : t -> id:Id.Upload.t -> actor:Id.Actor.t -> (Jsonaf.t, Problem.t) Result.t

(** Complete ID-ordered ephemeral snapshot, bounded to eight entries. Includes
    every actor's staging identity, epoch-ms creation/update times, progress and
    receiving/ready/installed lifecycle. No idle expiry: explicit owner abort or
    daemon restart removes abandoned staging. Bytes remain actor-private. *)
val list : t -> now_unix_ms:int64 -> Jsonaf.t

val abort : t -> id:Id.Upload.t -> actor:Id.Actor.t -> (unit, Problem.t) Result.t

(** Verify and sync all bytes, then install in the digest store. Repeatable while
    this upload remains live. The caller must still commit resource metadata;
    an unreferenced installed blob is an orphan, not a published version. *)
val finish
  :  t
  -> id:Id.Upload.t
  -> actor:Id.Actor.t
  -> blobs:Eio.Fs.dir_ty Eio.Path.t
  -> (string * int, Problem.t) Result.t

val forget : t -> id:Id.Upload.t -> unit
val max_chunk_bytes : int

(** Worker-owned snapshot of active entries and reserved declared byte sizes.
    Completed-but-not-forgotten uploads continue to count. *)
val admission : t -> Admission.t list
