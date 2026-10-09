open Core

module Mode : sig
  (** [Write] changes state without a durable retry receipt (for example daemon
      shutdown or advisory liveness). [Mutation] requires an exact retry identity.
      Both count as writes when reporting uncertain transport outcomes. *)
  type t =
    | Read
    | Write
    | Mutation
  [@@deriving sexp, equal]
end

(** One executable public method definition: its codecs are also its reference
    schemas. Handlers consume decoded requests and publish validated response
    data. Descriptions include the public data/meta envelope added by transport. *)
type ('request, 'response) t

type ('request, 'response) method_ = ('request, 'response) t

(** A handler returned a value outside its declared response contract. This is
    an implementation failure, never a claim that a mutation did not commit. *)
exception Invalid_response of string * Problem.t

val create
  :  name:string
  -> summary:string
  -> mode:Mode.t
  -> request:'request Api_codec.t
  -> response:'response Api_codec.t
  -> ('request, 'response) t

val name : (_, _) t -> string
val mode : (_, _) t -> Mode.t
val describe : (_, _) t -> Jsonaf.t
val request_codec : ('request, _) t -> 'request Api_codec.t
val response_codec : (_, 'response) t -> 'response Api_codec.t

(** Replace the request codec while retaining identity, mode and response contract;
    used to compose a workspace/attribution envelope at the transport boundary. *)
val with_request
  :  (_, 'response) t
  -> request:'request Api_codec.t
  -> ('request, 'response) t

(** Validates before calling [f], then validates the response. Expected failures
    are results; unexpected exceptions and cancellation propagate. A mutation
    handler remains responsible for durable publication before returning.
    Invalid handler output raises [Invalid_response], preserving uncertainty for
    writes instead of returning a misleading request-validation error. *)
val invoke
  :  ('request, 'response) t
  -> params:Jsonaf.t
  -> f:('request -> ('response, Problem.t) Result.t)
  -> (Jsonaf.t, Problem.t) Result.t

(** Validate and encode a handler result through the descriptor's response
    codec. Invalid output raises [Invalid_response], preserving write uncertainty.
    This permits staging validation before durable publication without invoking
    a preparation callback a second time. *)
val encode_response : (_, 'response) t -> 'response -> Jsonaf.t

module Packed : sig
  type t = Pack : ('request, 'response) method_ -> t
end
