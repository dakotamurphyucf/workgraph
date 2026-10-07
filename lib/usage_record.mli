open Core
module Key : Id.S

module Scope : sig
  type t =
    | Run of Id.Run.t
    | Attempt of Attempt.Id.t
  [@@deriving sexp, equal]
end

type t =
  { id : Key.t
  ; scope : Scope.t
  ; actor : Id.Actor.t
  ; tokens : int64
  ; elapsed_ms : int64
  ; provenance : string
  ; timestamp : string
  }
[@@deriving sexp, equal]

(** Spending is externally reported attribution, not enforced provider usage.
    Records are immutable; stable IDs deduplicate identical retries and reject
    changed content. Token and elapsed totals count nonnegative units. *)
val validate : t -> (unit, Problem.t) Result.t

val to_json : t -> Jsonaf.t
val of_json : Jsonaf.t -> (t, Problem.t) Result.t

module Id = Key
