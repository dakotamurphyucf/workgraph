(** Standalone CLI entry. Uses Eio capabilities for all IO, returns an exit code,
    never changes global toolchain state and never retries a request implicitly.
    Explicit agent-local contexts provide defaults overridden by command fields;
    no current-ticket or process-global actor is selected. Durable writes journal
    prepared requests to exclusive synced files before transmission when configured.
    Retry preserves the saved request, without applying context fields or resaving.
    Unknown methods fail locally before journaling or transmission; upload/download
    helpers remain explicit local operations outside the daemon method catalog.
    Method spellings resolve against that catalog, including dotted and nested
    forms. Help resolves before context loading, journaling or socket access;
    option values and literal child argv following [--] are never help flags.
    [--params-file -] or [--field-file FIELD -] consumes stdin exactly once;
    multiple consumers reject before reading. Input is bounded to 4MiB, preserves
    bytes/newlines and is validated before journaling. Retry never rereads stdin.
    Resource download to [-] writes raw bytes, with its receipt on stderr. Direct
    streaming may emit a prefix before an integrity error; [--spool ABS_NEW_FILE]
    verifies/publishes a fresh file first, then copies it to stdout and retains it.
    Init/bootstrap are the only workspace-creating setup operations and may start
    a detached daemon with an explicit registry/log; ordinary calls never do so. *)
val run : env:Eio_unix.Stdenv.base -> string list -> int
