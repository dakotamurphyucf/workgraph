open Core
module Status = Agent_run_event.Status
module Parent_stop_policy = Agent_run_event.Parent_stop_policy
module Runner_action = Agent_run_event.Runner_action
module Record = Agent_run_event.Record
module Change = Agent_run_event
module Command = Agent_run_command

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

module Start_blocker : sig
  type t =
    | Run_required of Path_scope.t
    | Path_conflict of
        { target : Path_scope.t
        ; reservation : Path_scope.t
        ; holder : Reservation.Holder.t
        }
    | Expired_required_ownership of
        { target : Path_scope.t
        ; reservation : Path_scope.t
        ; holder : Reservation.Holder.t
        }
    | Ownership_mode of
        { target : Path_scope.t
        ; holder : Reservation.Holder.t
        }
    | External_condition of External_condition.Blocker.t
  [@@deriving sexp, equal]

  val to_json : t -> Jsonaf.t
end

(** Required paths and current unsatisfied external declarations gate readiness.
    Expiry never releases ownership. No run gives an actionable path blocker.
    Live compatible covering holds are reused; upgrades are never implicit. *)
val start_blockers
  :  t
  -> ticket:Id.Ticket.t
  -> run:Id.Run.t option
  -> now_unix_ms:int64
  -> Start_blocker.t list

(** Immutable preparation of all missing required paths. The lifecycle stages
    these changes with claim/attempt changes in one serialized durable commit.
    New automatic holds are indefinite; renew timed existing holds explicitly. *)
val prepare_start_reservations
  :  t
  -> ticket:Id.Ticket.t
  -> run:Id.Run.t
  -> actor:Id.Actor.t
  -> timestamp:string
  -> sequence:int
  -> now_unix_ms:int64
  -> (prepared, Problem.t) Result.t

val get_path_reservation : t -> Path_scope.t -> Path_reservation.t option
val get_ticket_paths : t -> Id.Ticket.t -> Ticket_paths.t option
val path_reservations : t -> Path_reservation.t list
val ticket_paths : t -> Ticket_paths.t list
val external_conditions : t -> External_condition.t
val get_recovery : t -> Coordination_id.Recovery.t -> Ownership_recovery.t option
val recoveries : t -> Ownership_recovery.t list

(** Validate historical declaration/signal/recovery pins against the final staged
    immutable capture, after all transaction operations have applied. *)
val validate_coordination_references
  :  t
  -> ticket_exists:(Id.Ticket.t -> bool)
  -> pin_exists:(Evidence_event.Pin.t -> bool)
  -> (unit, Problem.t) Result.t

val event_references : t -> Session.Event_ref.t list

(** Most recently started attempt under the exact ticket claim token, including
    terminal attempts. Ordering is its immutable coordination creation revision;
    later updates and identifier spelling do not reorder attempts. *)
val latest_attempt_for_ticket : t -> ticket:Id.Ticket.t -> token:int -> Attempt.t option

(** Paths whose existing timed ownership needs an explicit observation clock. *)
val start_clock_required
  :  t
  -> ticket:Id.Ticket.t
  -> run:Id.Run.t option
  -> Path_scope.t list

(** Called only inside an enclosing guarded durable ticket-recovery transition.
    Rechecks each active attempt's exact ticket/token/run and registered actor,
    then cancels it with the recovery reason. Preserves terminal history and never
    changes replacement ownership. The enclosing audit is the durable event. *)
val cancel_recovered_attempts
  :  t
  -> Ticket_lifecycle.Recovery.t
  -> (t, Problem.t) Result.t
