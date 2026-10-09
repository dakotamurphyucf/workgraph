# Validation and limits

The integrated macOS ARM64 run on 2026-10-09 passed formatting, build, test and
installation-target checks. It includes OCaml expect and randomized domain/replay
tests, the main 68-case Python process/socket suite, focused feature suites and
generated-reference checks for all 238 public methods. See the
[integration evidence](acceptance/integrated-validation.md) for scope and review
findings. Earlier 2026-10-07 counts describe an older source state.

Run the standard checks from the repository root with a matching toolchain:

```sh
./dev build @fmt @runtest @install
```

The tests exercise decoded data and deterministic replay, exact retries after
restart, claims and attempts, resource transfers, review/reconciliation rules,
history retrieval, export/restore and selected storage-failure boundaries. Fixtures
and examples are included in the source repository; tests need Python's standard
library and no model credentials or hosted service.

This evidence covers the tested macOS environment. Historical Linux/aarch64
container checks used earlier builds and do not qualify the current source or
an AlmaLinux/WSL package. Actual WSL execution and hardware power-loss behavior
are not established by this evidence. Process termination, injected errors and
successful filesystem sync calls do not prove a storage device's power-loss
behavior.

The [AlmaLinux package recipe](almalinux.md) writes `qualification.json` only
after its build checks and independent tarball/RPM runtime checks succeed. That
record identifies the target, version, source identity, artifact SHA-256 hashes,
build checks, runtime results and scope limits. Runtime acceptance checks cover
an installed executable without an OCaml toolchain, dynamic-library resolution,
Git clone/resume, export/restore and history adapter retry/search/payload workflows;
the tarball and RPM executable hashes must match. Check the record and its
matching release artifacts before treating a package as qualified. This page
does not establish a successful AlmaLinux run. Container qualification covers
AlmaLinux userspace on the container host kernel; actual WSL execution remains
a separate check on the intended Windows host.

Test counts are not performance or capacity guarantees. Current bounds are
documented in the [API reference](api.md#storage-and-ownership) and
[format contract](compatibility.md). There is no history pruning, blob garbage
collection, distributed writer reconciliation or prototype-schema migration.
Actor/run names provide local attribution, not authentication. The harness must
honor ownership before external writes and enforce provider token/time spending.
