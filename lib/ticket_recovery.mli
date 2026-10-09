open Core

(** Attributed durable assertion; it records external confirmation, not process termination. *)
type t =
  { request : Ticket_lifecycle.Recovery.t
  ; actor_id : Id.Actor.t
  ; run_id : Id.Run.t option
  ; timestamp : string
  ; sequence : int
  }
[@@deriving sexp]

val codec : t Api_codec.t
val jsonaf_of_t : t -> Jsonaf.t
val t_of_jsonaf : Jsonaf.t -> t
val query_methods : string list
val descriptor : method_:string -> Api_method.Packed.t option

val query
  :  revision:int
  -> t list
  -> method_:string
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t

val event_references : t list -> Session.Event_ref.t list
