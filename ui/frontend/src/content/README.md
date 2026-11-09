# Passive content foundation

`ContentViewer({source, client?})` renders one immutable `ContentSource` capture.
Import from `./content`; CSS is bundled by the viewer. Caller identity must include
connection generation and resource version/event identity, not just a mutable display
name. Treat `bytes` and the source object as immutable. Replacement capture objects
cancel old jobs; old source outcomes never render in the replacement view. The caller
owns retrieval, durable cursors, full-resource downloads, draft state and capture
integrity verification. `completeness: "partial"` means loaded bytes only.

`createContentWorkerClient()` exposes `render(request, signal?, {waitForCapacity?})`,
`decodeJson(request, signal?)`, and `dispose()`. A client shares admission across its
jobs. The viewer's default client is shared by all mounted viewers. Inject one client
when a parent needs a separate bounded lifecycle. Dispose an owned client at teardown;
never dispose the default shared client. Each active job owns one disposable module
worker. Admission copies and transfers captured bytes, leaving caller bytes attached.
Viewers defer offscreen work and opt into cancellable FIFO capacity waiting. Waiters
retain immutable caller bytes without allocating a transfer copy until admitted;
leaving the viewport or replacing the source cancels waiting/active work. Completed
previews stay visible when scrolling, without reparsing unchanged captures.

The JSON job invokes the existing core lossless decoder, preserving numeric lexemes,
source and duplicate-key rejection. It does not modify the HTTP client, infer provider
formats, reassemble streams, or convert arbitrary numbers through `JSON.parse`/`Number`.
Integrators can move decoding of large captured bodies into this worker explicitly.
Known protocol field decoding remains a separate typed operation after the JSON job.

Metadata precedence is per-view override, explicit language, MIME, filename extension,
then intent/default. Recognized readable prose defaults to Markdown. Unknown explicit
code language stays plain code. No code autodetection occurs. The local grammar set is
OCaml, TypeScript, JavaScript, JSON, shell (Bash), Python, Markdown, YAML, TOML (INI
syntax grammar), HTML/XML, CSS and diff. This is syntax coloring, not format validation.

Markdown lexing produces only our closed `RenderNode` tree. React receives fixed tags
and known alignment/start properties. Raw HTML is literal text. Links/images are passive
labels and destination text, preserving the exact lexer-consumed token plus parsed
`target` and `title` for a future authorized typed-link resolver. This foundation never
creates links, images, HTML, frames, event handlers or external requests from content.
Entity decoding applies only to prose/labels. Code, raw/source, destination descriptors
and capture bytes retain their original representation. A leading UTF-8 BOM is omitted
only from Markdown presentation; exact source/copy/download retain it.

Limits are exported as `CONTENT_LIMITS`: 16MiB input, 2 active workers, 24 total admitted
jobs, 128 additional cancellable capacity waiters, 32MiB admitted source bytes,
10s execution deadline starting at worker startup; synchronous worker
phases have a 2s watchdog. Selected parsers are synchronous: cancellation/deadline
terminates computation rather than pretending they yield cooperatively. Rich previews
admit 2MiB/100,000 lines/250,000 nodes/depth96; highlighting uses the same
2MiB/100,000-line allowance. Over-budget
rich output falls back to a bounded source window when computation returns promptly;
a stalled worker reports a preview-budget failure, retaining Raw and byte download.
The producer checks the actual combined Markdown and syntax DTO with the same aggregate
node/depth budget as the wire validator; nested code cannot produce a rich tree which
its own consumer rejects. Capacity waiting does not retry failed parsing or any daemon operation. Low-level
callers that do not request waiting still receive explicit admission failure. A failure is distinct from
legitimate decoder error data.

Source windows contain at most 200 lines/64Ki UTF-16 units, at most 4096 UTF-16 units per
line, with explicit omissions and next/previous controls. Raw windows contain at
most 4096 bytes. Invalid UTF-8, binary controls or known binary MIME use a hex fallback.
Raw mode never forces UTF-8 decoding. Source copy is exact decoded text only up to
2MiB; byte download preserves BOM/CRLF/encoding and is labeled loaded bytes for a
partial capture. Captures larger than 16MiB require the containing feature's streaming
retrieval/full-download action. Override affects presentation only.

Clipboard feedback belongs to the current capture/code-node lifetime. Permission denials
are notices; unexpected errors are owned in state and thrown during React rendering for
the containing error boundary. No clipboard rejection is left floating. Selecting a new
capture clears feedback immediately and ignores late completions, including switching
away and back to the same immutable source.

The test-only fixture at `tests/content/fixture.html` imports the actual component and
worker. Its synthetic data and intentionally blocked deadline worker are excluded from
the production entry. Build it with `WORKGRAPH_CONTENT_BUILD_DIR=/absolute/ignored/path
node_modules/.bin/vite build --config tests/content/vite.config.ts` from `ui/frontend`.
Serve that output on loopback 8772 and run
`WORKGRAPH_CONTENT_EVIDENCE=/absolute/ignored/path node --experimental-strip-types
tests/content/browser.mts`. This proves actual local worker assets, CSP-compatible
execution, passive hostile content, source fidelity, termination and responsiveness.
Feature retrieval/integration and native serving remain separate qualification.
