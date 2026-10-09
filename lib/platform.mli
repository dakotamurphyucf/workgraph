(** Narrow POSIX adapter: Eio owns every descriptor; blocking system calls run
    in Eio system threads. No ordinary file IO uses Unix channels. *)
val sync_directory : _ Eio.Path.t -> unit

val lock_exclusive : _ Eio.File.rw -> bool
val restrict_socket : string -> unit

(** Maximum native pathname socket bytes, excluding its required NUL terminator.
    Uses the compiling platform's sockaddr_un layout. *)
val socket_path_max_bytes : unit -> int

(** Validate an absolute, non-NUL pathname within the native byte bound before
    starting workers or attempting to connect/bind. Errors are Invalid_argument. *)
val validate_socket_path : string -> (unit, Problem.t) result

(** Bind a validated pathname socket without Eio's pre-bind unlink hook. Native
    acquisition/bind/listen/stat calls run in a system thread; the imported Eio
    listener and cleanup belong to [sw]. Failed bind never unlinks. Cleanup removes
    only the successfully bound device/inode; replaced paths remain untouched.
    Expected cleanup failures invoke [on_cleanup_error] and do not mask startup or
    shutdown errors. Cancellation and unexpected exceptions propagate. *)
val listen_unix
  :  sw:Eio.Switch.t
  -> path:string
  -> backlog:int
  -> on_cleanup_error:(string -> unit)
  -> [ `Generic ] Eio.Net.listening_socket_ty Eio.Resource.t

(** Output sink closed its pipe. Only [write_string] raises this exception;
    transport writes remain ordinary transport failures. CLI entrypoints may
    treat this as quiet successful termination. *)
exception Broken_pipe

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
    leaves descriptor ownership and flags unchanged. EPIPE raises Broken_pipe;
    other expected I/O failures raise Json.Decode_error Local_io. Cancellation
    and unexpected exceptions propagate. *)
val write_string : _ Eio.Flow.sink -> string -> unit
