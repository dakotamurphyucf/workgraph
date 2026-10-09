open Core

module Pool : sig
  type t =
    { name : string
    ; limit : int
    ; active : int
    }
  [@@deriving sexp]
end

module Candidate : sig
  type t =
    { ticket : Id.Ticket.t
    ; priority : int
    ; creation_sequence : int
    ; ready : bool
    ; available : bool
    ; required_capabilities : string list
    ; pools : Pool.t list
    }
  [@@deriving sexp]
end

module Reason : sig
  type t =
    | Not_ready
    | Claimed
    | Missing_capability of string
    | Pool_full of string
  [@@deriving sexp, equal]
end

type t =
  | Selected of Candidate.t
  | Empty
[@@deriving sexp]

(** Caller supplies readiness and ownership from one staged domain capture.
    Priority 1..4 precedes unspecified 0, then creation sequence and ID. Pool
    counts and selected attempt/claim must commit in the same transaction. *)
val eligibility : Candidate.t -> capabilities:string list -> Reason.t list

val choose : Candidate.t list -> capabilities:string list -> (t, Problem.t) Result.t

module Budget_limit : sig
  type kind =
    | Attempts
    | Active_attempts
  [@@deriving sexp, equal]

  type t =
    { kind : kind
    ; used : int
    ; limit : int
    }
  [@@deriving sexp]

  (** Only exhausted limits: positive limits with [used >= limit]. *)
  val codec : t Api_codec.t
end

module Explanation : sig
  (** Bounded diagnosis of an empty allocation from the same immutable capture.
      Candidate reason counts may overlap; examples are at most five ticket IDs
      per reason, sorted by ID, with explicit omitted counts. No candidate values,
      owner tokens or unbounded capability/pool lists are exposed. *)
  type t

  val create
    :  captured_workspace_revision:int
    -> candidates:Candidate.t list
    -> capabilities:string list
    -> parent_filtered:(Id.Ticket.t -> bool)
    -> limits:Budget_limit.t list
    -> (t, Problem.t) Result.t

  (** Includes scoped candidate count, captured revision, reason counts/examples,
      and exhausted run limits. An empty candidate set is explicitly count zero.
      The enclosing durable receipt carries the later committed revision. *)
  val codec : t Api_codec.t

  val to_json : t -> Jsonaf.t
end

module Definition : sig
  type t =
    { name : string
    ; revision : int
    ; limit : int
    }
  [@@deriving sexp, equal, jsonaf]
end

module Ticket_policy : sig
  type t =
    { ticket : Id.Ticket.t
    ; revision : int
    ; required_capabilities : string list
    ; pools : string list
    }
  [@@deriving sexp, equal, jsonaf]
end
