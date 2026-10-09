open Core

(** Accounting used by admission guards, not filesystem free space or measured
    process memory. Retained versions/tombstones count where their owner counts
    them. A remaining allowance is not a guarantee a future command will fit. *)
module Limit : sig
  type t =
    | Planning_commits
    | Planning_transaction_bytes
    | Planning_payload_bytes
    | History_commits
    | History_batch_bytes
    | Tickets
    | Projects
    | Milestones
    | Resources
    | Referenced_resource_bytes
    | Fact_keys
    | Fact_version_bytes
    | Active_uploads
    | Reserved_upload_bytes
  [@@deriving sexp, compare, equal]

  val maximum : t -> int
  val name : t -> string
  val codec : t Api_codec.t
  val all : t list
end

module Severity : sig
  (** Advisory bands: Normal below 50%, Notice at 50%, Warning at 80%, Critical
      at 95%. Exhaustion stays Critical; admission guards remain authoritative. *)
  type t =
    | Normal
    | Notice
    | Warning
    | Critical
  [@@deriving sexp, compare, equal]

  val codec : t Api_codec.t
end

module Lifetime : sig
  (** Cumulative retained history/entities have no supported in-place reclamation.
      Temporary upload occupancy is reclaimed by abort/publication/restart. *)
  type t =
    | Cumulative
    | Temporary
  [@@deriving sexp, equal]

  val codec : t Api_codec.t
end

type t [@@deriving sexp, equal]

(** Reject negative usage or usage exceeding the actual guard's ceiling. *)
val create : Limit.t -> used:int -> (t, Problem.t) Result.t

val limit : t -> Limit.t
val used : t -> int
val remaining : t -> int
val severity : t -> Severity.t
val threshold_percent : t -> int
val percent_used : t -> int
val lifetime : t -> Lifetime.t

(** Typed refusal details. [attempted] is proposed total utilization, never a delta;
    callers retain their existing domain error kind. These diagnostics do not
    replace any authoritative check. Negative or nonbinding declarations raise
    Invalid_argument (a programming error). Operator references point to installed
    capacity guidance; temporary upload limits direct users to abort staging. *)
val refusal : Limit.t -> used:int -> attempted:int -> kind:Problem.kind -> Problem.t

module Summary : sig
  (** Immutable bounded view over all 14 current meters: at most three most-used
      ratios, highest severity, warning count and explicit omitted-meter count.
      Construction rejects missing/duplicate meters; decoding validates visible
      meter arithmetic, ordering and summary consistency. No I/O or state scans. *)
  type meter = t

  type t

  val create : meter list -> (t, Problem.t) Result.t
  val meters : t -> meter list
  val codec : t Api_codec.t
end

(** Validates maximum, units, severity bands, lifetime and remaining against the selected limit, including
    during decoding; callers cannot fabricate unrelated headroom. *)
val codec : t Api_codec.t
