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
