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

let create kind message = { kind; message }

(* Current public wire names are intentionally independent of derived OCaml sexps. *)
let wire_name = function
  | Invalid_argument -> "Invalid_argument"
  | Not_found -> "Not_found"
  | Conflict -> "Conflict"
  | Blocked -> "Blocked"
  | Dependency_cycle -> "Dependency_cycle"
  | Already_claimed -> "Already_claimed"
  | Stale_claim -> "Stale_claim"
  | Idempotency_conflict -> "Idempotency_conflict"
  | Corrupt_store -> "Corrupt_store"
  | Storage_unavailable -> "Storage_unavailable"
  | Outcome_unknown -> "Outcome_unknown"
  | Workspace_closed -> "Workspace_closed"
  | Unsupported_version -> "Unsupported_version"
;;

let to_json t =
  `Object [ "kind", `String (wire_name t.kind); "message", `String t.message ]
;;
