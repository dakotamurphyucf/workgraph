open Core

module Query_scope : sig
  type t =
    | Communication
    | Runs
    | Evidence
    | Policy
  [@@deriving sexp, equal]

  val name : t -> string
end

(** Metadata shared by every public success. The codec validates nested budget
    diagnostics and immutable history captures, not only their outer object.
    Entity revisions belong in the method's data, never in this envelope. *)
type t

val codec : t Api_codec.t
val of_json : Jsonaf.t -> (t, Problem.t) Result.t
val to_json : t -> Jsonaf.t
