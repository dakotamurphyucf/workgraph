open Core

(** Private unpublished transaction candidate, resolved events and referenced
    blobs. prepare stages all commands, validates final references and independently
    replays the resolved events. It performs no I/O or publication. *)
type t

val prepare
  :  Planning_state.t
  -> ?run:Id.Run.t
  -> ?now_unix_ms:int64
  -> Domain_command.t
  -> actor:Id.Actor.t
  -> timestamp:string
  -> (t, Problem.t) Result.t

val candidate : t -> Planning_state.t
val events : t -> Jsonaf.t
val result : t -> Jsonaf.t
val blobs : t -> (string * string) list
val required_blobs : t -> (string * int option) list
