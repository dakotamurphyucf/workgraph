open Core

(** Deterministic atomic effects for an amendment change, derived exclusively
    from the preceding immutable capture. Both preparation and durable replay
    use these exact effects. Ack records have no generated message effects. *)
val effects
  :  Planning_state.t
  -> Ticket_amendment.Change.t
  -> actor:Id.Actor.t
  -> run:Id.Run.t option
  -> timestamp:string
  -> Planning_state.Event.t list
