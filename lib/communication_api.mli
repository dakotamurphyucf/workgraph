open Core

(** Executable domain request/result descriptors. All requests are unscoped;
    the catalog adds the correct workspace or mutation identity. The existing
    message/inbox descriptors remain owned by their dedicated modules. *)
val methods : Api_method.Packed.t list

val query_methods : string list
val request_codec : method_:string -> Jsonaf.t Api_codec.t option
val response_codec : method_:string -> Jsonaf.t Api_codec.t option

(** Retain raw caller JSON identity after checking the actual query codec.
    Runtime executes against immutable paired communication/discussion state. *)
val validate_query : method_:string -> params:Jsonaf.t -> (unit, Problem.t) Result.t

(** Check the projected response after fitting. Invalid programmer output raises
    Invalid_response rather than turning an uncertain write into a domain error. *)
val validate_result : method_:string -> Jsonaf.t -> unit
