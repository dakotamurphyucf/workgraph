open Core

(** Explicit scheduling/completion policy, independent of acceptance evidence,
    ownership and process state. Defaults preserve flat-plan behavior. *)
module Descendant_prerequisites : sig
  type t =
    | Independent
    | Inherit
  [@@deriving sexp, equal]

  val codec : t Api_codec.t
end

module Child_completion : sig
  type t =
    | All_done
    | Done_or_canceled
  [@@deriving sexp, equal]

  val codec : t Api_codec.t

  (** Only a parent's child-completion gate uses this predicate. Prerequisites
      still require [Done], unless their own source edge has an explicit waiver. *)
  val satisfied : t -> status:Workflow.Category.t -> bool
end

type t =
  { descendant_prerequisites : Descendant_prerequisites.t
  ; child_completion : Child_completion.t
  }
[@@deriving sexp, equal]

val default : t
val codec : t Api_codec.t

module Definition : sig
  (** Positive policy revision, exact ticket identity and nonblank audit reason
      of at most 64KiB UTF-8. Policy revision is independent of ticket revision.
      Policy edits do not clear claims or retroactively reopen completed work. *)
  type policy := t

  type t [@@deriving sexp, equal]

  val create
    :  ticket:Id.Ticket.t
    -> revision:int
    -> policy:policy
    -> reason:string
    -> (t, Problem.t) Result.t

  val ticket : t -> Id.Ticket.t
  val revision : t -> int
  val policy : t -> policy
  val reason : t -> string
  val codec : t Api_codec.t

  (** Explicit current stored representation; decoding enforces the same
      invariants as construction and the public codec. No prototype fallback. *)
  val jsonaf_of_t : t -> Jsonaf.t

  val t_of_jsonaf : Jsonaf.t -> t
end
