open Core

module Budget : sig
  type t =
    { run : Id.Run.t
    ; revision : int
    ; max_attempts : int option
    ; max_active_attempts : int option
    ; reported_token_limit : int64 option
    ; reported_elapsed_ms_limit : int64 option
    }
  [@@deriving sexp, equal]

  val to_json : t -> Jsonaf.t
end

module Command : sig
  type t =
    | Template_register of Workflow_template.t
    | Instance_register of Workflow_template.Instance.t
    | Budget_put of Budget.t
    | Usage_report of Usage_record.t
  [@@deriving sexp]
end

module Change : sig
  type t =
    { revision : int
    ; command : Command.t
    }
  [@@deriving sexp]

  val to_json : t -> Jsonaf.t
  val of_json : Jsonaf.t -> (t, Problem.t) Result.t
end

type t
type prepared

val empty : t
val prepare : t -> Command.t -> (prepared, Problem.t) Result.t
val candidate : prepared -> t
val changes : prepared -> Change.t list
val result : prepared -> Jsonaf.t
val apply : t -> Change.t -> (t, Problem.t) Result.t
val get_template : t -> Id.Resource.t -> revision:int -> Workflow_template.t option

val get_instance
  :  t
  -> Workflow_template.Instance_id.t
  -> Workflow_template.Instance.t option

val budget : t -> Id.Run.t -> Budget.t option

(** Allocation enforces attempt/concurrency limits using the staged run state.
    Reported spending limits produce attention items; stopping inference is the
    runner's responsibility. Completed/failed/cancelled attempts count toward
    total attempts, while only active attempts consume concurrency. *)
val validate_allocation : t -> Id.Run.t -> runs:Agent_run.t -> (unit, Problem.t) Result.t

val attention : t -> runs:Agent_run.t -> Jsonaf.t list

val validate_references
  :  t
  -> resource_version:(Id.Resource.t -> revision:int -> string option)
  -> run_exists:(Id.Run.t -> bool)
  -> attempt_exists:(Attempt.Id.t -> bool)
  -> ticket_exists:(Id.Ticket.t -> bool)
  -> (unit, Problem.t) Result.t

val decode : method_:string -> params:Jsonaf.t -> (Command.t, Problem.t) Result.t
val encode : Command.t -> string * Jsonaf.t

val query
  :  t
  -> runs:Agent_run.t
  -> method_:string
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t

val mutation_methods : string list
val query_methods : string list
val to_json : t -> Jsonaf.t
val usage_records : t -> Usage_record.t list
val budgets : t -> Budget.t list
