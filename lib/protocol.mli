open Core

(** Server profile: string IDs of 1..256 bytes, finite numeric IDs, or null;
    method of 1..128 bytes; optional object params. Notifications are discarded
    before dispatch. Invalid envelopes receive -32600 with null ID. *)
val validate_server_request : Jsonaf.t -> (unit, Problem.t) Result.t

(** Current client envelope. Client request IDs are strings; the server also
    accepts numeric IDs from other clients. Unknown methods conservatively count
    as writes when reporting transport uncertainty. *)
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
    protocol data or a transport failure. *)
val decode_response : Request.t -> Jsonaf.t -> (response, Problem.t) Result.t

val response_json : Request.t -> response -> Jsonaf.t
val result : response -> (Jsonaf.t, Problem.t) Result.t
