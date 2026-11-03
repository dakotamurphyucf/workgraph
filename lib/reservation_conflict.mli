open Core

(** Token-free reservation diagnostics, below Problem in the dependency graph. *)
module Path_kind : sig
  type t =
    | File
    | Subtree
  [@@deriving sexp, equal]
end

module Mode : sig
  type t =
    | Exclusive
    | Shared
  [@@deriving sexp, equal]
end

module Target : sig
  type t =
    | Named of string
    | Path of
        { worktree_id : string
        ; kind : Path_kind.t
        ; path : string
        }
  [@@deriving sexp, equal]

  val to_json : t -> Jsonaf.t
end

module Owner : sig
  type t =
    { target : Target.t
    ; actor_id : string
    ; run_id : string
    ; mode : Mode.t
    }
  [@@deriving sexp, equal]

  val to_json : t -> Jsonaf.t
end

(** At most 16 owners; exact total is listed plus omitted. No lease, claim or
    reservation fence is exposed. Path and owner filters are typed at the wire. *)
type t =
  { requested : Target.t
  ; owners : Owner.t list
  ; omitted_owners : int
  }
[@@deriving sexp, equal]

val to_json : t -> Jsonaf.t
