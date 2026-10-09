open Core

(** Current public comment reads, scoped by the catalog. Discussion's durable
    records and private source-message snapshots retain their own encodings. *)
val methods : Api_method.Packed.t list

val request_codec : method_:string -> Jsonaf.t Api_codec.t option
val response_codec : method_:string -> Jsonaf.t Api_codec.t option
val validate_request : method_:string -> Jsonaf.t -> (unit, Problem.t) Result.t

(** Invalid internal result projections raise [Api_method.Invalid_response]. *)
val validate_result : method_:string -> Jsonaf.t -> unit
