open Core

(** Input source and immutable publication selectors use exact typed IDs. Resource
    pins bind their content revision/digest, not resource metadata revision. *)
val methods : Api_method.Packed.t list

val mutation_methods : string list
val query_methods : string list

val decode
  :  method_:string
  -> params:Jsonaf.t
  -> (Ticket_amendment.Command.t, Problem.t) Result.t

val encode : Ticket_amendment.Command.t -> (string * Jsonaf.t, Problem.t) Result.t
val response_codec : method_:string -> Jsonaf.t Api_codec.t option
val validate_result : method_:string -> Jsonaf.t -> unit

val query
  :  Ticket_amendment.t
  -> workspace_revision:int
  -> ownership:(Id.Ticket.t -> Ticket_amendment.Ownership.t option)
  -> method_:string
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t
