open Core

module Command : sig
  type t =
    { project : Id.Project.t
    ; expected_revision : int
    ; evidence : string
    ; handoff : Ticket_lifecycle.Handoff.t
    }

  val codec : t Api_codec.t
end

(** project.readiness is a captured current view with whole blocker rows.
    Offset continuation requires at_revision; incomplete byte fitting preserves
    the unconsumed row and reports the exact budget needed for that row. *)
val methods : Api_method.Packed.t list

val query : Project_completion.t -> params:Jsonaf.t -> (Jsonaf.t, Problem.t) Result.t
