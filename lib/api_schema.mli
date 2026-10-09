open Core

(** Compact a codec's structural schema into a self-contained Draft 2020-12
    document. Repeated shapes receive stable, field-derived names in [$defs];
    every [$ref] is local to this document. Only schema locations are traversed,
    so literal JSON in examples, constants and extension annotations is retained.
    Expansion recovers the exact input, including closure and domain constraints.
    Existing URI/reference scopes and schemas deeper than 128 schema locations
    are left unchanged. No runtime codec changes. *)
val compact : Jsonaf.t -> Jsonaf.t
