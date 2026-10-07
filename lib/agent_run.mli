open Core
module Status = Agent_run_event.Status
module Parent_stop_policy = Agent_run_event.Parent_stop_policy
module Runner_action = Agent_run_event.Runner_action
module Record = Agent_run_event.Record
module Change = Agent_run_event

module Command : sig
  type t =
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
end

type t
type prepared

val empty : t
val revision : t -> int

val prepare
  :  t
  -> ?now_unix_ms:int64
  -> Command.t
  -> actor:Id.Actor.t
  -> run:Id.Run.t option
  -> timestamp:string
  -> sequence:int
  -> (prepared, Problem.t) Result.t

val candidate : prepared -> t
val changes : prepared -> Change.t list
val result : prepared -> Jsonaf.t

(** Replay checks counters, immutable provenance, lifecycle and reservation
    fencing. Input state remains immutable on every error. *)
val apply : t -> Change.t -> (t, Problem.t) Result.t

val validate_references
  :  t
  -> ticket_exists:(Id.Ticket.t -> bool)
  -> session_exists:(Session_id.t -> bool)
  -> resource_version_exists:(Id.Resource.t -> revision:int -> bool)
  -> handoff_exists:(Id.Ticket.t -> revision:int -> bool)
  -> (unit, Problem.t) Result.t

val validate_attempt_owner
  :  t
  -> Attempt.Id.t
  -> actor:Id.Actor.t
  -> run:Id.Run.t
  -> ticket:Id.Ticket.t
  -> token:int
  -> (unit, Problem.t) Result.t

val validate_reservation_owner
  :  t
  -> ?now_unix_ms:int64
  -> Reservation.Name.t
  -> run:Id.Run.t
  -> token:int
  -> (unit, Problem.t) Result.t

val get_run : t -> Id.Run.t -> Record.t option
val get_attempt : t -> Attempt.Id.t -> Attempt.t option
val get_reservation : t -> Reservation.Name.t -> Reservation.t option
val attempts_for_ticket : t -> Id.Ticket.t -> Attempt.t list
val pending_actions : t -> Runner_action.t list
val session_references : t -> Session_id.t list

(** Silence is a derived indication, never a terminal transition. Times count
    UTC milliseconds; a backwards clock reports stale conservatively. *)
val stale : Record.t -> now_unix_ms:int64 -> after_ms:int64 -> bool

val decode : method_:string -> params:Jsonaf.t -> (Command.t, Problem.t) Result.t
val encode : Command.t -> string * Jsonaf.t
val query : t -> method_:string -> params:Jsonaf.t -> (Jsonaf.t, Problem.t) Result.t
val mutation_methods : string list
val query_methods : string list
val to_json : t -> Jsonaf.t
val get_ticket_policy : t -> Id.Ticket.t -> Allocation.Ticket_policy.t option

val allocation_candidate
  :  t
  -> ticket:Id.Ticket.t
  -> priority:int
  -> creation_sequence:int
  -> ready:bool
  -> available:bool
  -> Allocation.Candidate.t

val attempts_for_run : t -> Id.Run.t -> Attempt.t list
val runs : t -> Record.t list
val attempts : t -> Attempt.t list
val reservations : t -> Reservation.t list
val pools : t -> Allocation.Definition.t list
val ticket_policies : t -> Allocation.Ticket_policy.t list
