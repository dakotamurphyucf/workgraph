(** Run the daemon. One main-domain dispatcher owns state; a bounded worker
    domain owns filesystem operations. Admission canonicalizes workspace/restore
    roots and export destinations and rejects overlap with registered/reserved
    storage or the registry. This is trusted-local ownership, not protection
    against concurrent external filesystem replacement. *)
val run : env:Eio_unix.Stdenv.base -> registry:string -> socket:string -> unit

(** Serve an already prepared listener using the same dispatcher and disk
    workers as [run]. The caller owns the listener's lifetime and endpoint
    permissions. Unlike [run], this does not install process signal handlers.
    [daemon.shutdown] drains admitted work before returning.
    This also permits deterministic in-memory transport tests without binding
    an operating-system socket. *)
val serve
  :  env:Eio_unix.Stdenv.base
  -> registry:string
  -> listener:[ `Generic ] Eio.Net.listening_socket_ty Eio.Resource.t
  -> unit
