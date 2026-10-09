open Core

module Scope : sig
  type t =
    | Workspace
    | Project of Id.Project.t
    | Ticket of Id.Ticket.t
  [@@deriving sexp_of, equal]

  val codec : t Api_codec.t
end

module Fact_selection : sig
  type t =
    { scope : Facts.Scope.t
    ; key : Facts.Key.t
    }
  [@@deriving sexp_of, equal]

  val codec : t Api_codec.t
end

module Resume_request : sig
  (** Decoding enforces byte budget 4096..1048576, change limit1..100, at most16
      distinct exact fact selections and UTF8 prefix <=128 bytes. No inheritance.
      Omitted observation clock is handled by the pure builder, never defaulted
      to a persisted lease observation. at_revision is an exact current guard. *)
  type t

  val codec : t Api_codec.t
  val ticket : t -> Id.Ticket.t
  val run : t -> Id.Run.t option
  val at_revision : t -> int option
  val max_bytes : t -> int
  val change_limit : t -> int
  val facts : t -> Fact_selection.t list
  val fact_prefix : t -> string option
  val include_markdown : t -> bool
end

module Digest_request : sig
  (** Cursor and numeric after are mutually exclusive. Initial numeric after
      begins a fresh capture; only a returned cursor preserves a prior lineage.
      Requests keep scope unchanged across pages. Cursor text <=2048 UTF8 bytes. *)
  type t

  val codec : t Api_codec.t
  val scope : t -> Scope.t
  val after : t -> int option
  val cursor : t -> string option
  val limit : t -> int
  val max_bytes : t -> int
  val include_markdown : t -> bool
end

val prose_fields : string -> string list
val item_codec : Jsonaf.t Api_codec.t
val entry_codec : Jsonaf.t Api_codec.t
val query_methods : string list
val request_codec : method_:string -> Jsonaf.t Api_codec.t option

(** Actual fitted data codec; composed canonical family record codecs and typed
    source refs, not a second schema. Public metadata uses Planning_read and
    workspace_revision, with a separate capture.through on digest data. *)
val response_codec : method_:string -> Jsonaf.t Api_codec.t option

val descriptor : method_:string -> Api_method.Packed.t option
