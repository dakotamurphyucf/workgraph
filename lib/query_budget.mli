open Core

(** Query results (excluding the transport envelope) default to 64KiB and accept
    4KiB..1MiB. Pagination offsets are stable at a required workspace revision.
    Fitting never changes identifiers/revisions. Long prose is UTF-8-prefix
    clipped; arrays are reduced with explicit omissions. Page cursors account for
    items removed by fitting. Clients must increase the budget when no item fits. *)
val of_params : Jsonaf.t -> int

(** [measure] defaults to canonical JSON bytes. The public wire projection may
    supply its own measure; returned_bytes then describes that public result. *)
val fit : ?measure:(Jsonaf.t -> int) -> max_bytes:int -> Jsonaf.t -> Jsonaf.t

val prefix : string -> max_bytes:int -> string

(** Add exact budget metadata without changing any payload field or item. The
    caller selects a whole-item prefix and supplies the count omitted by byte
    fitting (not ordinary limit pagination). [returned_bytes] uses [measure]
    across the complete annotated result. Oversized intermediate candidates are
    returned for the caller to compare; only a fitting candidate may be exposed.
    Raises [Json.Decode_error] for invalid bounds/counts, a non-object value or
    an existing budget field. *)
val annotate_whole_items_exn
  :  ?measure:(Jsonaf.t -> int)
  -> max_bytes:int
  -> omitted_items:int
  -> Jsonaf.t
  -> Jsonaf.t
