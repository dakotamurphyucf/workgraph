open Core

(** Nested raw Evidence request values. Only declared entity references admit
    literal IDs or transaction-local $aliases; opaque text and digests remain
    uninterpreted. These are the same nested Fields declarations used by both
    the public raw request and the resolved command projection. *)
val scope : Jsonaf.t Api_codec.t

val requirement : Jsonaf.t Api_codec.t
val criterion_ref : Jsonaf.t Api_codec.t
val inherited_override : Jsonaf.t Api_codec.t
val manifest_ref : Jsonaf.t Api_codec.t
val contract_ref : Jsonaf.t Api_codec.t
val resource_pin : Jsonaf.t Api_codec.t
val pin : Jsonaf.t Api_codec.t
val artifact : Jsonaf.t Api_codec.t
val entity_ref : Jsonaf.t Api_codec.t
val disposition : Jsonaf.t Api_codec.t
