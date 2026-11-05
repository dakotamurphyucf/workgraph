open Core

(** Opt-in client traversal of one declared read collection. Never a transaction,
    mutation, automatic retry, latest-revision restart or multi-section merge. *)
module Limits : sig
  type t

  (** 1..1000 requests; 4096..64MiB canonical result bytes, including page
      envelopes and continuation metadata. At most one extra bounded response is
      held while determining whether the next page fits. An initial opaque-cursor
      read additionally requires room for its first bounded response and cursor
      metadata; it rejects before fetching rather than discard that capture. *)
  val create : max_pages:int -> max_bytes:int -> (t, Problem.t) Result.t

  val default : t
end

type t

(** Validate the exact request using its executable codec. Supports top-level
    offset collections with their declared capture guard, opaque-cursor reads,
    inbox.read's notification through bound and immutable history-head traversal.
    Offset capture metadata follows the method's public response layout; a
    request guard named [expected_revision] can refer to either a workspace or
    a domain revision. Callers never supply response metadata as request fields.
    [usage.aggregate] and [actor.overview] traverse their flat top-level rows
    using current-workspace revision cursors; actor observation time remains
    captured and usage [at_revision] is retained. Their whole-row byte fitting
    preserves the exact unconsumed cursor. [attention.read] remains unsupported:
    its independently paged readiness section needs explicit manual traversal.
    Unsupported nested collections, waits and writes reject before I/O. Existing
    guards/selectors/filters are retained; only actual family positions advance.
    A captured current-revision guard detects changes; it is not time travel. *)
val create : Protocol.Request.t -> limits:Limits.t -> (t, Problem.t) Result.t

val supported_methods : unit -> string list

module Stop : sig
  type t =
    | Complete
    | Page_limit
    | Byte_limit
    | No_progress
    | Needs_larger_budget
    | Indexing_incomplete
    | Server_field_omissions
    | Server_item_omissions
    | Error
    | Metadata_limit
  [@@deriving equal, sexp]

  val to_string : t -> string
end

(** Exact continuation for one already returned page. This is a pure projection:
    it performs no fetch, retry, acknowledgement or fallback to newer state.
    Serialized metadata has its own 65536-byte cap, separate from the original
    daemon response budget. Oversized exact request metadata yields incomplete
    [Metadata_limit], with no clipped request or invented continuation. *)
module Continuation : sig
  type t

  (** Methods with single-response continuation metadata, including nested
      collections that are intentionally excluded from automatic traversal. *)
  val supported_methods : unit -> string list

  (** Whether this request shape can receive continuation metadata. A method
      may support only particular directions or selectors. *)
  val supports : Protocol.Request.t -> bool

  (** Validate the original supported read and its public result codec, then bind
      the actual family capture. All request selectors remain exact; only declared
      paging positions advance. Current guards remain current guards, immutable
      cursors/head captures remain immutable. Malformed pages and conflicting
      explicit guards reject. The first omitted or unconsumed position never moves
      to a fresh initial request. [ticket.resume] history continues intentionally
      through [activity.digest] with the exact ticket scope and captured cursor. *)
  val of_response : Protocol.Request.t -> response:Jsonaf.t -> (t, Problem.t) Result.t

  val complete : t -> bool
  val stop : t -> Stop.t
  val next_request : t -> Protocol.Request.t option
  val retry_request : t -> Protocol.Request.t option
  val to_json : t -> Jsonaf.t
end

module Collection : sig
  type t

  val complete : t -> bool
  val stop : t -> Stop.t

  (** Local workflow envelope with exact pages and explicit stop reason, byte
      counts, capture kind and a next/retry request where the exact captured
      position is recoverable. Missing exact retry stays null; a fresh initial
      read is never labelled a captured continuation. A fetch failure is retained
      unchanged beside accepted pages; it never becomes successful completion.
      Server text omissions and oversized/no-progress rows remain incomplete.
      Complete means collection traversal ended, not that source/index coverage
      is universally complete; each original page retains coverage diagnostics. *)
  val to_json : t -> Jsonaf.t
end

(** Fetch each request once. Expected transport/domain Problems are preserved in
    an incomplete Collection. If that exact Problem cannot fit the total bound,
    it returns as Error unchanged. External cancellation and unexpected exceptions
    propagate. The callback must provide a validated public {data,meta} envelope;
    per-method data codecs are enforced here as well. *)
val collect
  :  t
  -> fetch:(Protocol.Request.t -> (Jsonaf.t, Problem.t) Result.t)
  -> (Collection.t, Problem.t) Result.t

val run : t -> client:Client.t -> (Collection.t, Problem.t) Result.t
