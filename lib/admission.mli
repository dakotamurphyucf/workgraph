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
end

type t [@@deriving sexp, equal]

(** Reject negative usage or usage exceeding the actual guard's ceiling. *)
val create : Limit.t -> used:int -> (t, Problem.t) Result.t

val limit : t -> Limit.t
val used : t -> int
val remaining : t -> int

(** Validates maximum, units and remaining against the selected limit, including
    during decoding; callers cannot fabricate unrelated headroom. *)
val codec : t Api_codec.t
