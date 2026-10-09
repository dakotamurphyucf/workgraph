open Core

module Reference : sig
  (** Public requests retain $aliases until transaction resolution. *)
  type t =
    | Resource of
        { id : string
        ; revision : int
        }
    | Handoff of
        { ticket : string
        ; revision : int
        }

  val codec : t Api_codec.t
  val resolve : t -> (Attempt.Checkpoint.t, Problem.t) Result.t
  val of_checkpoint : Attempt.Checkpoint.t -> t
end

(** The same tagged declaration, with resolved typed identities for records. *)
val codec : Attempt.Checkpoint.t Api_codec.t
