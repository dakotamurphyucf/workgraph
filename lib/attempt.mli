open Core
module Key : Id.S

module State : sig
  type t =
    | Running
    | Waiting
    | Completed
    | Failed
    | Cancelled
  [@@deriving sexp, equal, jsonaf]

  val terminal : t -> bool
end

module Checkpoint : sig
  type t =
    | Resource of
        { id : Id.Resource.t
        ; revision : int
        }
    | Handoff of
        { ticket : Id.Ticket.t
        ; revision : int
        }
  [@@deriving sexp, equal, jsonaf]
end

type t =
  { id : Key.t
  ; revision : int
  ; run : Id.Run.t
  ; ticket : Id.Ticket.t
  ; token : int
  ; state : State.t
  ; sessions : Session_id.t list
  ; checkpoints : Checkpoint.t list
  ; evidence : string
  }
[@@deriving sexp, equal, jsonaf]

(** Snapshot validation includes counters, duplicate links, checkpoint versions
    and required failure/completion evidence. Raises only Json.Decode_error. *)
val validate : t -> unit

val validate_transition : previous:t option -> t -> unit

module Id = Key
