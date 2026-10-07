(** Narrow POSIX adapter: Eio owns every descriptor; blocking system calls run
    in Eio system threads. No ordinary file IO uses Unix channels. *)
val sync_directory : _ Eio.Path.t -> unit

val lock_exclusive : _ Eio.File.rw -> bool
val restrict_socket : string -> unit

(** Resolve an existing native path, including symlinked ancestors. Eio.Path does
    not expose canonical path resolution; the POSIX call runs in a system thread.
    Missing/inaccessible paths raise Unix_error, handled by Disk.protect callers.
    Cancellation propagates. This resolves trusted local paths, not a race-proof
    filesystem security boundary. *)
val realpath : string -> string

(** Atomic no-replacement publication primitive missing from Eio.Path. Both paths
    must be on one local filesystem. Does not sync or remove the source. *)
val link_exclusive : src:_ Eio.Path.t -> dst:_ Eio.Path.t -> unit

(** Atomic no-replacement rename for directories on macOS/Linux. No fallback to
    overwriting rename is permitted on unsupported kernels/filesystems. *)
val rename_exclusive : src:_ Eio.Path.t -> dst:_ Eio.Path.t -> unit

(** Writes through Eio normally. The pinned POSIX backend cannot poll the macOS
    null character device, so that device alone uses an Eio system-thread native
    write with the descriptor pinned by Eio. Handles short writes and EINTR;
    leaves descriptor ownership and flags unchanged. Native errors and Eio
    cancellation propagate. *)
val write_string : _ Eio.Flow.sink -> string -> unit
