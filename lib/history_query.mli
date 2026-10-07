open Core

type direction =
  | Before
  | After
  | Around
[@@deriving sexp, equal]

(** Fixed capture session sequence bounds; offsets count events, budgets bytes.
    Full payloads are fetched separately by blob range, so one oversized body
    cannot silently truncate preservation. Returned metadata fits max_bytes;
    returns [Blocked] when the capture or one event cannot fit the budget. *)
val read
  :  Session_store.Capture.t
  -> session:Session_id.t
  -> anchor:int
  -> direction:direction
  -> limit:int
  -> max_bytes:int
  -> (Jsonaf.t, Problem.t) Result.t

val get : Session_store.Capture.t -> Session.Event_ref.t -> (Jsonaf.t, Problem.t) Result.t
