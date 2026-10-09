open Core

(** Private bounded queries over an immutable snapshot. Returned domain layouts
    are projected into the public envelope at transport; budget fitting already
    measures that final public shape. No state changes or I/O. *)
val query
  :  ?now_unix_ms:int64
  -> Planning_state.t
  -> method_:string
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t

val query_with_texts
  :  ?now_unix_ms:int64
  -> Planning_state.t
  -> resource_texts:Search.Text.t list
  -> method_:string
  -> params:Jsonaf.t
  -> (Jsonaf.t, Problem.t) Result.t
