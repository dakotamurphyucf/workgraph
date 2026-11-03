open Core
module Key = Amendment_id

module Reference : sig
  type t =
    { id : Key.t
    ; revision : int
    }
  [@@deriving sexp, compare, equal]

  val codec : t Api_codec.t
end

module Attribution : sig
  type t =
    { actor : Id.Actor.t
    ; run : Id.Run.t option
    ; timestamp : string
    }
  [@@deriving sexp, equal]
end

module Source : sig
  (** Retained authoritative text or exact immutable content pin. Notifications
      contain a separate bounded announcement, never a second text authority. *)
  type t =
    | Text of string
    | Resource of Evidence_event.Resource_pin.t
  [@@deriving sexp, equal]

  val codec : t Api_codec.t
end

module Ownership : sig
  type t =
    { actor : Id.Actor.t
    ; run : Id.Run.t option
    ; token : int
    }
  [@@deriving sexp, equal]
end

module Revision : sig
  module Publication : sig
    type t =
      { title : string
      ; source : Source.t
      ; require_ack : bool
      ; supersedes : Reference.t list
      }
    [@@deriving sexp, equal]
  end

  module Content : sig
    (** One append-only revision counter covers every lifecycle record. Terminal
        records refer to retained immutable publications instead of copying text.
        Withdrawn/superseded identities are never reactivated or republished. *)
    type t =
      | Published of Publication.t
      | Withdrawn of
          { previous : Reference.t
          ; reason : string
          }
      | Superseded of
          { previous : Reference.t
          ; replacement : Reference.t
          }
    [@@deriving sexp, equal]
  end

  type t =
    { reference : Reference.t
    ; ticket : Id.Ticket.t
    ; content : Content.t
    ; attribution : Attribution.t
    }
  [@@deriving sexp, equal]

  val codec : t Api_codec.t
end

module Acknowledgement : sig
  type t =
    { amendment : Reference.t
    ; ticket : Id.Ticket.t
    ; ownership : Ownership.t
    ; timestamp : string
    ; observed_unix_ms : int64 option
    }
  [@@deriving sexp, equal]

  val codec : t Api_codec.t
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t

  (** Validate the recorded server observation against the pre-ack claim lease.
      Timed ownership requires a clock; indefinite ownership may record [None].
      This never refreshes time and does not make clock part of the ack binding. *)
  val validate_lease : t -> lease:Allocation_lease.t -> (unit, Problem.t) Result.t
end

module Update : sig
  (** All records in a publication/supersession change are applied atomically.
      Publication precedes terminal records for its exact superseded heads. *)
  type t =
    | Revisions of Revision.t list
    | Acknowledged of Acknowledgement.t
  [@@deriving sexp, equal]
end

module Change : sig
  type t =
    { revision : int
    ; update : Update.t
    }
  [@@deriving sexp, equal]

  val codec : t Api_codec.t

  (** Routing uses immutable event records alone, independent of later heads. *)
  val targets : t -> Id.Ticket.t list

  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Problem.t) Result.t
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t
end

module Command : sig
  type t =
    | Publish of
        { id : Key.t
        ; ticket : Id.Ticket.t
        ; expected_revision : int
        ; title : string
        ; source : Source.t
        ; require_ack : bool
        ; supersedes : Reference.t list
        }
    | Withdraw of
        { amendment : Reference.t
        ; reason : string
        }
    | Acknowledge of
        { amendment : Reference.t
        ; ticket : Id.Ticket.t
        ; token : int
        }
  [@@deriving sexp]
end

type t
type prepared

val empty : t
val revision : t -> int
val to_json : t -> Jsonaf.t

val prepare
  :  t
  -> Command.t
  -> actor:Id.Actor.t
  -> run:Id.Run.t option
  -> timestamp:string
  -> now_unix_ms:int64 option
  -> ownership:(Id.Ticket.t -> Ownership.t option)
  -> (prepared, Problem.t) Result.t

val candidate : prepared -> t
val changes : prepared -> Change.t list
val result : prepared -> Jsonaf.t

(** Independent replay validates consecutive lifecycle counters, immutable
    revisions, exact terminal references and current ownership at each ack.
    [observed_unix_ms] is the server capture, not part of the stable ownership
    binding. Caller additionally validates it against the pre-ack lease (a timed
    claim requires a captured clock), without refreshing time during replay, and
    enforces external references. *)
val apply
  :  t
  -> Change.t
  -> ownership:(Id.Ticket.t -> Ownership.t option)
  -> (t, Problem.t) Result.t

val validate_references
  :  t
  -> ticket_exists:(Id.Ticket.t -> bool)
  -> resource_digest:(Id.Resource.t -> revision:int -> string option)
  -> (unit, Problem.t) Result.t

val get : t -> Reference.t -> Revision.t option
val head : t -> Key.t -> Revision.t option
val heads : t -> ticket:Id.Ticket.t option -> Revision.t list
val history : t -> Key.t -> Revision.t list
val acknowledgements : t -> Reference.t -> Acknowledgement.t list

(** Required active publications are satisfied only for this exact ownership.
    Progress/lease renewal retains satisfaction; replacement token does not.
    Terminal lifecycle records release the obsolete acknowledgement requirement. *)
val pending : t -> ticket:Id.Ticket.t -> ownership:Ownership.t option -> Reference.t list

val ensure_can_complete
  :  t
  -> ticket:Id.Ticket.t
  -> ownership:Ownership.t option
  -> (unit, Problem.t) Result.t

module Id = Amendment_id
