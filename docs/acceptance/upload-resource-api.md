# Upload and resource API qualification

Eight additional methods now have executable request/result descriptors:
`upload.begin`, `upload.chunk`, `upload.status`, `upload.abort`,
`resource.finish_upload`, `resource.get`, `resource.list`, and `resource.history`.
The four upload operations are actor-owned ephemeral writes. Their observations
contain declared byte identity and contiguous staging progress, with empty
response metadata. Only the separate resource finish mutation acknowledges
durable planning publication.

Public resource summaries use `resource_id`, content versions use `actor_id`,
and metadata targets use resolved tagged references. The durable resource codec
remains independent. Query fitting operates on a validated summary view, with
explicit budget omissions for clipped prose/target arrays; immutable identity,
filenames, MIME types, versions, digests and byte counts remain complete.
Publication data is validated during pure planning preparation before commit.

On 2026-10-08, the upload OCaml expect tests passed in a consolidated root build,
including malformed request/result inputs, canonical Base64 and opaque bytes,
generated-ID rules, filename/MIME validation, domain versus public records,
bounded summary views, publication byte identity and pagination cursors. The
combined command also selected coordination tests and exited unsuccessfully
because an unrelated coordination fixture needed a type annotation; this is
not a claim that the final repository test gate passed.

The real Unix socket upload fixture passed both directly against the fresh
binary and through its Dune rule. It exercises all eight descriptors, uploads
280004 binary bytes in two bounded chunks, accepts exact range retries and
rejects gaps, partial overlaps and changed bytes. It verifies private actor
ownership, incomplete/checksum-failed publication, abort, separate content and
metadata revisions, version-history pagination, canonical public fields and
resource views within 4096-byte envelopes. Restart discards unfinished staging
while exact durable finish retry still returns the original receipt.

The same fixture exercises the real saved CLI upload plan: after successful
publication, deleting the source file and retrying the saved request recovers
the identical finish receipt. Transfer digest/size/progress fields remain
unchanged. The agent reference bundle checker passed after documentation updates.
Existing source/native package allowlists include this `docs/` qualification.

This qualifies the eight-method slice. Complete executable catalog coverage,
the final formatter/build/test/install gate, and installed native artifact
qualification remain separate work.
