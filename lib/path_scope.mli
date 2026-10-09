open Core
module Worktree_id = Coordination_id.Worktree

module Kind : sig
  type t =
    | File
    | Subtree
  [@@deriving sexp, equal]
end

(** Logical, case-sensitive path namespace within an explicit worktree identity.
    Slash-separated relative UTF8 paths only; reject absolute paths, '..', NUL,
    backslashes and control characters, and glob metacharacters. Normalize repeated '/', '.' components
    and trailing '/'. Root '.' is permitted only for a subtree. No globs.
    No filesystem lookup or symlink following occurs. Symlink/hardlink aliases
    and case-folding aliases are outside the cooperative namespace: callers must use one canonical lexical
    name per physical target and must not declare paths through symlinks. *)
type t [@@deriving sexp, compare, equal]

include Comparable.S with type t := t

val create
  :  worktree_id:Worktree_id.t
  -> kind:Kind.t
  -> path:string
  -> (t, Problem.t) Result.t

val worktree_id : t -> Worktree_id.t
val kind : t -> Kind.t
val path : t -> string
val overlaps : t -> t -> bool
val covers : t -> t -> bool
val codec : t Api_codec.t

(** Durable encoding uses canonical targets; unlike the public request codec,
    durable decoding rejects a path that would need normalization. *)
val jsonaf_of_t : t -> Jsonaf.t

val t_of_jsonaf : Jsonaf.t -> t
