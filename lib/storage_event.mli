open Core

(** Current domain-event envelope. Strictly validates each domain payload and
    retains original JSON for receipt and hash-chain identity. No prototype
    compatibility readers are supported. *)
type t

val of_json : Jsonaf.t -> (t, Problem.t) Result.t
val to_json : t -> Jsonaf.t
val revision : t -> int
val actor : t -> string
