# Canonical History API qualification

The nine session/history methods use executable request and result codecs:
`session.create`, `session.archive`, `session.append`, `session.get`,
`session.list`, `history.get`, `history.read`, `history.search` and
`history.payload`. The generated catalog uses those same codecs. Public session
and event records are independent projections of the durable journal format;
legacy request spellings and untagged content are rejected. Opaque payload bytes
remain literal, including invalid UTF-8, while searchable text remains valid
complete UTF-8.

History mutations publish to the independent journal and remain excluded from
planning transaction batches. Every query returns an immutable history capture.
Payload fitting measures the complete public data/meta envelope and returns exact
byte prefixes with explicit cursors, allowing complete retrieval within a small
response budget. No history query advances or publishes planning state.

On 2026-10-08, `./dev build @test/history/runtest` passed on the pinned development
toolchain. This includes public decoder/result invariant tests, canonical typed
command encoding, durable journal tests and the real Unix socket fixture in
`test/history/socket_test.py`. The socket fixture exercises all nine methods;
rejects legacy fields/selectors; verifies source-ID deduplication and changed-run
retry conflict; retrieves 9004 opaque bytes across multiple envelopes bounded to
4096 bytes; pins reads/search/payload to an older capture after another append;
and checks exact create/append/archive receipts and old captures after a daemon
restart. The planning change feed remains identical across the history writes.

`python3 examples/history-recovery-demo.py _build/default/bin/main.exe` also
passed against the real daemon. Its external adapter terminated after an
acknowledged append and resumed without a duplicate. After two context resets,
the driver recovered BLUE and then the recorded AMBER correction, including a
correlated tool call/result whose search hit starts at byte 300001. The fixture
contains 300176 payload bytes. This deterministic demonstration does not measure
general agent productivity.

`python3 tools/check_agent_guide.py .` passed with 207 documented methods. The
History reference describes the current tagged content, event references,
capture/head selection, bounds and response cursors. Source and native packaging
already include the `docs/` allowlisted tree, including this qualification file.

This evidence qualifies the History family. It does not establish complete
executable catalog coverage, the final repository formatter/test/install gate,
or qualification of installed native artifacts.
