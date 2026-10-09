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
  (** Expected client-local I/O failure; does not diagnose daemon storage or
      imply any mutation was transmitted. Invalid input paths use Invalid_argument. *)
  | Local_io
  | Outcome_unknown
  | Workspace_closed
  | Unsupported_version
[@@deriving sexp, equal]

module Details : sig
  (** Public diagnostics, never internal domain records or another owner's token.
      Field paths are JSON pointer segments, ordered from outermost to innermost. *)
  type t =
    | Field of
        { path : string list
        ; expected : string
        ; suggestion : string option
        }
    | Revision of
        { expected : int
        ; actual : int
        }
    | Ownership of
        { actor_id : string
        ; run_id : string option
        }
    | Readiness of
        { ticket_id : string
        ; blockers : string list
        }
    | Version of
        { representation : string
        ; observed : string option
        ; supported : string
        }
    | Capacity of
        { meter : string
        ; used : int
        ; limit : int
        ; attempted : int
        ; unit : string
        ; operator_action : string
        }
    (** Counts are nonnegative in [unit]; [attempted] is the proposed total
        utilization, not an increment. The rejected operation was not admitted. *)
  [@@deriving sexp, equal]

  val to_json : t -> Jsonaf.t
end

type t =
  { kind : kind
  ; message : string
  ; details : Details.t option [@sexp.option]
  }
[@@deriving sexp]

val create : kind -> string -> t
val with_details : t -> Details.t -> t

(** Prefix a decoder failure with one field/index segment. Existing field paths
    are extended without losing their expectation or suggestion. *)
val at_field : t -> string -> t

(** Exact current public error discriminator, shared by error envelopes and
    nested diagnostic records. Independent of derived OCaml sexps. *)
val wire_name : kind -> string

val to_json : t -> Jsonaf.t
