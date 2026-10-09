open Core

module Scope : sig
  type t =
    | Workspace
    | Project of Id.Project.t
    | Milestone of Id.Milestone.t
    | Ticket of Id.Ticket.t
  [@@deriving sexp, compare, equal]

  include Comparable.S with type t := t

  val codec : t Api_codec.t
  val target : t -> Entity_ref.t
end

module Key : sig
  type t [@@deriving sexp, compare, equal]

  val of_string : string -> (t, Problem.t) Result.t
  val to_string : t -> string
  val codec : t Api_codec.t
end

module Value : sig
  (** At most 4096 canonical UTF-8 bytes and 16 container levels. Null is a value,
      not deletion. Object keys must be unique; numbers must be finite JSON. *)
  type t [@@deriving sexp]

  val of_json : Jsonaf.t -> (t, Problem.t) Result.t
  val to_json : t -> Jsonaf.t
  val type_name : t -> string
  val codec : t Api_codec.t
end

module Command : sig
  type t =
    | Put of
        { scope : Scope.t
        ; key : Key.t
        ; expected_revision : int
        ; value : Value.t
        }
    | Delete of
        { scope : Scope.t
        ; key : Key.t
        ; expected_revision : int
        }
  [@@deriving sexp]

  val codec : string -> (t Api_codec.t, Problem.t) Result.t

  (** The same request fields, permitting transaction aliases only in scope IDs.
      JSON fact values remain literal, including strings beginning with [$]. *)
  val raw_codec : string -> (Jsonaf.t Api_codec.t, Problem.t) Result.t

  val decode : method_:string -> params:Jsonaf.t -> (t, Problem.t) Result.t
  val encode : t -> (string * Jsonaf.t, Problem.t) Result.t
  val target : t -> Entity_ref.t
end

module Change : sig
  (** A resolved immutable version. apply checks contiguous key revisions;
      planning replay additionally binds actor/run/sequence to its outer commit. *)
  type t

  val sexp_of_t : t -> Sexp.t
  val t_of_sexp : Sexp.t -> t
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t
  val of_json : Jsonaf.t -> (t, Problem.t) Result.t
  val to_json : t -> Jsonaf.t

  (** Exact immutable attributed public version, including deleted/value invariant. *)
  val codec : t Api_codec.t

  val target : t -> Entity_ref.t
  val scope : t -> Scope.t
  val key : t -> Key.t
  val revision : t -> int
  val value : t -> Value.t option
  val actor : t -> Id.Actor.t
  val run : t -> Id.Run.t option
  val sequence : t -> int
  val timestamp : t -> string
end

(** Immutable facts with explicit scopes, no fallback or inheritance. Each key
    retains attributed versions and tombstones. Shared writes use revision guards;
    zero creates a new key, while recreating a tombstone uses its current revision.
    Capacity: 10000 distinct keys (tombstones count) and 16MiB of retained
    canonical version metadata. Versions retain all previous immutable values.
    Mutations check only the current key head and update retained byte accounting. *)
type t

val empty : t

(** Retained keys include tombstones; byte accounting is the same cached value
    used to admit a new version. No value bodies are returned. *)
val admission : t -> Admission.t list

val prepare
  :  t
  -> Command.t
  -> actor:Id.Actor.t
  -> run:Id.Run.t option
  -> timestamp:string
  -> sequence:int
  -> (Change.t * Jsonaf.t, Problem.t) Result.t

(** Revalidates resolved versions, revision continuity, nondecreasing event
    sequence, capacity and tombstone lifecycle. Outer replay must additionally
    bind scope existence and actor/run/timestamp/sequence to its durable event. *)
val apply : t -> Change.t -> (t, Problem.t) Result.t

val validate_targets : t -> exists:(Entity_ref.t -> bool) -> (unit, Problem.t) Result.t
val mutation_methods : string list
val query_methods : string list

(** Pure bounded queries. Method arguments exclude workspace_id, include explicit
    scope, and use planning at_revision for stable offset pagination. Keys returns
    metadata without values; multi_get returns requested keys in caller order with
    explicit missing keys. List/keys default to active keys; [include_deleted]
    enables tombstones; optional [prefix] on list/keys is an exact case-sensitive
    UTF-8 prefix of at most 128 bytes (empty is allowed). Get and multi_get return retained tombstones explicitly;
    history is oldest-first. Search covers current active key and canonical value
    text. Scope/key ordering is deterministic; duplicate multi_get keys retain
    caller order. Offset pages require an exact workspace [at_revision].
    Get accepts scope/key/at_revision/max_bytes; other methods also accept
    limit/offset. Include_deleted is accepted only by list/keys. Limits default
    to 50, bounded 1..100; max_bytes defaults to 64KiB, bounded 4KiB..1MiB.
    All results use internal planning data/workspace_revision/budget layout,
    measured against the final public response. Whole items are omitted when
    needed; arbitrary JSON values are never clipped. If no selected item fits,
    returns Invalid_argument instructing clients to increase the budget.
    Get's data is one current record; all other data is a page object. *)
val query
  :  t
  -> workspace_revision:int
  -> method_:string
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t

(** Current retained head, including a tombstone. Exact scopes only, no implicit
    fallback or inheritance. Scope/key enumeration is comparator ordered and
    includes deleted keys so callers can distinguish missing from deleted. *)
val current : t -> scope:Scope.t -> key:Key.t -> Change.t option

val current_versions : t -> scope:Scope.t -> ?prefix:string -> unit -> Change.t list

(** Actual attributed public current record; includes value_type for active
    values and preserves tombstone provenance. Validate with fact.get codec. *)
val current_record : Change.t -> Jsonaf.t

(** Same exact attributed metadata record used by fact.keys; context discovery
    reuses this declaration without copying a weaker record schema. *)
val key_metadata_codec : Jsonaf.t Api_codec.t

(** Retained versions in deterministic scope/key order for canonical export. *)
val to_json : t -> Jsonaf.t

(** One file per scope, including retained history; keys are never filenames. *)
val readable_files : t -> (string * string) Sequence.t

(** Metadata-only discoveries for one exact scope, excluding tombstones. Returns
    {items,total,remaining}; limit is clamped to 0..100. Context callers explicitly
    choose scopes; values are retrieved separately. Traverses all retained keys. *)
val keys : t -> scope:Scope.t -> limit:int -> Jsonaf.t

val search_documents : t -> Search.Document.t list

module Query : sig
  type t

  val codec : string -> (t Api_codec.t, Problem.t) Result.t
end

val query_codec : string -> (Query.t Api_codec.t, Problem.t) Result.t

(** Actual method data codecs, before the common {data;meta} response envelope.
    Validate JSON value/tombstone/type relationships as well as structure. *)
val response_codec : string -> (Jsonaf.t Api_codec.t, Problem.t) Result.t

(** Generated directly from Command/Query and response codec declarations. *)
val request_schema : string -> (Jsonaf.t, Problem.t) Result.t

val response_schema : string -> (Jsonaf.t, Problem.t) Result.t
