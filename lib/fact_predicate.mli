open Core

(** One scalar-equality predicate over a JSON pointer. Pointers are at most 512
    UTF-8 bytes and 16 segments, with RFC 6901 [~0]/[~1] escaping. The empty
    pointer selects the root. Array indices must be canonical nonnegative decimal
    integers; missing paths never match, including against JSON null.

    Scalars use exact canonical JSON representation equality: [1], [1.0] and
    [1e0] are distinct. Comparison never converts numbers to floating point.
    The expected scalar is at most 4096 canonical UTF-8 bytes. *)
type t

val create : pointer:string -> equals:Jsonaf.t -> (t, Problem.t) Result.t
val codec : t Api_codec.t

(** A conjunction of at most eight predicates. An empty list matches every
    supplied value, but does not manufacture a value for a deleted fact. *)
val conjunction_codec : t list Api_codec.t

(** Receiver first; [value] must be validated JSON with unique object keys.
    Traversal is bounded by the pointer's depth. No I/O or mutation. *)
val matches : t -> value:Jsonaf.t -> bool
