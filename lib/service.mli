(** Run the daemon. One main-domain dispatcher owns state; a bounded worker
    domain owns serialized persistence operations. Two read-worker domains serve
    history: current/cached reads and search/cold ancestor reconstruction have
    independent bounded admission (16 outstanding reads per lane). All searches
    share a worker-owned index; each worker retains indices for at most eight
    recently used roots, replacing entries on root-generation changes.
    Historical reconstruction never accesses the mutable journal owner; immutable
    captures pin the root until completion, including expected-error results.
    Dispatcher and each read worker retain at most eight cached captures with a
    16MiB metadata accounting budget each (48MiB aggregate accounting, not a heap
    bound; queued captures/current state are additional). Root generations prevent
    reuse across reopen/restore. Payload reads still verify the requested complete
    blob, so byte-range size alone does not bound their latency.
    Admission canonicalizes workspace/restore
    roots and export destinations and rejects overlap with registered/reserved
    storage or the registry. This is trusted-local ownership, not protection
    against concurrent external filesystem replacement. Validates the native socket
    path byte bound before starting workers. Concise lifecycle diagnostics identify
    registry/socket paths; ready is emitted only after successful initialization
    and bind. A pathname-scoped exclusive owner guard is acquired before registry
    initialization. Only an abandoned socket matching its synced native identity
    is recovered; unknown occupied paths refuse startup, and connection refusal
    never proves stale ownership. Failed bind never unlinks another listener's
    socket. Diagnostic pipe failures
    do not stop service; cancellation and unexpected errors propagate. *)
val run : env:Eio_unix.Stdenv.base -> registry:string -> socket:string -> unit

(** Serve an already prepared listener using the same dispatcher and disk
    workers as [run]. The caller owns the listener's lifetime and endpoint
    permissions. Unlike [run], this does not install process signal handlers.
    A valid [daemon.shutdown] gets a bounded response-write attempt before
    cancellation begins, including when its peer disconnects. Admitted work
    drains before [serve] returns. A shutdown reply is not a process-exit signal.
    This also permits deterministic in-memory transport tests without binding
    an operating-system socket. *)
val serve
  :  env:Eio_unix.Stdenv.base
  -> registry:string
  -> listener:[ `Generic ] Eio.Net.listening_socket_ty Eio.Resource.t
  -> unit
