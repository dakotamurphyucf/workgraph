open Core

(** Bounded JSON decoding. Only [Decode_error] is caught by [decode]; cancellation
    and implementation failures are never converted to validation errors. *)
exception Decode_error of Problem.t

val fail : Problem.kind -> string -> 'a
val decode : (unit -> 'a) -> ('a, Problem.t) Result.t
val parse : string -> (Jsonaf.t, Problem.t) Result.t

(** Storage-only bound override (at most 64MiB); wire parsing keeps 4MiB. Both
    profiles reject duplicate keys and nesting beyond 64 levels. *)
val parse_with_limit : max_bytes:int -> string -> (Jsonaf.t, Problem.t) Result.t

val canonical : Jsonaf.t -> string
val pretty : Jsonaf.t -> string
val obj : (string * Jsonaf.t) list -> Jsonaf.t
val string : string -> Jsonaf.t
val int : int -> Jsonaf.t
val int64 : int64 -> Jsonaf.t
val field : Jsonaf.t -> string -> Jsonaf.t
val optional : Jsonaf.t -> string -> Jsonaf.t option
val text : Jsonaf.t -> string
val bounded_text : Jsonaf.t -> max_bytes:int -> string
val integer : Jsonaf.t -> int

(** Canonical decimal strings in [0, 2^63 - 1]. [integer] additionally checks the
    native integer range; callers impose field-specific operational limits. *)
val integer64 : Jsonaf.t -> int64

val list : Jsonaf.t -> Jsonaf.t list
val fields : Jsonaf.t -> allowed:string list -> unit
val hash : string -> string
