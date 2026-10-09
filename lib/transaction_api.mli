open Core

(** Ordered atomic planning operations, using the actual request codecs of each
    participating family. Administrative, history, upload and nested transactions
    have no branch. 1..32 operations, unique creation aliases; domain preparation
    additionally resolves alias kinds and validates the final combined state. *)
val request : Planning_api.Operation.t list Api_codec.t

module Result_item : sig
  type t =
    { method_ : string
    ; data : Jsonaf.t
    }

  (** Each method selects its actual family receipt codec. No arbitrary JSON
      receipt branch; order corresponds exactly to the submitted operations. *)
  val codec : t Api_codec.t
end

val response : Result_item.t list Api_codec.t
val method_ : (Planning_api.Operation.t list, Result_item.t list) Api_method.t

(** Encode and validate an entire prepared batch before durable publication.
    Invalid staged output raises [Api_method.Invalid_response]. *)
val result : Result_item.t list -> Jsonaf.t
