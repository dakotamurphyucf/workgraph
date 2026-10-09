open Core

(** Exact immutable provenance, not a promise that a current getter still returns
    a historical record. Counters positive except handoff coverage (>=0); digest
    row ordinals are zero-based within one committed workspace revision. *)
type t =
  | Ticket of
      { id : Id.Ticket.t
      ; revision : int
      }
  | Handoff of
      { ticket : Id.Ticket.t
      ; revision : int
      ; covers_through : int
      }
  | Comment of
      { id : Id.Comment.t
      ; revision : int
      ; sequence : int
      }
  | Fact of
      { scope : Facts.Scope.t
      ; key : Facts.Key.t
      ; revision : int
      ; changed_at_revision : int
      }
  | Run of
      { id : Id.Run.t
      ; revision : int
      }
  | Attempt of
      { id : Attempt.Id.t
      ; revision : int
      }
  | Request of
      { id : Communication_id.Request.t
      ; revision : int
      }
  | Condition of
      { id : Coordination_id.Condition.t
      ; revision : int
      }
  | Ticket_recovery of
      { id : Coordination_id.Recovery.t
      ; sequence : int
      }
  | Reservation_recovery of
      { id : Coordination_id.Recovery.t
      ; sequence : int
      }
  | Resource_version of Evidence_event.Resource_pin.t
  | Planning_change of
      { workspace_revision : int
      ; change_index : int
      }
[@@deriving sexp_of, equal]

val codec : t Api_codec.t
val label : t -> string
