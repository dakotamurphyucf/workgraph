open Core

(** Typed cooperative coordination commands; all preparation and replay is pure. *)
type t =
  | Paths_acquire of
      { run : Id.Run.t
      ; requests : Path_reservation.Request.t list
      }
  | Path_renew of
      { run : Id.Run.t
      ; target : Path_scope.t
      ; token : int
      ; expected_lease_revision : int
      }
  | Path_release of
      { run : Id.Run.t
      ; target : Path_scope.t
      ; token : int
      }
  | Ticket_paths_put of
      { ticket_id : Id.Ticket.t
      ; expected_revision : int
      ; declarations : Ticket_paths.Declaration.t list
      ; require_reservations : bool
      }
  | Condition of External_condition.Command.t
  | Recover of Ownership_recovery.Request.t
[@@deriving sexp]
