open Core

(** Private pure expansion of one explicit reopening. The source is the completed
    ticket from [t], with its command revision already checked. Full reasons are
    retained in immutable reassessments; generated discussion/message excerpts
    are bounded and disclose truncation. The returned contiguous effects include
    the source decision, every unwaived dependent's reassessment and decision,
    and notification to each dependent's captured claimant. Replay requires this
    exact expansion at the reopening boundary before applying later batch work.
    Raises [Json.Decode_error] for invalid source/reason or message preparation. *)
val effects_exn
  :  Planning_state.t
  -> source:Planning_state.Ticket.t
  -> reason:string
  -> actor:Id.Actor.t
  -> run:Id.Run.t option
  -> timestamp:string
  -> Planning_state.Event.t list
