# Content qualification

This is a fixed, source-bound evidence manifest for R11/R12/R15/R16/R19/R24/R25. It does not run a general qualification framework or infer a product pass from a list of tests. `matrix.mts` checks the static matrix type; `matrix.json` is its portable inspection form. Generated run-specific manifests and their typed captures belong in scratch and Workgraph evidence, not source. `audit.py` verifies recorded source/artifact/evidence hashes and exact selected passing cases. It requires actual native diagnostic and owned-process teardown attachments for declared native browser cases; the two isolated renderer-host cases are explicitly component proofs.

Run from the repository:

```sh
python3 ui/tests/qualification/content/audit.py . "$CONTENT_MANIFEST" /tmp/content-audit.json
python3 -m unittest ui/tests/qualification/content/test_audit.py
ui/frontend/node_modules/.bin/tsc --noEmit -p ui/tests/qualification/content/tsconfig.json
```

The recorded source tree and artifact paths in the manifest are immutable local qualification inputs. Reproduction needs the recorded archives and provisioned pinned dependencies. In that source tree, set `WORKGRAPH_UI_TEST_BINARY` and `WORKGRAPH_TEST_BINARY` to the exact recorded companion/core, set `WORKGRAPH_UI_BROWSER_EXECUTABLE` to the installed Chrome executable, then run:

```sh
node ui/frontend/node_modules/@playwright/test/cli.js test --config=ui/tests/qualification/content/playwright.config.mts --reporter=json --output=/tmp/content-browser
```

The two new controls establish real companion content-security headers and real Application behavior for no reported usage versus a reported zero. Existing accepted real-native viewer, format, History, Facts, renderer and text-publication proofs retain their original candidate and exact source-applicability boundaries. The manifest does not relabel a historical binary as current, nor claim the entire broader Recovery report passed when only selected passing content cases are used.

The accepted Editor generation must be accepted and completed through its allowed gate. Current content-first visual polish, keyboard/responsive/theming qualification, final assembled-source checks, native platform/package provenance and public release authorization remain separate gates. This evidence does not authorize release.
