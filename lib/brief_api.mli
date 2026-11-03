open Core

(** Brief is a distinct representation, never an incomplete full context. All
    expansions retain exact IDs and the captured workspace revision guard.
    Resource entity revision and immutable content version remain distinct. *)
module Request : sig
  type t

  val ticket : t -> Id.Ticket.t option
  val resource : t -> Id.Resource.t option
  val at_revision : t -> int option
  val max_bytes : t -> int
  val decode : method_:string -> Jsonaf.t -> (t, Problem.t) Result.t
end

val methods : Api_method.Packed.t list
val query_methods : string list
