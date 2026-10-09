open Core

(** Exact public comment/version view. Prose may be prefix-clipped only with
    query budget disclosure. Identity, counters and immutable origin stay complete.
    The source is the private [Discussion.get]/[history] view, never a wire decoder. *)
val comment : Jsonaf.t Api_codec.t

val comment_json : Jsonaf.t -> Jsonaf.t
