open Core

(** A bounded observation of a Git working tree, not a filesystem snapshot or an
    assertion about what a command read. Tracks file content, executable mode,
    deletions, untracked nonignored files and symlink target bytes. Git-ignored
    files, repository metadata and submodule contents are not covered. Different
    before/after identities prove observed drift; equal identities cannot rule
    out intervening changes (ABA), concurrent edits or external inputs. The default
    worktree scope excludes ignored files; explicitly selected paths include them. *)
type t

module Scope : sig
  type t

  val worktree : t

  (** 1..256 distinct canonical root-relative file paths, aggregate <=64KiB.
      No absolute paths, empty/dot/parent components, NUL or Git metadata.
      Sorted identity binds this exact set, including explicitly selected ignored
      files. Directories/submodule contents are not recursively included. *)
  val paths : string list -> (t, Problem.t) Result.t

  val selected_paths : t -> string list option
  val equal : t -> t -> bool
  val codec : t Api_codec.t
end

val not_requested : t
val unavailable : root:string -> reason:string -> (t, Problem.t) Result.t

val unavailable_for_scope
  :  Scope.t
  -> root:string
  -> reason:string
  -> (t, Problem.t) Result.t

val codec : t Api_codec.t

(** Explicit root must identify the Git working-tree root. Up to 10,000 listed
    paths, 8MiB per regular file and 64MiB total bytes are hashed. Git enumeration
    is bounded to 4MiB and the complete observation to 10 seconds. Symlinks are
    not followed; paths through symlink ancestors and submodules are omissions.
    Counts and omission reasons are retained even when the observation is partial.
    Expected I/O/Git failures yield unavailable provenance; cancellation and
    unexpected exceptions propagate. Does not change Git state or invoke a shell. *)
val capture : env:Eio_unix.Stdenv.base -> root:string -> t

val capture_scope : Scope.t -> env:Eio_unix.Stdenv.base -> root:string -> t
val scope : t -> Scope.t option

(** Compact explicit scope, hashed/listed counts and omissions/unavailability.
    A selected identity covers only its declared set. HEAD is contextual and
    does not change selected-set identity when unrelated files/commits change. *)
val coverage : t -> Jsonaf.t

(** Some identity only for a complete observation of the declared input set;
    missing/partial provenance must not imply unchanged input. *)
val identity : t -> string option

val root : t -> string option
val drift : before:t -> after:t -> bool option
