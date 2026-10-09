open Core

val mutation_methods : string list
val query_methods : string list
val request_codec : method_:string -> Jsonaf.t Api_codec.t option
val response_codec : method_:string -> Jsonaf.t Api_codec.t option

val decode_command
  :  method_:string
  -> params:Jsonaf.t
  -> (Agent_coordination_command.t, Problem.t) Result.t

val encode_command
  :  Agent_coordination_command.t
  -> (string * Jsonaf.t, Problem.t) Result.t

module Query : sig
  module Page : sig
    type t =
      { limit : int
      ; max_bytes : int
      ; offset : int
      ; expected_revision : int option
      }
  end

  type t =
    | Path_get of
        { target : Path_scope.t
        ; max_bytes : int
        }
    | Ticket_paths_get of
        { ticket : Id.Ticket.t
        ; max_bytes : int
        }
    | Condition_get of
        { condition : Coordination_id.Condition.t
        ; max_bytes : int
        }
    | Recovery_get of
        { recovery : Coordination_id.Recovery.t
        ; max_bytes : int
        }
    | Paths of Page.t
    | Ticket_paths of Page.t
    | Conditions of
        { page : Page.t
        ; ticket : Id.Ticket.t option
        }
    | Signals of
        { page : Page.t
        ; condition : Coordination_id.Condition.t
        }
    | Recoveries of Page.t

  val decode : method_:string -> params:Jsonaf.t -> (t, Problem.t) Result.t
end

(** Exact current/historical snapshot declaration reused by public audit rows. *)
val path_reservation_codec : Path_reservation.t Api_codec.t

val path_reservation_json : Path_reservation.t -> Jsonaf.t
val condition_json : External_condition.t -> External_condition.Declaration.t -> Jsonaf.t
