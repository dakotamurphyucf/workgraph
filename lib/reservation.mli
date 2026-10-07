open Core
module Name : Id.S

module Mode : sig
  type t =
    | Exclusive
    | Shared
  [@@deriving sexp, equal, jsonaf]
end

module Holder : sig
  type t =
    { run : Id.Run.t
    ; actor : Id.Actor.t
    ; token : int
    ; mode : Mode.t
    ; lease : Allocation_lease.t
    }
  [@@deriving sexp, equal, jsonaf]
end

type t =
  { name : Name.t
  ; epoch : int
  ; holders : Holder.t list
  }
[@@deriving sexp, equal, jsonaf]

type request =
  { name : Name.t
  ; mode : Mode.t
  ; lease_duration_ms : int64 option
  }
[@@deriving sexp]

(** These pure operations return new values and preserve their input on failure.
    They raise [Json.Decode_error] for invalid snapshots, unavailable acquisition,
    stale ownership or renewal conflicts; callers may use [Json.decode] to obtain
    a structured [Result]. Release checks the fence, allowing explicit cleanup
    after lease expiry. Expiry does not remove a holder automatically. *)
val validate : t -> unit

val acquire
  :  t
  -> run:Id.Run.t
  -> actor:Id.Actor.t
  -> mode:Mode.t
  -> now_unix_ms:int64
  -> lease_duration_ms:int64 option
  -> t

val release : t -> run:Id.Run.t -> token:int -> t

(** Coordination fencing only. The runner checks the token before integrating
    external changes; Workgraph cannot prevent arbitrary filesystem writes. *)
val validate_owner : t -> now_unix_ms:int64 option -> run:Id.Run.t -> token:int -> unit

val renew
  :  t
  -> run:Id.Run.t
  -> token:int
  -> expected_lease_revision:int
  -> now_unix_ms:int64
  -> t
