open Core

(** One single-domain owner and one lifetime exclusive guard per canonical private
    root. The permanent regular guard is never unlinked. Acquiring aliases of an
    occupied root returns Conflict. Cancellation and unexpected failures propagate. *)
type t

val acquire
  :  sw:Eio.Switch.t
  -> fs:Eio.Fs.dir_ty Eio.Path.t
  -> random:_ Eio.Flow.source
  -> path:string
  -> (t, Workgraph.Problem.t) Result.t

val path : t -> string
val directory : t -> Eio.Fs.dir_ty Eio.Path.t
val journal_directory : t -> string

(** Basenames only; no traversal or symlinks. A missing document is None, while
    malformed/unreadable state is an error, never absence. At most 32MiB per file;
    opaque saved JSON is stored as text to preserve native wire depth bounds. *)
val read : t -> name:string -> (Jsonaf.t option, Workgraph.Problem.t) Result.t

val names : t -> (string list, Workgraph.Problem.t) Result.t

(** Atomic synchronized replacement of one private metadata document; file and
    parent are synced before success. A post-install sync failure is uncertainty,
    not permission to transmit or roll back an admitted-to-send barrier. *)
val save : t -> name:string -> value:Jsonaf.t -> (unit, Workgraph.Problem.t) Result.t
