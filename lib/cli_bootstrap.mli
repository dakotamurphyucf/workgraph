open Core

(** Offline usage for [init] and its [bootstrap] spelling. Reading this value
    neither inspects context files nor starts processes or performs I/O. *)
val help : string

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

module Daemon_start : sig
  type observation =
    | Existing
    | Startup_attempt_observed_ready
    | Competing
  [@@deriving equal, sexp]

  type t =
    { observation : observation
    ; listing : Jsonaf.t
    }
end

(** Explicit local startup only. The executable is a native caller-selected
    absolute path; no shell fragments or additional argv are admitted. Probe a
    fully decoded current workspace listing first. An existing endpoint is not
    attributed to this invocation. Otherwise use the existing detached supervisor,
    preserving socket-owner competition, deadline, bounded startup log and typed
    faults. A returned error or cancellation does not prove the detached child
    stopped. Never removes an occupied socket, retries a mutation or creates a
    workspace/context. Paths, positive deadline and creatable parents are checked
    before startup. Optional [before_probe] runs before every readiness listing,
    under the same remaining startup deadline. Its typed domain/incompatibility
    errors terminate without a listing or child spawn; retryable transport
    unavailability retains ordinary absent/not-ready startup behavior. The default
    adds no compatibility policy. Unexpected exceptions and cancellation propagate. *)
val start_daemon
  :  ?before_probe:(Client.t -> (unit, Problem.t) Result.t)
  -> env:Eio_unix.Stdenv.base
  -> executable:string
  -> socket:string
  -> registry:string
  -> log:string
  -> timeout_seconds:float
  -> unit
  -> (Daemon_start.t, Problem.t) Result.t

(** Create/select/open the explicitly identified workspace and publish a fresh
    private synced context file. Actor-free observer setup selects an existing open
    workspace without administrative writes; creating/opening requires explicit
    actor attribution before journaling. Existing files are never overwritten. Optional
    daemon startup uses an explicit registry and private log and survives this
    process's exit. Readiness requires a valid protocol response, racing the
    spawned child's exit against a monotonic configured timeout. Child failures
    retain their typed diagnostic with a bounded current-startup log tail;
    timeout reports the last handshake failure and log path. A timeout does not
    prove the detached daemon stopped; the short supervisor is reaped while its
    detached child may continue. Only typed [Conflict]/[Socket_owner] competition
    permits waiting for another owner, and success still requires its valid
    handshake. Concurrent startup/setup reuses matching
    published identities.
    The configured request directory is created and validated before daemon
    startup or mutation submission. All administrative writes are synced there
    as exact requests, falling back beside the context when no request directory
    is configured;
    [on_saved_request] runs after sync and before transmission. No implicit retry
    of a mutation occurs. Local input/file failures use Invalid_argument or
    Local_io; daemon storage and uncertain mutation errors retain their kinds.
    Cancellation and unexpected exceptions propagate. *)
val run
  :  ?daemon_executable:string
  -> t
  -> env:Eio_unix.Stdenv.base
  -> on_saved_request:(string -> unit)
  -> (Jsonaf.t, Problem.t) Result.t
