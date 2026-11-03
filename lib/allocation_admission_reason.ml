open Core

type budget =
  | Total_attempts
  | Active_attempts
[@@deriving sexp, equal]

type t =
  | Run_required
  | Unregistered_run of { run_id : string }
  | Run_actor_mismatch of
      { run_id : string
      ; expected_actor : string
      ; actual_actor : string
      }
  | Actor_not_allowed of { actor_id : string }
  | Terminal_run of { run_id : string }
  | Missing_capability of
      { run_id : string
      ; capability : string
      }
  | Pool_full of
      { pool : string
      ; used : int
      ; limit : int
      ; attempted : int
      }
  | Budget_exhausted of
      { budget : budget
      ; used : int
      ; limit : int
      ; attempted : int
      }
[@@deriving sexp, equal]

let to_json t =
  let text s = `String s in
  let count n = text (Int.to_string n) in
  let tagged kind fields = `Object (("kind", text kind) :: fields) in
  let counts used limit attempted =
    [ "used", count used; "limit", count limit; "attempted", count attempted ]
  in
  match t with
  | Run_required -> tagged "run_required" []
  | Unregistered_run { run_id } -> tagged "unregistered_run" [ "run_id", text run_id ]
  | Run_actor_mismatch { run_id; expected_actor; actual_actor } ->
    tagged
      "run_actor_mismatch"
      [ "run_id", text run_id
      ; "expected_actor", text expected_actor
      ; "actual_actor", text actual_actor
      ]
  | Actor_not_allowed { actor_id } ->
    tagged "actor_not_allowed" [ "actor_id", text actor_id ]
  | Terminal_run { run_id } -> tagged "terminal_run" [ "run_id", text run_id ]
  | Missing_capability { run_id; capability } ->
    tagged "missing_capability" [ "run_id", text run_id; "capability", text capability ]
  | Pool_full { pool; used; limit; attempted } ->
    tagged
      "pool_full"
      ([ "pool", text pool; "unit", text "allocated_tickets" ]
       @ counts used limit attempted)
  | Budget_exhausted { budget; used; limit; attempted } ->
    tagged
      "budget_exhausted"
      ([ ( "unit"
         , text
             (match budget with
              | Total_attempts -> "total_attempts"
              | Active_attempts -> "active_attempts") )
       ]
       @ counts used limit attempted)
;;
