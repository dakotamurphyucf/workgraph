# Isolated UI test fixtures

`startDaemonFixture({binary})` starts the specified real Workgraph executable in a
fresh private `/tmp/wgui-*` root. It returns only after `daemon.health` succeeds
and the synthetic seed is written. The fixture never reads a developer context,
registry, workspace, credentials or default daemon socket.

The public test-helper contract is in `daemon-fixture.d.mts`. `call(method,
paramsJson)` returns the complete raw JSON-RPC envelope. Feed arbitrary values
through the production lossless decoder; do not convert numbers with `JSON.parse`.
All errors retain CLI diagnostics and the process error as their cause.

The default seed includes a project, three dependent tickets, attributed
conversation, passive Markdown resource, a generic history event and exact JSON
facts (`9007199254740993`, `-0`, `1e99`, Unicode and null). Core fact values require
finite numbers; history payload bytes can represent independent formats. Seed
content is test-only and must never become a production UI fallback.

Always dispose the returned fixture in `finally`. Disposal is idempotent: it
signals only its own child, waits for termination, escalates to SIGKILL if needed,
and removes only the private root it created. If termination cannot be verified,
it fails and retains the directory. Startup failures also clean up owned state.
Readiness, child CLI calls, logs and teardown have explicit bounds. Do not kill
processes found through PID files or remove sockets belonging to another process.

Build the current core executable, then run:

```sh
./dev build bin/main.exe
node --test ui/test-support/daemon-fixture.test.mjs
```

`fixtureBinary()` uses the current checkout's `_build/default/bin/main.exe`.
Set `WORKGRAPH_TEST_BINARY` to an absolute executable to qualify an installed
artifact instead. Neither path consults `PATH` or runs shell commands.
The Playwright fixture in `ui/frontend/tests/e2e/support/fixtures.ts` creates one
owned daemon per test. Actual companion HTTP startup and browser workflows are
qualified separately; these lifecycle tests do not prove those surfaces work.
