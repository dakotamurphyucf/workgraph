open Core

(** Executable codecs for base planning mutations. Public requests retain omitted
    generated IDs; resolution must precede [decode_resolved]. Codec declarations
    supply both wire validation and reference schemas. *)
val methods : string list

val request_schema : method_:string -> Jsonaf.t option

val validate_request
  :  method_:string
  -> params:Jsonaf.t
  -> (unit, Problem.t) Result.t option

val decode_resolved
  :  method_:string
  -> params:Jsonaf.t
  -> (Planning_command.t, Problem.t) Result.t option

val encode : Planning_command.t -> (string * Jsonaf.t, Problem.t) Result.t option

(** A JSON representation backed by the same executable typed request codec,
    suitable for composing the complete method registry without erasing schema
    validation. Unknown methods return [None]. *)
val request_codec : method_:string -> Jsonaf.t Api_codec.t option

module Operation : sig
  type t =
    { method_ : string
    ; params : Jsonaf.t
    ; alias : string option
    }

  (** Build the transaction operation union from executable request codecs.
      Only [creation_methods] admit an [as] binding; nested transactions have no
      branch unless incorrectly supplied by the caller. *)
  val codec
    :  requests:(string * Jsonaf.t Api_codec.t) list
    -> creation_methods:string list
    -> t Api_codec.t

  (** Ordered, nonempty batches contain at most 32 operations. Duplicate alias
      names are rejected here; reference kind resolution follows separately. *)
  val batch_codec
    :  requests:(string * Jsonaf.t Api_codec.t) list
    -> creation_methods:string list
    -> t list Api_codec.t
end

(** Executable method descriptors for requests and exact implemented receipts.
    Missing result-family codecs produce [None], making coverage gaps explicit. *)
val descriptor : method_:string -> Api_method.Packed.t option

(** Execute a resolved base mutation through its method descriptor. Request and
    handler response validation use the codecs advertised by [descriptor]. The
    handler owns durable publication; invalid published response data raises
    [Api_method.Invalid_response] and preserves uncertain write semantics. *)
val invoke_resolved
  :  method_:string
  -> params:Jsonaf.t
  -> f:(Planning_command.t -> (Jsonaf.t, Problem.t) Result.t)
  -> (Jsonaf.t, Problem.t) Result.t option

(** Validate a staged single-method receipt through the descriptor response
    codec without preparing again. Raises [Api_method.Invalid_response] for an
    invalid receipt. [None] explicitly denotes an uncovered method. *)
val validate_result : method_:string -> Jsonaf.t -> unit option
