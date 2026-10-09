(** Run the daemon. One main-domain dispatcher owns state; a bounded worker
    domain owns filesystem operations. Admission canonicalizes workspace/restore
    roots and export destinations and rejects overlap with registered/reserved
    storage or the registry. This is trusted-local ownership, not protection
    against concurrent external filesystem replacement. Validates the native socket
    path byte bound before starting workers. Concise lifecycle diagnostics identify
    registry/socket paths; ready is emitted only after successful initialization
    and bind. Occupied sockets refuse startup before registry initialization when
    observed; connection refusal never proves stale ownership. Failed bind never
    unlinks another listener's socket. Stale recovery is explicit: stop all possible
    owners and remove the path manually before restarting. Diagnostic pipe failures
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
