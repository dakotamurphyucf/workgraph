(** Standalone CLI entry. Uses Eio capabilities for all IO, returns an exit code,
    never changes global toolchain state and never retries a request implicitly.
    Saved request files are created and synced before a request is sent. *)
val run : env:Eio_unix.Stdenv.base -> string list -> int
