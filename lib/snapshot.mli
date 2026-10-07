open Core

type t

(** Immutable committed capture. Transactions are the already verified chain,
    newest first. The owner must keep [source_root] open/pinned until writing ends;
    this value retains immutable state/bytes, never a mutable Store.t reference. *)
val create
  :  state:State.t
  -> source_root:string
  -> descriptor:string
  -> head_bytes:string
  -> transactions:(string * string) list
  -> (t, Problem.t) Result.t

(** Add a frozen history capture; the enclosing source root remains pinned. *)
val with_history : t -> Session_store.Capture.t -> (t, Problem.t) Result.t

val history_head : t -> string option
val workspace : t -> Id.Workspace.t
val revision : t -> int
val head : t -> string option

(** Render a full deterministic snapshot to a fresh staging directory. Invoke
    [check_cancelled] between files; [before_publish] must atomically reject
    cancellation or claim publication. Sync every file before the final rename. *)
val write
  :  t
  -> fs:_ Eio.Path.t
  -> destination:string
  -> stage:string
  -> check_cancelled:(unit -> unit)
  -> before_publish:(unit -> unit)
  -> (Jsonaf.t, Problem.t) Result.t

module Verified : sig
  type t

  val manifest : t -> Jsonaf.t
  val workspace : t -> Id.Workspace.t
  val revision : t -> int
  val head : t -> string option
  val history_head : t -> string option
end

(** Verify all listed files and reject missing/extra files, unsafe names, symlinks,
    partial exports or inconsistent descriptor/head metadata. Accepts only the complete current format. Limits: 64MiB manifest, 500k files/directories,
    1GiB per projection, 4GiB aggregate. Canonical transaction/domain validation is
    separately required when restoring, through Store.open_existing. *)
val verify : fs:_ Eio.Path.t -> directory:string -> (Verified.t, Problem.t) Result.t

(** Compare the portable inventory against a replayed store capture. Rejects
    extra transactions/blobs as well as missing canonical data. *)
val validate_canonical : Verified.t -> snapshot:t -> (unit, Problem.t) Result.t

(** Copy only canonical portable data into a fresh staging root. Rehash each copied
    file against the verified manifest; never copy private .local files. Caller
    must recover/validate that staging workspace before publishing it. *)
val copy_portable
  :  Verified.t
  -> fs:_ Eio.Path.t
  -> destination:string
  -> (unit, Problem.t) Result.t
