open Core

(** Immutable externally reported usage. Tokens and elapsed_ms are nonnegative;
    provenance/timestamp remain caller-attributed facts, not provider enforcement. *)
val scope : Usage_record.Scope.t Api_codec.t

val record : Usage_record.t Api_codec.t
val raw_scope : Jsonaf.t Api_codec.t
