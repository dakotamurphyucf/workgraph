# Execution capture and publication qualification

This records the execution-capture slice of WG-07. Acceptance-policy integration,
whole-project release qualification and target-platform packages have separate gates.

The executable implementation is in `Execution_capture`, `Execution_stage`,
`Source_provenance`, `Execution_publication` and `Execution_cli`. Interfaces were
drafted before implementation. These are client-side capabilities; the daemon does
not launch commands or interpret saved output as executable instructions.

Run the focused suite with:

```sh
./dev build @test/execution_capture/runtest
```

The suite has passed on native macOS ARM64. Its checks include:

- Independent malformed launch/outcome/output decoders and binary digest/count
  invariants. Complete output and retained-prefix truncation are separate facts.
- Real nonzero exits, signals, missing executables and cancellation. Both streams
  drain beyond their retained limits. Cancellation preserves a durable interrupted
  capture and propagates to the caller.
- Fresh synced launch intent, refusal to rerun an existing stage, and an unfinished
  intent that never becomes an invented successful execution.
- Dirty tracked files, untracked files, mode changes, symlink targets and deletions
  alter source identity. Ignored content is outside the explicitly declared scope.
  Missing and oversized source observations cannot imply unchanged inputs.
- A real command changes a source file and the before/after observations differ.
- Literal argv after `--`, including `--context` and `--socket`, reaches the child
  without being interpreted as Workgraph options.
- The publication intent is saved before a connection to an unavailable daemon.
  A subsequent proxy consumes a committed finish response and deliberately loses
  the client reply. Retrying returns the original durable receipt.
- An independent execution counter remains at one throughout failed publication,
  lost-response recovery, daemon restart and removal of the local capture file.
  A retry cannot change saved attribution or mutation identity.

The source identity is a bounded Git working-tree observation, not an atomic input
snapshot. It excludes ignored files, Git metadata and submodule contents, and
cannot rule out intervening changes or external inputs. A captured successful exit
does not itself validate relevance or satisfy a ticket's acceptance policy.

The focused suite uses an installed Git executable for its isolated source fixtures.
Production capture reports unavailable provenance when an optional Git observation
cannot be made. Users do not need an OCaml toolchain to run a packaged binary.
