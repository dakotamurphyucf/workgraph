open Core
module Recovery_id = Coordination_id.Recovery

module Confirmation : sig
  type t =
    | Stopped
    | Isolated
  [@@deriving sexp, equal]

  val codec : t Api_codec.t
end

module Target : sig
  type t =
    | Named of Reservation.Name.t
    | Path of Path_scope.t
  [@@deriving sexp, equal]

  val codec : t Api_codec.t
end

module Request : sig
  type t =
    { recovery_id : Recovery_id.t
    ; target : Target.t
    ; expected_epoch : int
    ; old_run_id : Id.Run.t
    ; old_actor_id : Id.Actor.t
    ; token : int
    ; expected_lease_revision : int
    ; confirmation : Confirmation.t
    ; reason : string
    ; evidence : Evidence_event.Pin.t list
    }
  [@@deriving sexp, equal]

  val codec : t Api_codec.t
  val raw_codec : Jsonaf.t Api_codec.t
  val validate : t -> unit

  (** Exact guard, including expired holders. Never removes a replacement owner. *)
  val validate_holder : t -> epoch:int -> holders:Reservation.Holder.t list -> unit
end

(** Durable attributed assertion that the old external process stopped or was
    isolated. The daemon does not terminate or inspect processes. *)
type t =
  { request : Request.t
  ; actor_id : Id.Actor.t
  ; run_id : Id.Run.t option
  ; timestamp : string
  ; sequence : int
  }
[@@deriving sexp, equal]

val codec : t Api_codec.t
val jsonaf_of_t : t -> Jsonaf.t
val t_of_jsonaf : Jsonaf.t -> t
