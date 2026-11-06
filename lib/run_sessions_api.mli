open Core

module Request : sig
  type t

  (** Omitted head selects current capture; explicit null selects the
      empty history capture. A noninitial page requires head and expected run
      revision. Limits count session IDs; budgets count public result bytes. *)
  val codec : t Api_codec.t

  val run : t -> Id.Run.t
  val head : t -> string option option
  val expected_run_revision : t -> int option
  val after : t -> Session_id.t option
  val limit : t -> int
  val max_bytes : t -> int
end

(** Exact lowercase SHA-256 digest; nullable uses select an empty history. *)
val head_codec : string Api_codec.t

val next_request_codec : Jsonaf.t Api_codec.t

(** Required derived association metadata, independent of durable run records.
    Pure planning projections keep [Agent_run_wire.run]; service-facing reads
    must supply a verified history capture, never synthesize empty associations. *)
val run_view_codec : Jsonaf.t Api_codec.t

val response_codec : Jsonaf.t Api_codec.t
val method_ : Api_method.Packed.t
