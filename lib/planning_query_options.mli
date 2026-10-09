open Core

(** Shared typed bounds for current planning capture reads. Optional fields use
    defaults only when absent; explicit null rejects. Positive offset requires
    the exact observed workspace revision. Max_bytes counts final result bytes. *)
type t

(** Capture and budget only; scalar reads reject paging/archive options. *)
val scalar_fields : t Api_codec.Fields.t

(** Capture, budget and paging; historical and blocker pages reject archive flags. *)
val page_fields : t Api_codec.Fields.t

(** Capture, budget, paging and archive filtering for current entity lists. *)
val fields : t Api_codec.Fields.t

val codec : t Api_codec.t
val offset : t -> int
val limit : t -> int
val at_revision : t -> int option
val include_archived : t -> bool
val max_bytes : t -> int
