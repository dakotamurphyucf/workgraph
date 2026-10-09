open Core

(** Parse only client-local evidence-run options before the literal [--] argv
    boundary. No context defaults, shell interpretation or daemon access. *)
type t

val of_arguments : string list -> (t, Problem.t) Result.t

(** Execute once, returning a small summary and CLI exit code: zero for an
    observed zero exit, two for nonzero/signal/launch failure. Infrastructure
    errors are Results; cancellation propagates after staging as documented by
    Execution_stage. Output bytes remain in the stage, not the CLI summary. *)
val run : t -> env:Eio_unix.Stdenv.base -> (Jsonaf.t * int, Problem.t) Result.t
