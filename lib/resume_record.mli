open Core

(** Pure construction of validated canonical family views with explicit clipped
    source prose. Identity, counters, routing, arbitrary JSON and pins are whole. *)
val create
  :  kind:string
  -> summary:string
  -> sources:Resume_source.t list
  -> record:Jsonaf.t
  -> max_field_bytes:int
  -> Jsonaf.t

(** Labels task objective as ticket description and handoff objective separately.
    Rendering does not change structured source records or coverage. *)
val markdown : Jsonaf.t list -> string

val count : section:string -> total:int -> returned:int -> Jsonaf.t
val envelope : revision:int -> Jsonaf.t -> Jsonaf.t

val markdown_context
  :  capture:Jsonaf.t
  -> warnings:Jsonaf.t list
  -> counts:Jsonaf.t list
  -> cursor:string
  -> has_more:bool
  -> string
