open Core

(** Allocation diagnostics are values shared by admission, preview and errors.
    Strings are stable identifiers, never interpreted human messages. Pool
    counts measure distinct allocated tickets (claim or live attempt); budget
    counts measure attempts. [attempted] is the proposed total, not an increment.
    Counters are nonnegative and saturated at [Int.max_value]. *)
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

val to_json : t -> Jsonaf.t
