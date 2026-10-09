open Core

(** Server profile: string IDs of 1..256 bytes, finite numeric ID lexemes of at
    most 256 bytes, or null;
    method of 1..128 bytes; optional object params. Notifications are discarded
    before dispatch. Requires workgraph_api="0.4" before method decoding.
    Invalid envelopes receive -32600, preserving a valid parsed ID when possible. *)
val validate_server_request : Jsonaf.t -> (unit, Problem.t) Result.t

(** Extract a unique valid request ID independently of envelope validation. Invalid
    or missing IDs return [None]; callers use null for an envelope rejection. *)
val server_request_id : Jsonaf.t -> Jsonaf.t option

type error_code =
  | Invalid_envelope
  | Application_failure

(** Encode a diagnostic envelope of at most 65536 bytes, preserving its kind and
    bounded typed detail. Long text is visibly truncated; paths and lists retain
    bounded prefixes.
    [Invalid_envelope] is reserved for rejection before dispatch; encoding or
    writing failures after dispatch must never use it. [id] is a valid parsed ID
    of at most 256 bytes or null. *)
val error_response_json : id:Jsonaf.t -> code:error_code -> Problem.t -> Jsonaf.t

(** Current client envelope. Client request IDs are strings; the server also
    accepts numeric IDs from other clients. Unknown methods conservatively count
    as writes when reporting transport uncertainty. Encoders always emit the
    current application profile; saved unmarked/older requests reject unchanged. *)
module Request : sig
  type mode =
    | Read
    | Write
  [@@deriving equal, sexp]

  type t

  val create : id:string -> method_:string -> params:Jsonaf.t -> (t, Problem.t) Result.t
  val of_json : Jsonaf.t -> (t, Problem.t) Result.t
  val to_json : t -> Jsonaf.t
  val method_ : t -> string
  val params : t -> Jsonaf.t
  val with_params : t -> Jsonaf.t -> (t, Problem.t) Result.t

  (** Known method effects come from their executable catalog descriptors.
      Unknown methods conservatively count as writes for transport uncertainty;
      the server rejects them without admitting an operation. *)
  val mode : t -> mode
end

type response =
  | Success of Jsonaf.t
  | Failure of Problem.t

(** Rejects mismatched IDs, ambiguous result/error envelopes, unknown error codes
    (the current profile permits -32000 application failure and -32600 invalid envelope) and error
    discriminators. A received application failure is distinct from malformed
    protocol data or a transport failure. A strict -32600 envelope with null ID
    is a definite remote rejection. Its optional data must be a valid diagnostic
    of kind Invalid_argument or Unsupported_version; malformed data still rejects. *)
val decode_response : Request.t -> Jsonaf.t -> (response, Problem.t) Result.t

val response_json : Request.t -> response -> Jsonaf.t
val result : response -> (Jsonaf.t, Problem.t) Result.t
