open Core

(* Public resource transport records are independent of durable codecs.
    Resource summaries expose [resource_id]; content versions expose [actor_id].
    Resolved tagged targets reject aliases. *)

(** Complete historical metadata snapshot validated by Resource invariants. *)
val metadata : Resource.Metadata.t Api_codec.t

val version : Resource.Version.t Api_codec.t
val digest : string Api_codec.t
val version_json : Resource.Version.t -> Jsonaf.t

(** Validate the complete domain resource before projecting a current summary.
    Query byte fitting runs afterwards and discloses omitted prose/targets in
    [meta.budget]. Its response codec permits these explicit clipped views. *)
val summary_json : Resource.t -> Jsonaf.t

val summary : Jsonaf.t Api_codec.t
val publication : Jsonaf.t Api_codec.t
