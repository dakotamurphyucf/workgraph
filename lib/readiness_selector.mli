open Core

(** Explicit read-only selection. Candidates describe a prospective invocation;
    no run is registered, no ownership is acquired, and no budget is invented. *)
module Candidate : sig
  type t

  (** At most 100 distinct nonblank capability names, each at most 512 UTF-8
      bytes. Ordering is canonicalized; duplicates reject. *)
  val create : actor:Id.Actor.t -> capabilities:string list -> (t, Problem.t) Result.t

  val actor : t -> Id.Actor.t
  val capabilities : t -> string list
  val codec : t Api_codec.t
end

type t =
  | Graph
  | Run of Id.Run.t
  | Candidate of Candidate.t

(** Optional [target_run_id] and [candidate] fields are mutually exclusive;
    omission selects Graph, explicit null rejects. Context attribution never
    supplies either selector implicitly. *)
val fields : t Api_codec.Fields.t

module Assessment : sig
  module Scope : sig
    type t =
      | Graph
      | Run
      | Candidate
    [@@deriving equal]
  end

  module Unknown_check : sig
    type t =
      | Run_lifecycle
      | Run_budget
      | Required_path_ownership
    [@@deriving equal]
  end

  type t =
    { scope : Scope.t
    ; unknown_checks : Unknown_check.t list
    }

  val graph : t
  val run : t
  val candidate : required_paths:bool -> t

  (** Graph and run assessments have no candidate unknowns. A candidate always
      discloses run lifecycle/budget; required paths add ownership uncertainty.
      Readiness means no known blockers, never authorization to claim/start. *)
  val codec : t Api_codec.t
end
