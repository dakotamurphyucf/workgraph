open Core
module Budget = Run_budget
module Command = Agent_run_policy_command

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

(** The same exhausted attempt/concurrency limits enforced by
    [validate_allocation], from one staged run snapshot. *)
val allocation_limits
  :  t
  -> Id.Run.t
  -> runs:Agent_run.t
  -> Allocation.Budget_limit.t list

val attention : t -> runs:Agent_run.t -> Run_budget.Attention.t list

val validate_references
  :  t
  -> resource_version:(Id.Resource.t -> revision:int -> string option)
  -> run_exists:(Id.Run.t -> bool)
  -> attempt_exists:(Attempt.Id.t -> bool)
  -> ticket_exists:(Id.Ticket.t -> bool)
  -> (unit, Problem.t) Result.t

val decode : method_:string -> params:Jsonaf.t -> (Command.t, Problem.t) Result.t

(** Raises [Json.Decode_error] if a directly constructed command violates the
    public contract; [decode], [prepare] and [apply] return typed errors instead. *)
val encode : Command.t -> string * Jsonaf.t

(** Queries keep complete records, including proof and template hash inputs.
    [max_bytes] bounds the public data/meta envelope (4096..1048576 bytes).
    An oversized direct record or first page item fails [Invalid_argument]; page
    offsets count whole records and require the first page capture revision. *)
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
