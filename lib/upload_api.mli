open Core

(** Actor-owned ephemeral staging. These methods are [Write] operations: their
    acknowledgements never assert durable resource publication. All codecs are
    independent of live staging-table representation and reject unknown fields. *)
module Identity : sig
  type t

  val workspace : t -> Id.Workspace.t
  val actor : t -> Id.Actor.t
  val upload : t -> Id.Upload.t
  val codec : t Api_codec.t
end

module Begin_request : sig
  type t

  val identity : t -> Identity.t
  val size_bytes : t -> int
  val digest : t -> string
  val codec : t Api_codec.t
end

module Chunk_request : sig
  (** Bytes are opaque, nonempty and at most 262144 bytes. The wire encoding is
      canonical padded Base64. Offset is a nonnegative byte offset; overlap,
      declared-size and contiguous-progress checks require the live owner. *)
  type t

  val identity : t -> Identity.t
  val offset : t -> int
  val bytes : t -> string
  val codec : t Api_codec.t
end

module Status : sig
  (** A live staging observation, with [0 <= received <= size_bytes <= 64MiB].
      It reports the declared digest, not a verified immutable publication. *)
  type t

  val upload : t -> Id.Upload.t
  val received : t -> int
  val size_bytes : t -> int
  val digest : t -> string
  val codec : t Api_codec.t

  (** Validate a worker's domain result and its upload identity before returning
      it. Programmer-output errors raise [Api_method.Invalid_response]; callers
      must preserve unexpected failures and cancellation. *)
  val of_result : Identity.t -> method_:string -> Jsonaf.t -> t
end

module Aborted : sig
  type t

  val confirmed : t
  val codec : t Api_codec.t
end

val begin_method : (Begin_request.t, Status.t) Api_method.t
val chunk_method : (Chunk_request.t, Status.t) Api_method.t
val status_method : (Identity.t, Status.t) Api_method.t
val abort_method : (Identity.t, Aborted.t) Api_method.t
val methods : Api_method.Packed.t list
