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
  module Exclusion : sig
    type t =
      | Completed
      | Canceled
      | Archived
      | Blocked
      | Claimed
      | Missing_capability
      | Pool_full
      | Parent_filtered
      | Run_terminal
    [@@deriving equal]
  end

  module Candidate : sig
    (** Exact per-ticket assessment from the authoritative staged capture.
        Empty exclusions are allowed only when an exhausted run limit explains
        the empty allocation. Duplicate tickets reject; categories may overlap. *)
    type t =
      { ticket : Id.Ticket.t
      ; exclusions : Exclusion.t list
      }
  end

  (** Bounded diagnosis of an empty allocation from the same immutable capture.
      Candidate reason counts may overlap; examples are at most five ticket IDs
      per reason, sorted by ID, with explicit omitted counts. No candidate values,
      owner tokens or unbounded capability/pool lists are exposed. *)
  type t

  val create
    :  captured_workspace_revision:int
    -> candidates:Candidate.t list
    -> limits:Budget_limit.t list
    -> (t, Problem.t) Result.t

  (** Includes scoped candidate count, captured revision, reason counts/examples,
      and exhausted run limits. An empty candidate set is explicitly count zero.
      A standalone observation uses that same revision; an explicit transaction
      receipt carries its later committed revision. Completed/canceled scopes
      are distinct from current blocked or claimed work. *)
  val codec : t Api_codec.t

  val captured_workspace_revision : t -> int
  val to_json : t -> Jsonaf.t
end

module Definition : sig
  (** [limit] measures distinct allocated tickets in this named pool. Reducing
      it preserves existing grants and blocks new occupancy until room exists;
      starting an eligible attempt for an already claimed ticket adds no slot. *)
  type t =
    { name : string
    ; revision : int
    ; limit : int
    }
  [@@deriving sexp, equal, jsonaf]
end

module Ticket_policy : sig
  (** Planning rejects policy replacement while this ticket has a claim or a
      nonterminal attempt. Requirements cannot change beneath an existing grant. *)
  type t =
    { ticket : Id.Ticket.t
    ; revision : int
    ; required_capabilities : string list
    ; pools : string list
    }
  [@@deriving sexp, equal, jsonaf]
end
