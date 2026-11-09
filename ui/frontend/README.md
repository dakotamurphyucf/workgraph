# Workgraph frontend

This optional React/TypeScript client is served by the native Core/Eio companion. Installed users need neither Node nor opam. The daemon remains authoritative; UI caches are disposable projections. The accepted rich viewers and all product features remain required for final qualification.

Use the exact builder recorded in `../tools/toolchain.json` (Node22.14.0/npm10.9.2); dependencies and their transitive integrity hashes are in `package-lock.json`. `../../dev-ui install` installs only this directory. Do not change global opam or Node defaults. Native development uses `WORKGRAPH_OPAM_SWITCH` to select an already provisioned matching switch; opam package builds use their active environment directly.

Run from the repository root:

UI native/package commands require Dune's default `_build` directory. Custom
`--build-dir` and nondefault `DUNE_BUILD_DIR` are rejected before executing a build,
so artifact checks cannot accidentally inspect an unrelated old binary.

- `./dev-ui check`: ESLint, strict TypeScript, Vitest, formatting and asset-tool tests.
- `./dev-ui frontend`: those checks, Vite production build and deterministic embedding.
- `./dev-ui build`: frontend plus enabled native executable and nonempty optional install manifest.
- `./dev-ui native`: native build using already checked embedded assets.
- `./dev-ui test`: frontend checks, enabled native tests, and actual daemon/companion fixture lifecycle tests.
- `./dev-ui browser --project=chromium`: verifies current embedded assets, builds explicit daemon/companion targets, runs fixture lifecycle tests, then Playwright. Each test owns fresh synthetic daemon data and companion state; no existing workspace, profile or external test URL is used. Browser installation is an explicit development/CI step; no browser download runs in the installed companion.
- To use an existing Chrome installation explicitly: `WORKGRAPH_UI_BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ./dev-ui browser --project=chromium`. This option applies only to Chromium; Firefox/WebKit still require their matching Playwright installations. No missing browser is silently replaced or skipped.
- `WORKGRAPH_TEST_BINARY` and `WORKGRAPH_UI_TEST_BINARY` optionally select absolute daemon/companion artifacts for qualification. The companion fixture records its executable and embedded-manifest SHA256, verifies executable bytes before/after startup, and rejects a concurrent replacement. Coordinate a quiet build window when freezing evidence.
- `./dev-ui verify`: complete frontend/native/browser gates. The browser fixture and actual target browsers must exist; an unavailable or empty test suite fails rather than passing silently.

`npm --prefix ui/frontend run typecheck`, `run lint` and `run test` check source independently. `run build`, `./dev-ui frontend` and an installed companion use the real `src/main.tsx` entrypoint; no generated sample app or synthetic production fallback is supplied. A Vitest suite with no tests fails. The launch creates application services and one operation controller outside React StrictMode. Navigation and acting-actor changes do not replace captured operation identities. Integration tests load an in-memory, same-origin test module that imports the same production launch factory, client and controller; it never enters production assets and does not replace successful API responses. The maintained smoke verifies exact numeric reads, explicit prepared writes, retained identity after navigation, a deliberately failed request with no automatic retry, explicit recovery, and independent daemon CLI readback. Error/external-request checks, failure screenshots and retained traces are part of the harness.

Browser tests live under `tests/e2e`; Node unit tests use `src/**/*.test.*` or `tests/**/*.test.*` outside e2e.

Vite's development server is a loopback development tool and does not implement the companion's Host/Origin/capability/journal boundary. Use the actual companion for security, mutation and acceptance tests. `index.html` contains one `__WORKGRAPH_UI_CAPABILITY__` meta marker; the companion must substitute its validated per-launch capability before serving bootstrap HTML. No inline executable script or remote asset is required.

The actual Vite build records its captured input hash in `dist/.vite/workgraph-build.json` and rejects inputs changing during the build. `../tools/embed-assets.mjs` requires this stamp to match current inputs before either embedding or checking; it cannot bless a stale `dist/` after source changes. Bootstrap HTML is parsed with build-only parse5 to require the marker inside exactly the expected capability meta tag in the document head, rather than inside text/comments/inert markup.

Embedding accepts only exact local manifest paths and bounded regular files, records source/lock hashes, includes browser runtime/helper license texts, and generates `../tools/embedded/generated/workgraph_ui_assets.ml` plus a deterministic manifest. `--check` rejects stale outputs. The enabled Dune copy rule compiles that generated implementation; interface-only compilation can run before frontend assets exist. These generated files and `dist/` are ignored; a release builder recreates and verifies them. The immutable `Workgraph_ui_assets` interface is in `../tools/embedded/workgraph_ui_assets.mli`; the HTTP router owns exact route policy, bootstrap substitution and security headers. A rebuild updates asset identity; it never reads user files at runtime.

Frontend conventions are part of the repository's `engineering-standards.md`: runtime DTOs start as unknown, arbitrary JSON uses the lossless decoder before adapters, writes use the operation controller, and every cache/cancel key includes its actual connection generation and scope. Root and independent review remain required for release acceptance.
