open Core

(** Current resolved records. Event values remain separate from commands;
    commands and live state implementation may evolve independently. *)
module Status : sig
  type t =
    | Running
    | Waiting
    | Completed
    | Failed
    | Cancelled
  [@@deriving sexp, equal, jsonaf]

  val terminal : t -> bool
end

module Parent_stop_policy : sig
  type t =
    | Continue
    | Request_cancel
    | Request_wait
  [@@deriving sexp, equal, jsonaf]
end

module Runner_action : sig
  type t =
    { parent : Id.Run.t
    ; child : Id.Run.t
    ; policy : Parent_stop_policy.t
    }
  [@@deriving sexp, equal, jsonaf]
end

module Record : sig
  type t =
    { id : Id.Run.t
    ; revision : int
    ; parent : Id.Run.t option
    ; parent_stop_policy : Parent_stop_policy.t
    ; objective : string
    ; actor : Id.Actor.t
    ; capabilities : string list
    ; sessions : Session_id.t list
    ; process_ref : string option
    ; worktree_ref : string option
    ; status : Status.t
    ; last_observed_unix_ms : int64 option
    ; evidence : string
    }
  [@@deriving sexp, equal, jsonaf]

  (** Validates positive counters, bounded metadata, unique links and terminal
      evidence. The JSON decoder also validates these invariants. Raises
      [Json.Decode_error] on invalid records. *)
  val validate : t -> unit
end

module Recovery_snapshot : sig
  type t =
    | Named of Reservation.t
    | Path of Path_reservation.t
  [@@deriving sexp, equal, jsonaf]
end

module Update : sig
  type t =
    | Pool_put of Allocation.Definition.t
    | Ticket_policy_put of Allocation.Ticket_policy.t
    | Run_put of Record.t
    | Attempt_started of
        { attempt : Attempt.t
        ; now_unix_ms : int64
        }
    | Attempt_put of Attempt.t
    | Reservation_put of Reservation.t
    | Path_reservation_put of Path_reservation.t
    | Ticket_paths_put of Ticket_paths.t
    | External_condition_changed of External_condition.Change.t
    | Ownership_recovered of
        { recovery : Ownership_recovery.t
        ; after : Recovery_snapshot.t
        }
    | Actions_set of
        { actions : Runner_action.t list
        ; evidence : string
        }
  [@@deriving sexp, equal, jsonaf]
end

type t =
  { version : int
  ; revision : int
  ; actor : Id.Actor.t
  ; actor_run : Id.Run.t option
  ; timestamp : string
  ; sequence : int
  ; update : Update.t
  }
[@@deriving sexp, equal, jsonaf]

val validate : t -> unit
