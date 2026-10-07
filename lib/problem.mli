open Core

type kind =
  | Invalid_argument
  | Not_found
  | Conflict
  | Blocked
  | Dependency_cycle
  | Already_claimed
  | Stale_claim
  | Idempotency_conflict
  | Corrupt_store
  | Storage_unavailable
  | Outcome_unknown
  | Workspace_closed
  | Unsupported_version
[@@deriving sexp, equal]

type t =
  { kind : kind
  ; message : string
  }
[@@deriving sexp]

val create : kind -> string -> t
val to_json : t -> Jsonaf.t
