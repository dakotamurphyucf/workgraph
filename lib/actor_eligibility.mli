open Core

(** Cooperative actor selection, not authentication. Unrestricted policy admits
    any actor; an allowlist contains 1..100 distinct stable actor IDs. Constructors
    canonicalize ordering and reject duplicates/empty lists. No ownership,
    historical rejection, process state or implicit release blacklist is inferred. *)
type t [@@deriving sexp, equal]

val unrestricted : t
val allowed : Id.Actor.t list -> (t, Problem.t) Result.t
val allowed_actors : t -> Id.Actor.t list option
val permits : t -> actor:Id.Actor.t -> bool

(** [null] explicitly means unrestricted; a nonempty ID array means allowed.
    Omission is the enclosing command's preserve-on-update patch state, never
    confused with [null]. Empty/duplicate/oversized arrays reject. Canonical
    output sorts IDs; public input order has no effect on selection. *)
val codec : t Api_codec.t

(** Explicit current JSON representation, also validated for stored policy data.
    These do not expose derived OCaml constructor names on the public wire. *)
val jsonaf_of_t : t -> Jsonaf.t

val t_of_jsonaf : Jsonaf.t -> t
