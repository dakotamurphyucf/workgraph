open Core

(** Offline discovery from the executable method contracts. No daemon or context
    file is needed. Unknown methods return [Not_found]. *)
val schema : method_name:string option -> (Jsonaf.t, Problem.t) Result.t

(** Human-readable method index, or a method's summary, scope and exact schemas.
    The same descriptions are available as JSON through [schema]. *)
val help : method_name:string option -> (string, Problem.t) Result.t
