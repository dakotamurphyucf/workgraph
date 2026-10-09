open Core

(** Validated explicit setup plan. No network, file creation or process startup
    occurs during construction. Paths are absolute and identities are validated;
    an existing context must match the chosen defaults before execution. *)
type t

val create
  :  context_file:string
  -> socket:string
  -> previous:Cli_context.t option
  -> fields:(string * Jsonaf.t) list
  -> request_directory:string option
  -> timeout_seconds:float
  -> (t, Problem.t) Result.t

(** Create/select/open the explicitly identified workspace and publish a fresh
    private synced context file. Existing files are never overwritten. Optional
    daemon startup uses an explicit registry and private log and survives this
    process's exit. Concurrent startup/setup reuses matching published identities.
    All administrative writes are synced as exact requests beside the context;
    [on_saved_request] runs after sync and before transmission. No implicit retry
    of a mutation occurs. Local input/file failures use Invalid_argument or
    Local_io; daemon storage and uncertain mutation errors retain their kinds.
    Cancellation and unexpected exceptions propagate. *)
val run
  :  t
  -> env:Eio_unix.Stdenv.base
  -> on_saved_request:(string -> unit)
  -> (Jsonaf.t, Problem.t) Result.t
