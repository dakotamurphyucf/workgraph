open Core

(** Public wire codecs. The same declarations encode, validate, and describe data;
    storage codecs remain independent. Decimals are canonical nonnegative strings,
    including on platforms where JSON numbers cannot represent them exactly.
    [decode] catches only [Json.Decode_error]; cancellation and bugs propagate. *)
type 'a t

type 'a codec = 'a t

val decode : 'a t -> Jsonaf.t -> ('a, Problem.t) Result.t
val encode : 'a t -> 'a -> (Jsonaf.t, Problem.t) Result.t

(** Structural JSON Schema generated from the actual codec declarations.
    [x-maxUtf8Bytes] and [x-maximumDecimal] expose bounds enforced by this codec;
    ordinary JSON Schema validators ignore those extension keywords. Mapped
    domain invariants are explained in [description], not inferred as schemas. *)
val schema : 'a t -> Jsonaf.t

(** Append explanatory context to typed decoding failures, preserving their kind,
    field paths and suggestions. Underlying validation and wire shape are unchanged;
    the schema adds the context as a description. Other exceptions propagate. *)
val with_error_context : 'a t -> context:string -> 'a t

(** Declared top-level object field names, including mapped/tagged object
    alternatives. [None] denotes a scalar, array, nullable object, or dictionary
    with arbitrary keys. Names come from the executable codec declaration. *)
val field_names : 'a t -> string list option

(** Interpret a named CLI scalar from declared top-level field types. Only an
    unambiguous Boolean field converts [true]/[false]; text/decimal values remain
    strings. Mixed Boolean alternatives reject with instructions for explicit JSON.
    This function is never used for raw JSON or parameter-file input. *)
val cli_value : 'a t -> field:string -> string -> (Jsonaf.t, Problem.t) Result.t

(** Compose disjoint exact objects into one flat request. Both original decoders
    and mapped invariants still execute; unknown/duplicate fields reject. Invalid
    declarations (non-object codecs or overlapping fields) raise Invalid_argument.
    The generated schema uses Draft 2020-12 unevaluatedProperties so tagged branches
    remain closed without duplicating their field definitions. *)
val merge_objects : 'a t -> 'b t -> ('a * 'b) t

(** Validate through the same codec while preserving the original JSON exactly,
    including omission and caller ordering. Useful at a generic transport boundary;
    it does not normalize saved mutation identities or synthesize defaults. *)
val as_json : 'a t -> Jsonaf.t t

val text : max_bytes:int -> string t

(** One exact UTF-8 string, for method names and other discriminators that are not
    simple enums. An invalid UTF-8 declaration raises Invalid_argument. *)
val literal : string -> unit t

val boolean : bool t
val decimal : max:int -> int t
val decimal64 : max:int64 -> int64 t
val nullable : 'a t -> 'a option t
val list : 'a t -> max_items:int -> 'a list t

(** Arbitrary valid JSON, bounded by canonical UTF-8 bytes and container nesting
    depth (1..64). Duplicate keys, invalid UTF-8 and non-finite numbers reject.
    The schema records the enforced bounds as extension annotations. *)
val json : max_bytes:int -> max_depth:int -> Jsonaf.t t

(** Additional domain invariants may reject decoding. Encoding also revalidates
    the result, so an invalid domain value cannot bypass the public contract.
    [description] explains invariants beyond the structural JSON schema. *)
val map
  :  'a t
  -> decode:('a -> ('b, Problem.t) Result.t)
  -> encode:('b -> 'a)
  -> description:string
  -> 'b t

(** Lowercase simple enums. Names must be unique and nonempty; duplicate values
    are rejected using the supplied typed equality. Invalid declarations raise
    [Invalid_argument], as a programming error. *)
val enum : (string * 'a) list -> equal:('a -> 'a -> bool) -> 'a t

(** Raw transaction references retain aliases as aliases, without inventing a
    domain ID. Wire representation remains an ID string or "$alias". *)
type 'a reference =
  | Literal of 'a
  | Alias of string

(** [literal] validates typed literal IDs. Alias keys use the same ASCII ID
    grammar (1..96 bytes); "$" adds one wire byte. The actual generated schema
    is anyOf [literal schema] and a string with explicit "$alias" pattern.
    This does not resolve aliases. Callers resolve only declared reference fields
    with the correct entity kind, then decode the resolved domain request. *)
val reference : 'a t -> 'a reference t

module Fields : sig
  (** An object codec under construction. Composition rejects duplicate names.
      Required/optional presence drives validation and schema together. *)
  type 'a t

  val empty : unit t
  val names : 'a t -> string list
  val required : string -> 'a codec -> 'a t
  val optional : string -> 'a codec -> 'a option t
  val both : 'a t -> 'b t -> ('a * 'b) t
  val map : 'a t -> decode:('a -> 'b) -> encode:('b -> 'a) -> 'b t
end

(** Exact objects: reject unknown/duplicate fields. Missing optional fields are
    absent; explicit null is accepted only by a nullable field codec. *)
val object_ : 'a Fields.t -> 'a t

(** Tagged object alternatives. The discriminator is required in every branch;
    branch codecs validate its exact value and fields. Unknown tags are rejected.
    [select] chooses the branch when encoding; the branch revalidates the value. *)
val tagged
  :  discriminator:string
  -> cases:(string * 'a t) list
  -> select:('a -> string)
  -> 'a t

(** JSON objects with arbitrary unique string keys and uniformly typed values.
    Both entry count and each key's UTF-8 byte length are bounded. *)
val dictionary : 'a t -> max_items:int -> max_key_bytes:int -> (string * 'a) list t
