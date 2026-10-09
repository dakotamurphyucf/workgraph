open Core

(** Executable transport contracts. Domain method descriptors are composed with
    their real scope/attribution codecs here; this is not an independent schema
    registry. [None] denotes an unknown method. Every supported transport method
    must have a descriptor; missing family declarations fail at construction. *)
val methods : Api_method.Packed.t list

val find : string -> Api_method.Packed.t option
val request_fields : string -> string list option

val validate_request
  :  method_:string
  -> params:Jsonaf.t
  -> (unit, Problem.t) Result.t option

(** Final wire conformance check for known methods, including metadata. Raises
    [Api_method.Invalid_response] on a programming error; this is not a client
    input error. Durable mutations must also validate receipts during pure
    preparation, before publication. *)
val validate_response : method_:string -> Api_response.t -> unit option

(** Complete schemas for supported methods, sorted by method name.
    Schema-only consumers must honor the stated Draft 2020-12 dialect and the
    documented domain-bound extensions; runtime validation remains authoritative. *)
val describe : unit -> Jsonaf.t
