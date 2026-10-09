open Core

(** Public run/allocation/attempt/reservation methods. Raw typed requests retain
    transaction aliases until the resolver supplies stable IDs. Persisted event
    codecs are independent of these lowercase enum/tagged-object wire codecs. *)
val mutation_methods : string list

val query_methods : string list

(** Minimal exact attempt mutation/lifecycle result. [revision] belongs to this
    attempt and can be used directly as its next [expected_revision]. Lifecycle
    results omit the entire field when they create/complete no attempt. *)
module Attempt_result : sig
  type t =
    { attempt_id : Attempt.Id.t
    ; revision : int
    ; state : Attempt.State.t
    }

  val codec : t Api_codec.t
  val of_attempt : Attempt.t -> t
  val to_json : t -> Jsonaf.t
end

val request_codec : method_:string -> Jsonaf.t Api_codec.t option
val response_codec : method_:string -> Jsonaf.t Api_codec.t option
val descriptor : method_:string -> Api_method.Packed.t option

val decode_command
  :  method_:string
  -> params:Jsonaf.t
  -> (Agent_run_command.t, Problem.t) Result.t

val encode_command : Agent_run_command.t -> (string * Jsonaf.t, Problem.t) Result.t
val validate_result : method_:string -> Jsonaf.t -> unit option

module Query : sig
  module Page : sig
    (** Offset/revision refer to the run coordination revision, independent of
        the workspace capture revision. Server result fitting honors max_bytes. *)
    type t =
      { limit : int
      ; max_bytes : int
      ; offset : int
      ; expected_revision : int option
      }
  end

  module Get : sig
    (** Full record reads never clip required fields. Increase max_bytes if the
        record cannot fit; omission does not silently produce a partial record. *)
    type 'id t =
      { id : 'id
      ; max_bytes : int
      }
  end

  type t =
    | Run_get of Id.Run.t Get.t
    | Attempt_get of Attempt.Id.t Get.t
    | Reservation_get of Reservation.Name.t Get.t
    | Pools of Page.t
    | Ticket_policies of Page.t
    | Runs of Page.t
    | Attempts of
        { page : Page.t
        ; ticket : Id.Ticket.t option
        ; run : Id.Run.t option
        }
    | Reservations of Page.t
    | Actions of Page.t

  val decode : method_:string -> params:Jsonaf.t -> (t, Problem.t) Result.t
end

(** Canonical query record projections, validated by their actual result codecs.
    Storage/run lifecycle validation remains in its domain modules. *)
val run_json : Agent_run_event.Record.t -> Jsonaf.t

val attempt_json : Attempt.t -> Jsonaf.t
val reservation_json : Reservation.t -> Jsonaf.t
val action_json : Agent_run_event.Runner_action.t -> Jsonaf.t
val pool_json : Allocation.Definition.t -> Jsonaf.t
val ticket_policy_json : Allocation.Ticket_policy.t -> Jsonaf.t
