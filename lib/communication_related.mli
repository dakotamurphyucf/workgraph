open Core

module Query : sig
  (** Validated direct-read request. Related-message pagination pins both the
      communication revision and discussion activity serial; tombstones remain
      visible. Without include_messages no related-page fields are permitted. *)
  type t

  val id : t -> string
  val include_messages : t -> bool
  val thread_codec : t Api_codec.t
  val request_codec : t Api_codec.t
end

(** Expand a thread's current attached comment versions in attachment order.
    Each version records revision and discussion serial. Pagination never skips
    a tombstone. The owning immutable communication/discussion captures must be
    supplied together. Query_budget later clips bodies and adjusts page cursors. *)
val thread
  :  Query.t
  -> communication_revision:int
  -> discussion:Discussion.t
  -> Communication_event.Thread.t
  -> (Jsonaf.t, Problem.t) Result.t

(** Also includes the request's original source-message ID and its CURRENT
    comment version/body, never pretending it is the original immutable body. *)
val request
  :  Query.t
  -> communication_revision:int
  -> discussion:Discussion.t
  -> thread:Communication_event.Thread.t
  -> Communication_event.Request.t
  -> (Jsonaf.t, Problem.t) Result.t
