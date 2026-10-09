open Core

module Request : sig
  (** A resource identity and optional positive content-version revision.
      An absent version selects latest at execution, never a metadata revision. *)
  type t

  val workspace : t -> Id.Workspace.t
  val resource : t -> Id.Resource.t
  val version : t -> int option
  val codec : t Api_codec.t
end

module Chunk_request : sig
  (** Byte offsets are nonnegative; lengths are 1..262144 bytes. *)
  type t

  val request : t -> Request.t
  val byte_offset : t -> int
  val max_bytes : t -> int
  val codec : t Api_codec.t
end

module Text : sig
  (** Complete UTF-8 content of at most 65536 bytes, with the exact content
      version/digest. Construction verifies bytes against supplied metadata. *)
  type t

  val create
    :  Request.t
    -> version:Resource.Version.t
    -> text:string
    -> (t, Problem.t) Result.t

  val codec : t Api_codec.t
end

module Chunk : sig
  (** A verified binary range. Returned offsets/length/digests identify the
      exact immutable version; next_offset is absent only at EOF. *)
  type t

  val create
    :  Chunk_request.t
    -> version:Resource.Version.t
    -> bytes:string
    -> total_bytes:int
    -> (t, Problem.t) Result.t

  val codec : t Api_codec.t
end

(** Executable descriptors: service invocation uses these exact request/result
    codecs; schema generation cannot diverge from validation. *)
val text_method : (Request.t, Text.t) Api_method.t

val chunk_method : (Chunk_request.t, Chunk.t) Api_method.t
