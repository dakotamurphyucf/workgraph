open Core

(** Bounded task view. Current claim/lease and hold are whole. Historical and
    relation arrays are deliberately excluded and counted; exact Ticket source
    references expand the complete canonical record through planning activity. *)
val codec : Jsonaf.t Api_codec.t

val of_ticket : Planning_state.Ticket.t -> Jsonaf.t
