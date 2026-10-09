open Core

module Kind : sig
  type t =
    | Completion
    | Reopening
    | Decision
    | Blocker
    | Request
    | Condition
    | Recovery
    | Ownership
    | Progress
    | Fact
    | Task_changed
    | Resource
  [@@deriving sexp, equal]

  val codec : t Api_codec.t
end

(** PRIVATE projection of actual chronological resolved transitions. Each row
    retains exact source refs and its captured source record or explicit excerpt.
    Current-at-through request/thread projections are reconstructed from retained
    typed changes, never borrowed from a newer live snapshot. Ticket claim-only
    transitions (including start/release status changes) are [Ownership]; changes
    to descriptive or graph fields remain substantive task changes. *)
type scan

val scan
  :  Planning_state.t
  -> scope:Resume_api.Scope.t
  -> after:int option
  -> cursor:string option
  -> (scan, Problem.t) Result.t

val rows : scan -> Jsonaf.t list
val outstanding_requests : scan -> Jsonaf.t list
val other_changes : scan -> int
val capture : scan -> Jsonaf.t
val cursor_after : scan -> count:int -> string * bool

type t

val build : Planning_state.t -> Resume_api.Digest_request.t -> (t, Problem.t) Result.t
val result : t -> Jsonaf.t
val markdown : t -> string
