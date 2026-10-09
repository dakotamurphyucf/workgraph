open Core

module Declaration : sig
  type t =
    { target : Path_scope.t
    ; mode : Reservation.Mode.t
    }
  [@@deriving sexp, equal]

  val codec : t Api_codec.t
end

(** At most 100 declarations in target order, each target present once.
    Required paths acquire compatible ownership atomically on claim/start.
    Worktree identities are explicit and independent of run metadata. *)
type t =
  { ticket_id : Id.Ticket.t
  ; revision : int
  ; declarations : Declaration.t list
  ; require_reservations : bool
  }
[@@deriving sexp, equal]

val canonicalize : Declaration.t list -> (Declaration.t list, Problem.t) Result.t
val codec : t Api_codec.t
val validate : t -> unit
val jsonaf_of_t : t -> Jsonaf.t
val t_of_jsonaf : Jsonaf.t -> t
