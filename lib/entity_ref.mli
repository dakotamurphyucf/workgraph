open Core

(** Targets are local to the enclosing workspace. Decoding checks syntax; the
    state machine checks that the target exists in the final candidate. *)
type t =
  | Workspace
  | Project of Id.Project.t
  | Milestone of Id.Milestone.t
  | Ticket of Id.Ticket.t
  | Resource of Id.Resource.t
[@@deriving sexp, equal, compare]

include Comparator.S with type t := t

val jsonaf_of_t : t -> Jsonaf.t
val t_of_jsonaf : Jsonaf.t -> t
