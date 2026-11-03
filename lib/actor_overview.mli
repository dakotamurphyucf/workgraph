open Core

(** One current planning capture, flat tagged rows ordered by kind and typed ID.
    Claims, attempts and held reservations remain visible independently of inbox
    acknowledgement. Incoming/outgoing request roles may overlap on one row.
    Selected unread notifications require an explicit consumer. Current cursor
    rejects changed revision/lineage instead of silently rescanning. *)
val read
  :  Planning_state.t
  -> now_unix_ms:int64
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t
