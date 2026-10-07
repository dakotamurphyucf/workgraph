# Validation and limits

Current macOS validation on 2026-10-07 passed the repository's formatting, build,
test and installation-target checks. The executed tests included:

- 127 OCaml expect tests, including randomized domain/replay checks.
- 64 Python integration tests using real daemon processes, Unix sockets and
  local storage.
- Three focused Python suites for the history adapter, service driver and socket
  workflows.

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

Test counts are not performance or capacity guarantees. Current bounds are
documented in the [API reference](api.md#storage-and-ownership) and
[format contract](compatibility.md). There is no history pruning, blob garbage
collection, distributed writer reconciliation or prototype-schema migration.
Actor/run names provide local attribution, not authentication. The harness must
honor ownership before external writes and enforce provider token/time spending.
