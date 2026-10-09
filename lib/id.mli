open Core

module type S = sig
  type t [@@deriving sexp, compare, equal]

  include Comparable.S with type t := t

  val of_string : string -> (t, Problem.t) Result.t
  val to_string : t -> string
  val jsonaf_of_t : t -> Jsonaf.t

  (** Validating decoder; raises [Json.Decode_error] on invalid wire data. *)
  val t_of_jsonaf : Jsonaf.t -> t
end

module Workspace : S
module Project : S
module Milestone : S
module Ticket : S
module Actor : S

(** A caller-selected identity for one mutation, distinct from actor attribution.
    Retries reuse the exact identity and request. Scope is actor plus workspace
    (or registry for administration); changing payload requires a new identity. *)
module Mutation : S

module Run : S
module Label : S
module Status : S
module Resource : S
module Comment : S
module Upload : S
