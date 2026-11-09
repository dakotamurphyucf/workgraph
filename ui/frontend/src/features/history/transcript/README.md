# Recorded session history

This feature reads workspace event streams. Generic content is the default: a session may contain measurements, imported logs, conversation messages, binary files, or unknown event kinds. Provider formats are optional validated presentations from the closed history-format registry. Unknown, malformed, unretained, and partial content keeps its metadata and available source bytes.

`createHistoryController({http, operations})` has application lifetime, outside view mounts. `HistoryFeature({context, controller, operations})` uses the shared operation controller for explicit create, archive, and reviewed event-input batches. Native history supports no rename, deletion, unarchive, or general provider-file import endpoint. Import here means current `session.append` event inputs, in separately reviewed batches of at most 128 events; it never executes the next batch automatically.

Reads capture connection ID, endpoint generation, workspace, history head, and session/event bounds. Metadata and payload reads share that capture. Event sequence and history commit sequence are different values. Directory offsets, event-window traversal, and byte offsets are separate continuations. Session-at-capture links need no invented event; event links require a real positive event bound. Missing captures or retained generations show unavailable and never fall back to current history. An old-generation session cannot silently become a write target on a retargeted profile.

Visible bodies are fetched in one ordered batch, with explicit partial prefixes and byte continuations. A complete preview stops at 16 MiB independently of full-file download. Payloads are exact bytes; UTF-8 decoding and rich rendering do not change the retained source. Loaded prefixes and source viewers are bounded and never imply complete retrieval. Reported provider metrics retain their exact source scope; they are not computed session totals. Tool/result relationships require validated identifiers and unique matches, and original events remain available.

The independent download worker supports one active file up to 64 MiB, one acknowledged chunk up to 256 KiB at a time, pinned identity/offset/size, a 300-second absolute deadline, and explicit cancellation/progress. It decodes, assembles, and checks the whole-file SHA-256 before returning a downloadable Blob. Worker assembly, digest input, and Blob backing storage may transiently total about 192 MiB; only one completed file is retained by this controller. Native history currently hashes the whole blob before every range read, so large files can take several minutes. Supported-platform qualification must measure this deadline; current-host timings are not platform proof. Small preview and ordinary read deadlines are unchanged.

`onNavigateTarget` is an optional host callback carrying an immutable exact run, resource content version, or planning-scope target, including connection generation and workspace. Until the owning views supply it, the UI displays selectable exact identifiers and an unavailable-navigation notice. Resource content version is the native resource revision, not its metadata revision. The callback does not select a writer or authorize a mutation. Actual cross-surface composition remains mandatory for the final history and functional browser gates; this feature alone does not qualify that integration.

Focused checks from `ui/frontend`:

```sh
node node_modules/vitest/vitest.mjs run tests/history/transcript
npm run typecheck
node node_modules/eslint/bin/eslint.js src/features/history/transcript tests/history/transcript --max-warnings 0
```

The maintained `tests/history/transcript/transcript.browser.ts` uses the real embedded application, owned disposable native daemon/companion processes, DOM interactions, independent CLI readback, and an independent saved-file hash. It needs an explicitly qualified matching binary pair via `WORKGRAPH_TEST_BINARY` and `WORKGRAPH_UI_TEST_BINARY`, plus an available Playwright browser. Do not describe fixtures, unexecuted assertions, or another source artifact as final qualification.

The refined conversation view renders all ordered text/tool/reasoning blocks and
retains one event-source/download disclosure. Session directory state survives
same-workspace selection; exact continuation appends rather than replacing earlier
rows. Passive refresh retains valid immutable projections while new data is
prepared. Search, Usage reports, Session summary and all reviewed action editors
share the History section navigation and design-continuity styling.

The overview uses native run/attempt usage grouped by run. `run.sessions.total`
determines whether a row names a sole session or shared run. It is not inferred
from the visible directory page. Standard token/cost samples and calculator
semantics are documented in `docs/ui/history-usage.md`; the UI creates no usage
report just by reading a transcript. Separate session-fact accounting was considered
and explicitly not adopted.

Normal entry loads the first 60 events. Continuation appends another 60; Load all
uses sequential pinned reads through a captured bound and can be stopped. Rows are
published only after their bodies and projections are ready, so cancelled reads do
not replace earlier content with empty placeholders. New live appends follow only
when the reader intentionally reaches the loaded bottom; interactions with details
pause following. JSON formatting preserves numeric lexemes; byte downloads retain
the original source. The session context panel resolves many-to-many run links and
adds distinct run totals once, with shared spending explicitly identified.
