open Core
module Command = Project_completion.Command

(** project.readiness is a captured current view with whole blocker rows.
    Offset continuation requires at_revision; incomplete byte fitting preserves
    the unconsumed row and reports the exact budget needed for that row. A blocker
    that exceeds the maximum 1MiB query budget rejects with an explicit diagnostic
    instead of recommending an unsupported budget or clipping a gate problem. *)
val methods : Api_method.Packed.t list

val query : Project_completion.t -> params:Jsonaf.t -> (Jsonaf.t, Problem.t) Result.t
