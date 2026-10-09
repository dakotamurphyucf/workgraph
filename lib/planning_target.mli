open Core

(** Public tagged entity references. IDs may contain a transaction alias until
    resolution; [of_ref] always produces resolved IDs. *)
type t =
  | Workspace
  | Project of string
  | Milestone of string
  | Ticket of string
  | Resource of string

val codec : t Api_codec.t
val scope_codec : t Api_codec.t
val to_ref : t -> (Entity_ref.t, Problem.t) Result.t
val of_ref : Entity_ref.t -> t
