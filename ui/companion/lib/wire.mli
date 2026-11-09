open Core

(** /ui-api/v1 DTOs. Duplicate/unknown fields and incorrect tagged alternatives
    reject. JSON numeric lexemes remain untouched; counters are decimal strings.
    All effective method scope/writer/defaults are explicit in params. *)
module Invocation : sig
  type t =
    { connection_id : Connection_profile.Id.t
    ; generation : Connection_profile.Generation.t
    ; method_ : string
    ; params : Jsonaf.t
    ; lane : Read_scheduler.Lane.t
    }

  val of_json : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t
end

module Preparation : sig
  type t =
    { intention_id : string
    ; context : Operation.Context.t
    ; invocation : Invocation.t
    }

  val of_json : Jsonaf.t -> (t, Workgraph.Problem.t) Result.t
end

val success : Jsonaf.t -> Jsonaf.t
val failure : Workgraph.Problem.t -> Jsonaf.t

(** Lean method/helper discovery excludes schemas. Lazy selected method lookup
    returns exactly one executable schema and its curated help/discovery record. *)
val catalog : unit -> Jsonaf.t

val method_contract : string -> (Jsonaf.t, Workgraph.Problem.t) Result.t
