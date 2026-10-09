open Core

module Policy : sig
  type t =
    | Indefinite
    | Duration_ms of int64
  [@@deriving sexp, equal]
end

module Status : sig
  type t =
    | Valid
    | Expired
    | Clock_regressed
  [@@deriving sexp, equal]
end

type t [@@deriving sexp, equal]

(** Epochs are durable ownership fences. Indefinite is the default; opt-in
    durations are 1ms..24h. UTC wall time must not move backwards. Forward clock
    jumps may expire ownership. Restart retains the persisted deadline and last
    accepted clock; it never silently extends ownership. No side effects occur. *)
val create
  :  epoch:int
  -> now_unix_ms:int64
  -> ?policy:Policy.t
  -> unit
  -> (t, Problem.t) Result.t

val epoch : t -> int
val revision : t -> int
val policy : t -> Policy.t
val status : t -> now_unix_ms:int64 -> Status.t
val validate_owner : t -> epoch:int -> now_unix_ms:int64 -> (unit, Problem.t) Result.t

(** Renewal requires an unexpired fence and an exact revision, rejecting racing
    renewals. Expiry never implies a process stopped or a worktree is safe. *)
val renew
  :  t
  -> expected_revision:int
  -> epoch:int
  -> now_unix_ms:int64
  -> (t, Problem.t) Result.t

(** Bounded heartbeat coalescing hint for the runner's separate liveness store.
    Heartbeats are not planning transactions and never renew ownership. *)
val heartbeat_due
  :  last_unix_ms:int64 option
  -> now_unix_ms:int64
  -> interval_ms:int64
  -> bool

val to_json : t -> Jsonaf.t
val of_json : Jsonaf.t -> (t, Problem.t) Result.t
val last_unix_ms : t -> int64

(** Exact durable expiry boundary; None denotes indefinite ownership. *)
val deadline_unix_ms : t -> int64 option

val jsonaf_of_t : t -> Jsonaf.t
val t_of_jsonaf : Jsonaf.t -> t
