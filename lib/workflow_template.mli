open Core
module Instance_id : Id.S

module Node : sig
  type t =
    { alias : string
    ; title : string
    ; description : string
    ; depends_on : string list
    ; parent : string option
    ; capabilities : string list
    ; reviewers : Id.Actor.t list
    ; separate_actor : bool
    }
  [@@deriving sexp, equal]
end

module Spec : sig
  type t =
    { parameters : string list
    ; nodes : Node.t list
    }
  [@@deriving sexp, equal]

  val validate : t -> (unit, Problem.t) Result.t
  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Problem.t) Result.t
end

type t =
  { resource : Id.Resource.t
  ; resource_revision : int
  ; digest : string
  ; spec : Spec.t
  }
[@@deriving sexp, equal]

module Planned_ticket : sig
  type t =
    { alias : string
    ; ticket : Id.Ticket.t
    ; title : string
    ; description : string
    ; dependencies : Id.Ticket.t list
    ; parent : Id.Ticket.t option
    ; capabilities : string list
    ; reviewers : Id.Actor.t list
    ; separate_actor : bool
    }
  [@@deriving sexp, equal]
end

module Instance : sig
  type t =
    { id : Instance_id.t
    ; template : Id.Resource.t
    ; template_revision : int
    ; parameters : (string * string) list
    ; tickets : Planned_ticket.t list
    }
  [@@deriving sexp, equal]

  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Problem.t) Result.t
end

(** Templates pin a resource version whose bytes are canonical [Spec.to_json].
    Caller validates the immutable resource's digest against [digest]. Plans
    have stable instance/alias ticket IDs. Parameter substitution recognizes
    only {{name}} in template text; inserted values are literal and are never
    interpreted as further placeholders. Parameter ordering has no effect.
    Cycles, unknown aliases and plans over 32 mutations reject
    before publishing any runnable tickets. The integration owner stages the
    complete returned plan and instance registration in one transaction. *)
val create
  :  resource:Id.Resource.t
  -> resource_revision:int
  -> spec:Spec.t
  -> (t, Problem.t) Result.t

val instantiate
  :  t
  -> id:Instance_id.t
  -> parameters:(string * string) list
  -> (Instance.t, Problem.t) Result.t

val to_json : t -> Jsonaf.t
val of_json : Jsonaf.t -> (t, Problem.t) Result.t
