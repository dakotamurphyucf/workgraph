open Core

(** Query results (excluding the transport envelope) default to 64KiB and accept
    4KiB..1MiB. Pagination offsets are stable at a required workspace revision.
    Fitting never changes identifiers/revisions. Long prose is UTF-8-prefix
    clipped; arrays are reduced with explicit omissions. Page cursors account for
    items removed by fitting. Clients must increase the budget when no item fits. *)
val of_params : Jsonaf.t -> int

val fit : max_bytes:int -> Jsonaf.t -> Jsonaf.t
val prefix : string -> max_bytes:int -> string
