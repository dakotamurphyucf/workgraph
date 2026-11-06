open Core

module Group : sig
  type t =
    | Workspace
    | Project
    | Milestone
    | Ticket
    | Run
    | Attempt
  [@@deriving sexp, compare, equal]

  val codec : t Api_codec.t
end

module Metrics_layout : sig
  (** [Rows] preserves independently paginated usage/metric rows. [Nested] returns
      complete metric arrays with each usage group. [Totals_only] omits metric
      detail, retaining per-group summary counts and overflow indicators. *)
  type t =
    | Rows
    | Nested
    | Totals_only
  [@@deriving sexp, compare, equal]

  val codec : t Api_codec.t
end

module Request : sig
  type t

  (** ANDed literal filters. Pagination cursor binds method/filters/current
      revision/lineage/position and effective metrics layout; changed membership
      requires an explicit rescan. Limit counts rows in [Rows], whole groups in
      [Nested]/[Totals_only]. Byte fitting never splits a nested metric array;
      [needs_larger_budget] and [required_bytes] allow retrying the same position.
      Page size and byte budget may change during continuation.
      At_revision guards the current capture and does not select history. *)
  val codec : t Api_codec.t

  val group : t -> Group.t
  val metrics_layout : t -> Metrics_layout.t
  val project : t -> Id.Project.t option
  val milestone : t -> Id.Milestone.t option
  val ticket : t -> Id.Ticket.t option
  val run : t -> Id.Run.t option
  val attempt : t -> Attempt.Id.t option
  val actor : t -> Id.Actor.t option
  val at_revision : t -> int option
  val cursor : t -> string option
  val limit : t -> int
  val max_bytes : t -> int
end

val response_codec : Jsonaf.t Api_codec.t
val method_ : Api_method.Packed.t
