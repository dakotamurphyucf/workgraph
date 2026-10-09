open Core
module Condition_id = Coordination_id.Condition
module Signal_id = Coordination_id.Signal
module Operation_id = Coordination_id.Operation

module Declaration : sig
  type t =
    { condition_id : Condition_id.t
    ; revision : int
    ; ticket_id : Id.Ticket.t
    ; operation_id : Operation_id.t
    ; artifact : Evidence_event.Pin.t
    ; required : bool
    ; label : string
    ; creator : Id.Actor.t
    ; creator_run : Id.Run.t option
    ; recipients : Id.Actor.t list
    }
  [@@deriving sexp, equal]

  val codec : t Api_codec.t
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t
end

module Signal : sig
  type t =
    { signal_id : Signal_id.t
    ; condition_id : Condition_id.t
    ; condition_revision : int
    ; operation_id : Operation_id.t
    ; artifact : Evidence_event.Pin.t
    ; evidence : Evidence_event.Pin.t list
    ; summary : string
    ; actor_id : Id.Actor.t
    ; run_id : Id.Run.t option
    ; timestamp : string
    ; sequence : int
    }
  [@@deriving sexp, equal]

  val codec : t Api_codec.t
  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t
end

module Command : sig
  type t =
    | Put of
        { condition_id : Condition_id.t
        ; expected_revision : int
        ; ticket_id : Id.Ticket.t
        ; operation_id : Operation_id.t
        ; artifact : Evidence_event.Pin.t
        ; required : bool
        ; label : string
        ; recipients : Id.Actor.t list
        }
    | Signal of
        { signal_id : Signal_id.t
        ; condition_id : Condition_id.t
        ; expected_revision : int
        ; operation_id : Operation_id.t
        ; artifact : Evidence_event.Pin.t
        ; evidence : Evidence_event.Pin.t list
        ; summary : string
        }
  [@@deriving sexp]

  val codec : method_:string -> t Api_codec.t option

  (** Shared request fields admit aliases only in declared entity references. *)
  val raw_request_codec : method_:string -> Jsonaf.t Api_codec.t option
end

module Change : sig
  type t =
    | Put of Declaration.t
    | Signal of Signal.t
  [@@deriving sexp, equal, jsonaf]
end

module Blocker : sig
  type t =
    { condition_id : Condition_id.t
    ; revision : int
    ; operation_id : Operation_id.t
    ; artifact : Evidence_event.Pin.t
    ; label : string
    }
  [@@deriving sexp, equal]
end

(** Signals satisfy an exact current revision/operation/artifact. A declaration
    replacement invalidates prior satisfaction. Stable signal IDs repeat only
    with identical semantic content and actor/run attribution; retries return
    the original signal, including its sequence, without emitting a change. *)
type t

type prepared

val empty : t

val prepare
  :  t
  -> Command.t
  -> actor:Id.Actor.t
  -> run:Id.Run.t option
  -> timestamp:string
  -> sequence:int
  -> (prepared, Problem.t) Result.t

val candidate : prepared -> t
val changes : prepared -> Change.t list
val result : prepared -> Jsonaf.t

val apply
  :  t
  -> Change.t
  -> actor:Id.Actor.t
  -> run:Id.Run.t option
  -> timestamp:string
  -> sequence:int
  -> (t, Problem.t) Result.t

val blockers : t -> ticket:Id.Ticket.t -> Blocker.t list
val get : t -> Condition_id.t -> Declaration.t option
val signal : t -> Signal_id.t -> Signal.t option
val signals : t -> condition:Condition_id.t -> Signal.t list
val satisfied : t -> Declaration.t -> bool
val declarations : t -> Declaration.t list
val history : t -> Declaration.t list
val pins : t -> Evidence_event.Pin.t list

val validate_references
  :  t
  -> ticket_exists:(Id.Ticket.t -> bool)
  -> pin_exists:(Evidence_event.Pin.t -> bool)
  -> (unit, Problem.t) Result.t

(** Stable ID for the notification required by an actual condition transition. *)
val notification_id : Change.t -> sequence:int -> Communication_id.Message.t

type state = t

module Repeat : sig
  (** Receipt-only proof of an identical stable signal retry. It changes neither
      condition state nor notifications. Replay validates the full command and
      original signal against the current immutable signal history. *)
  type t =
    { command : Command.t
    ; original : Signal.t
    }
  [@@deriving sexp]

  val jsonaf_of_t : t -> Jsonaf.t
  val t_of_jsonaf : Jsonaf.t -> t

  val validate
    :  t
    -> state:state
    -> actor:Id.Actor.t
    -> run:Id.Run.t option
    -> timestamp:string
    -> sequence:int
    -> (unit, Problem.t) Result.t
end
