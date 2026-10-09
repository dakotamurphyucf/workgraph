open Core

module Finish_request : sig
  (** A standalone planning publication. resource_id may be omitted only for
      creation at expected_revision zero; server resolution occurs after exact
      raw request identity is retained. Bytes/digest/size come from live staging. *)
  type t

  val upload : t -> Id.Upload.t
  val resource : t -> Id.Resource.t option
  val expected_revision : t -> int
  val title : t -> string
  val filename : t -> string
  val mime_type : t -> string
  val codec : t Api_codec.t
end

module Query : sig
  type t =
    | Get of Id.Resource.t
    | History of Id.Resource.t
    | List of Entity_ref.t option

  type request

  val query : request -> t
  val offset : request -> int
  val limit : request -> int
  val at_revision : request -> int option
  val include_archived : request -> bool
  val max_bytes : request -> int
  val decode : method_:string -> params:Jsonaf.t -> (request, Problem.t) Result.t
end

(** Unscoped descriptors; catalog adds workspace query or mutation identity.
    Finish publication is excluded from planning batches. Exact raw JSON request
    identity is preserved by catalog adapters. Durable resource encodings do not
    pass through these public codecs. *)
val methods : Api_method.Packed.t list

val request_codec : method_:string -> Jsonaf.t Api_codec.t option
val response_codec : method_:string -> Jsonaf.t Api_codec.t option

(** Validate publication data before the durable commit. Invalid programmer
    output raises [Api_method.Invalid_response]. *)
val validate_publication : Jsonaf.t -> unit
