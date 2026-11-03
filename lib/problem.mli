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
  module Claim : sig
    module Field : sig
      type t =
        | Actor
        | Run
        | Token
      [@@deriving sexp, equal]
    end

    type ownership =
      | Unclaimed
      | Mismatch of
          { field : Field.t
          ; actor_id : string
          ; run_id : string option
          }
    [@@deriving sexp, equal]

    (** Only current public attribution is included. A token mismatch never
        includes either the submitted or the current fencing token. *)
    type t =
      { ticket_id : string
      ; ownership : ownership
      }
    [@@deriving sexp, equal]
  end

  module Communication_entity : sig
    type t =
      | Board
      | Thread
      | Team
      | Request
      | Message
      | Subscription
    [@@deriving sexp, equal]

    val to_string : t -> string
  end

  module Size_unit : sig
    type t =
      | Utf8_bytes
      | Canonical_json_bytes
    [@@deriving sexp, equal]
  end

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
    | Claim of Claim.t
    | Entity_revision of
        { entity : Communication_entity.t
        ; entity_id : string
        ; expected : int
        ; actual : int
        } (** Nonnegative, distinct revisions of the named communication entity. *)
    | Identity_collision of
        { entity : Communication_entity.t
        ; entity_id : string
        }
    | Size of
        { path : string list
        ; actual : int
        ; maximum : int
        ; unit : Size_unit.t
        } (** [actual > maximum >= 0]; size details survive nested decoder paths. *)
    | Socket_owner of { socket_path : string }
    (** With [Conflict], an active Workgraph guard owns this canonical socket
        pathname. This identifies competition, not readiness or peer health.
        Human-readable message text is not a discriminator. *)
    | Allocation of
        { ticket_id : string
        ; reasons : Allocation_admission_reason.t list
        ; omitted_reasons : int
        }
    (** At most 16 exact admission reasons; the total is the listed count plus
        [omitted_reasons]. No other owner's fencing tokens are disclosed. *)
    | Reservation_conflict of Reservation_conflict.t
    | Readiness of
        { ticket_id : string
        ; blockers : string list
        ; omitted_blockers : int
        }
    (** Total blockers = listed blockers + [omitted_blockers], with no synthetic
        marker counted as a blocker. Both producer and transport bounds preserve
        this total. *)
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
    are extended without losing their expectation, suggestion or typed size
    counts. [Size.path] remains an unescaped segment list. *)
val at_field : t -> string -> t

(** Conflict helpers keep entity identity distinct from the supplied revision.
    A failed create uses [identity_collision]; a guarded update uses
    [entity_revision], even when its expected revision is zero. *)
val identity_collision : Details.Communication_entity.t -> id:string -> t

val entity_revision
  :  Details.Communication_entity.t
  -> id:string
  -> expected:int
  -> actual:int
  -> t

(** Bounded diagnostic construction. [blockers] is the complete ordered list;
    at most 100 are retained with an exact omitted count. *)
val readiness_details : ticket_id:string -> blockers:string list -> Details.t

(** Exact current public error discriminator, shared by error envelopes and
    nested diagnostic records. Independent of derived OCaml sexps. *)
val wire_name : kind -> string

val to_json : t -> Jsonaf.t
