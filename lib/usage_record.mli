open Core
module Key : Id.S

module Scope : sig
  type t =
    | Run of Id.Run.t
    | Attempt of Attempt.Id.t
  [@@deriving sexp, equal]
end

module Metric : sig
  (** Additive caller-reported sample, never a gauge update or measured service
      activity. Name is ASCII identifier<=64 bytes, unit<=32 ASCII identifier
      bytes; tokens and elapsed_ms are reserved. No conversion between units. *)
  type t =
    { name : string
    ; unit_ : string
    ; value : int64
    }
  [@@deriving sexp, equal]

  val codec : t Api_codec.t
  val validate : t -> (unit, Problem.t) Result.t
end

module Metric_total : sig
  type t =
    { name : string
    ; unit_ : string
    ; samples : int
    ; value : int64
    ; overflow : bool
    }

  val codec : t Api_codec.t
end

type t =
  { id : Key.t
  ; scope : Scope.t
  ; actor : Id.Actor.t
  ; tokens : int64
  ; elapsed_ms : int64
  ; metrics : Metric.t list
  ; provenance : string
  ; timestamp : string
  }
[@@deriving sexp, equal]

(** Spending is externally reported attribution, not enforced provider usage.
    Records are immutable; stable IDs deduplicate identical retries and reject
    changed content. Token and elapsed totals count nonnegative units. *)
val validate : t -> (unit, Problem.t) Result.t

(** Exact source-ID deduplication; identical records count once, conflicting
    records reject. Validation and source identity are preserved. *)
val deduplicate : t list -> (t list, Problem.t) Result.t

(** Name/unit sums over deduplicated records, ordered by name then unit.
    Saturation is explicit per series; distinct units remain distinct series. *)
val metric_totals : t list -> (Metric_total.t list, Problem.t) Result.t

val to_json : t -> Jsonaf.t
val of_json : Jsonaf.t -> (t, Problem.t) Result.t

module Id = Key
