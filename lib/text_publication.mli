open Core

(** Local bounded-text publish-and-link preparation. No I/O or publication occurs
    here. The resulting ordinary transaction contains exactly a resource.put_text
    followed by resource.link to the supplied ticket at the next metadata guard.
    Both succeed atomically or neither changes durable state. *)
type t

(** Accept put_text fields, required ticket_id and workspace/actor attribution,
    optional run_id/mutation_id. Reuse public decoders; reject unbound aliases,
    unknown/duplicate fields and guards without two representable metadata advances.
    Omitted mutation identity is supplied later by the existing CLI journal machinery.
    Only validation failures become domain errors; unexpected exceptions propagate. *)
val of_params : Jsonaf.t -> (t, Problem.t) Result.t

(** Frozen transaction.apply parameters for ordinary saving, execution and exact
    retry. Results retain the daemon's method-tagged transaction receipt: item 0
    is the publication/version pin; item 1 is the final linked metadata revision. *)
val params : t -> Jsonaf.t
