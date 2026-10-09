open Core
module Status = Agent_run_event.Status
module Parent_stop_policy = Agent_run_event.Parent_stop_policy

type t =
  | Coordination of Agent_coordination_command.t
  | Pool_put of
      { name : string
      ; expected_revision : int
      ; limit : int
      }
  | Ticket_policy_put of
      { ticket : Id.Ticket.t
      ; expected_revision : int
      ; required_capabilities : string list
      ; pools : string list
      }
  | Register of
      { id : Id.Run.t
      ; parent : Id.Run.t option
      ; parent_stop_policy : Parent_stop_policy.t
      ; objective : string
      ; capabilities : string list
      ; process_ref : string option
      ; worktree_ref : string option
      }
  | Transition of
      { id : Id.Run.t
      ; expected_revision : int
      ; status : Status.t
      ; evidence : string
      }
  | Observe of
      { id : Id.Run.t
      ; expected_revision : int
      ; observed_unix_ms : int64
      }
  | Link_session of
      { id : Id.Run.t
      ; expected_revision : int
      ; session : Session_id.t
      }
  | Attempt_start of
      { id : Attempt.Id.t
      ; run : Id.Run.t
      ; ticket : Id.Ticket.t
      ; token : int
      ; sessions : Session_id.t list
      }
  | Attempt_checkpoint of
      { id : Attempt.Id.t
      ; expected_revision : int
      ; checkpoint : Attempt.Checkpoint.t
      }
  | Attempt_finish of
      { id : Attempt.Id.t
      ; expected_revision : int
      ; state : Attempt.State.t
      ; evidence : string
      }
  | Reservation_acquire of
      { run : Id.Run.t
      ; requests : Reservation.request list
      }
  | Reservation_renew of
      { run : Id.Run.t
      ; name : Reservation.Name.t
      ; token : int
      ; expected_lease_revision : int
      }
  | Reservation_release of
      { run : Id.Run.t
      ; name : Reservation.Name.t
      ; token : int
      }
  | Action_acknowledge of
      { child : Id.Run.t
      ; evidence : string
      }
[@@deriving sexp]
