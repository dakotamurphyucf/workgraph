open Core

(** Immutable project and ticket acceptance requirements. This module performs
    pure resolution; planning owns membership, ownership and durable history.
    S-expression decoders enforce the same validation and canonicalization as
    the JSON codecs, including the digest of an effective policy binding. *)
module Scope : sig
  type t =
    | Project of Id.Project.t
    | Ticket of Id.Ticket.t
  [@@deriving sexp, compare, equal]

  include Comparable.S with type t := t

  val codec : t Api_codec.t
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t
end

module Requirement : sig
  type t =
    | Named_actor of Id.Actor.t
    | Role of
        { name : string
        ; members : Id.Actor.t list
        }
  [@@deriving sexp, compare, equal]

  (** Named lowercase objects: actor uses actor_id; role uses name/member_ids.
      A role requires 1..100 distinct actor IDs, sorted canonically. *)
  val codec : t Api_codec.t

  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t
end

module Criterion : sig
  module Key : Id.S

  type t =
    { key : Key.t
    ; description : string
    ; required : bool
    }
  [@@deriving sexp, equal]

  val codec : t Api_codec.t
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t

  module Ref : sig
    type t =
      { scope : Scope.t
      ; policy_revision : int
      ; key : Key.t
      }
    [@@deriving sexp, compare, equal]

    val codec : t Api_codec.t
    val jsonaf_of_t : t -> Jsonaf.t
    val t_of_jsonaf : Jsonaf.t -> t
  end
end

module Source : sig
  type t =
    { scope : Scope.t
    ; revision : int
    }
  [@@deriving sexp, compare, equal]

  val codec : t Api_codec.t
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t
end

module Inherited_override : sig
  type t [@@deriving sexp, equal]

  val create
    :  against:Source.t
    -> membership_revision:int
    -> reviewers:Requirement.t list
    -> validators:string list
    -> criteria:Criterion.Key.t list
    -> waive_separate_actor:bool
    -> reason:string
    -> (t, Problem.t) Result.t

  val against : t -> Source.t
  val membership_revision : t -> int
  val reason : t -> string
  val codec : t Api_codec.t
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t
end

module Definition : sig
  type t [@@deriving sexp, equal]

  val create
    :  scope:Scope.t
    -> revision:int
    -> enabled:bool
    -> reviewers:Requirement.t list
    -> separate_actor:bool
    -> validators:string list
    -> criteria:Criterion.t list
    -> inherited_override:Inherited_override.t option
    -> (t, Problem.t) Result.t

  val scope : t -> Scope.t
  val revision : t -> int
  val enabled : t -> bool
  val reviewers : t -> Requirement.t list
  val separate_actor : t -> bool
  val validators : t -> string list
  val criteria : t -> Criterion.t list
  val inherited_override : t -> Inherited_override.t option
  val codec : t Api_codec.t
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t

  (** Required statement changes count as replacing the requirement. Widening a
      reviewer role, removing requirements, or introducing an override needs a
      nonblank reason. Collection identity is exact, with canonical ordering. *)
  val check_update
    :  t option
    -> next:t
    -> weakening_reason:string option
    -> (unit, Problem.t) Result.t
end

module Effective : sig
  type t [@@deriving sexp, equal]

  val resolve
    :  ticket_id:Id.Ticket.t
    -> project_id:Id.Project.t option
    -> membership_revision:int
    -> project:Definition.t option
    -> ticket:Definition.t option
    -> minimum_reopening_token:int option
    -> ownership_token:int option
    -> (t, Problem.t) Result.t

  val is_configured : t -> bool
  val sources : t -> Source.t list
  val digest : t -> string
  val reviewers : t -> Requirement.t list
  val validators : t -> string list
  val criteria : t -> (Criterion.Ref.t * Criterion.t) list
  val separate_actor : t -> bool

  (** An override is stale when membership or the project version changed.
      Stale waivers are disclosed and the current inherited requirements apply. *)
  val stale_override : t -> Inherited_override.t option

  val codec : t Api_codec.t
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t

  module Binding : sig
    type t [@@deriving sexp, equal]

    val digest : t -> string
    val ticket_id : t -> Id.Ticket.t
    val ownership_token : t -> int option
    val codec : t Api_codec.t
    val jsonaf_of_t : t -> Jsonaf.t

    (** Validates source/criterion consistency, canonical requirements and the
        digest recomputed from every serialized binding field. *)
    val t_of_jsonaf : Jsonaf.t -> t
  end

  val binding : t -> Binding.t
end
