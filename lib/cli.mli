(** Standalone CLI entry. Uses Eio capabilities for all IO, returns an exit code,
    never changes global toolchain state. Ordinary requests never retry implicitly.
    Explicit agent-local contexts provide defaults overridden by command fields;
    no current-ticket or process-global actor is selected. Durable writes journal
    prepared requests to exclusive synced files before transmission when configured.
    Retry preserves the saved request, without applying context fields or resaving.
    Its transport/output option allowlist is checked before reading parameter
    files, stdin or the saved request; retry never materializes new payload input.
    Unknown methods fail locally before journaling or transmission; upload/download
    helpers remain explicit local operations outside the daemon method catalog.
    Method spellings resolve against that catalog, including dotted and nested
    forms. Help resolves before context loading, journaling or socket access;
    option values and literal child argv following [--] are never help flags.
    JSON commands emit one JSON-RPC envelope on stdout for both local failures
    and daemon replies, with a nonzero exit for failures. Local failure IDs are
    ["cli"] until a saved request ID is available; saved IDs remain exact.
    Stderr carries diagnostics such as saved-request paths. Text output and raw
    byte streams keep failures on stderr, including failures before option parsing.
    [--params-file -] or [--field-file FIELD -] consumes stdin exactly once;
    multiple consumers reject before reading. Input is bounded to 4MiB, preserves
    bytes/newlines and is validated before journaling. Retry never rereads stdin.
    Resource download to [-] writes raw bytes, with its receipt on stderr. Direct
    streaming may emit a prefix before an integrity error; [--spool ABS_NEW_FILE]
    verifies/publishes a fresh file first, then copies it to stdout and retains it.
    Evidence inspection is local, bounded and explicit about prefix retention and
    incomplete source coverage. Cleanup requires the exact owned stage token and
    refuses live, unknown or publication-intent stages. Optional upload ticket
    linking is independently acknowledged: a committed publication with failed
    link returns its exact receipt and saved retry path even on a nonzero exit.
    [--paginate] is opt-in for supported read collections, bounded by --page-limit
    and --total-bytes. It retains exact page envelopes and family-specific capture
    guards, selectors and filters; it never restarts a stale capture or paginates
    writes/atomic batches. Incomplete traversal exits nonzero with explicit stop
    and exact next/retry requests. Cancellation propagates without retry.
    Explicit [reservation wait] / [reservation paths wait] helpers bound acquisition
    attempts by a monotonic deadline and attempt count. Each attempt has a synced
    exclusive journal; only definite typed contention for the original batch
    permits a fresh identity. Other failures/uncertainty stop for exact manual
    retry. Actual daemon grants remain separate from local workflow metadata;
    incomplete acquisition exits nonzero. No ownership recovery or queue is implied.
    Init/bootstrap are the only workspace-creating setup operations and may start
    a detached daemon with an explicit registry/log; ordinary calls never do so. *)
val run : env:Eio_unix.Stdenv.base -> string list -> int
