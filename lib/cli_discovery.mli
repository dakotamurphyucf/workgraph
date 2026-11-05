open Core

(** Parse and render the offline [discover] and [capabilities] commands. Accepts
    the command name followed by its arguments. Text is the default except for
    the explicitly complete JSON [discover --catalog] export. Duplicate/unknown
    options reject; no global context or socket is loaded. *)
val run : string list -> (string, Problem.t) Result.t

val help : string -> string option
