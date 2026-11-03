open Core

module Request : sig
  type t =
    { target : Path_scope.t
    ; mode : Reservation.Mode.t
    ; lease_duration_ms : int64 option
    }
  [@@deriving sexp]

  val codec : t Api_codec.t
end

(** Reuses named-reservation holder fences/lease rules through a shared pure
    Ownership implementation. Explicit acquisitions are Manual; lifecycle
    transitions create indefinite Automatic holders with exact claim borrowers.
    Pure [release] remains the exact-fence primitive for guarded recovery; the
    full Agent_run command layer rejects direct release of borrowed holds. *)
type t =
  { target : Path_scope.t
  ; epoch : int
  ; holders : Reservation.Holder.t list
  }
[@@deriving sexp, equal]

val validate : t -> unit

val acquire
  :  t
  -> run:Id.Run.t
  -> actor:Id.Actor.t
  -> mode:Reservation.Mode.t
  -> now_unix_ms:int64
  -> lease_duration_ms:int64 option
  -> t

val release : t -> run:Id.Run.t -> token:int -> t

val renew
  :  t
  -> run:Id.Run.t
  -> token:int
  -> expected_lease_revision:int
  -> now_unix_ms:int64
  -> t

val validate_owner : t -> now_unix_ms:int64 option -> run:Id.Run.t -> token:int -> unit

val conflicts
  :  t
  -> target:Path_scope.t
  -> mode:Reservation.Mode.t
  -> excluding_run:Id.Run.t option
  -> Reservation.Holder.t list

val jsonaf_of_t : t -> Jsonaf.t
val t_of_jsonaf : Jsonaf.t -> t
