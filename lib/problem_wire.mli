open Core

(** Shared strict admission-reason codec for diagnostics and readiness views. *)
val allocation_reason : Allocation_admission_reason.t Api_codec.t

(** Current public diagnostics with closed tagged details. Decoding validates
    bounded paths/text/identities and counters; no internal state is exposed. *)
val details : Problem.Details.t Api_codec.t

val codec : Problem.t Api_codec.t

(** Unknown error discriminators report [Unsupported_version]; malformed current
    diagnostics retain ordinary validation errors. *)
val of_json : Jsonaf.t -> (Problem.t, Problem.t) Result.t
