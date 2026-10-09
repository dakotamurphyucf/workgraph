# Runtime walkthrough preflight

On 2026-10-09, `tools/installed_smoke.py` passed against the current build-tree
executable on macOS ARM64. This is preparation for installed-package qualification;
it does not certify an archive, RPM or published release.

The driver issued 58 CLI calls through real daemon sockets, under a minimal
`PATH=/usr/bin:/bin` environment. It created its own registry/workspaces and stopped
all daemons it started. It exercised:

- Workspace/project/ticket creation, dependencies and resource publication.
- `ticket.start`, resume while claimed, progress, explicit handoff and `ticket.finish`.
- Fact values and value-free key discovery, selected facts in resume, completion
  and fact transitions in the activity digest, and workspace metrics.
- Export/verification, closed-writer Git clone and resumed work, then restore into
  a fresh root. Memory checks were repeated after Git handoff and restore.

The first extended run found that an unregistered run label on a valid claim made
`ticket.resume` fail. The corrected behavior preserves that exact claim, returns
the brief, and reports `associated_run_missing`. An explicitly requested unknown
run remains an error. The passing walkthrough inspected the warning and retained
actor/run/token fields; it did not register a run merely to avoid the failure.

The host toolchain remained installed, although Workgraph child processes received
no opam paths or OCaml environment. Final macOS and AlmaLinux qualification must
execute the driver from the installed package, verify its hashes and dependencies,
and check that the packaged guide and generated references match that executable.
