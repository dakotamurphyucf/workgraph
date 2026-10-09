(** Standalone CLI entry. Uses Eio capabilities for all IO, returns an exit code,
    never changes global toolchain state and never retries a request implicitly.
    Explicit agent-local contexts provide defaults overridden by command fields;
    no current-ticket or process-global actor is selected. Durable writes journal
    prepared requests to exclusive synced files before transmission when configured.
    Retry preserves the saved request, without applying context fields or resaving.
    Unknown methods fail locally before journaling or transmission; upload/download
    helpers remain explicit local operations outside the daemon method catalog.
    Init/bootstrap are the only workspace-creating setup operations and may start
    a detached daemon with an explicit registry/log; ordinary calls never do so. *)
val run : env:Eio_unix.Stdenv.base -> string list -> int
