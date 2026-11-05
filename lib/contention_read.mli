open Core

(** Pure current snapshot of actual holders and explicit advisory records.
    Path targets include lexical overlaps; named targets match exactly. No I/O,
    registration, acquisition, renewal or release. The whole-item current cursor
    retains first clock and rejects changed capture or selectors. *)
val read
  :  Planning_state.t
  -> Reservation_contention_api.Request.t
  -> now_unix_ms:int64
  -> (Jsonaf.t, Problem.t) Result.t
