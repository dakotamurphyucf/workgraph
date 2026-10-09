open Core

(** Executable raw public contracts and resolved domain projections. Raw mutation
    Fields retain declared $aliases; decode requires resolution before admitting
    a command. Usage’s reported_actor_id must match outer actor_id in planning. *)
val request_codec : method_:string -> Jsonaf.t Api_codec.t option

val response_codec : method_:string -> Jsonaf.t Api_codec.t option

val decode
  :  method_:string
  -> params:Jsonaf.t
  -> (Agent_run_policy_command.t, Problem.t) Result.t

val encode : Agent_run_policy_command.t -> (string * Jsonaf.t, Problem.t) Result.t
val budget : Run_budget.t Api_codec.t
val methods : Api_method.Packed.t list
