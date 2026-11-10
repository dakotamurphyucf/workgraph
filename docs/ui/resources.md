# Resources: exact files and recoverable publication

Resources retain versioned content independently from their editable metadata and
associations. The UI is under qualification; the rules below describe its
implemented boundary, not a public-release claim.

Select a workspace to browse resources, or select a project to browse its
associations. An exact resource link can legitimately identify a resource outside
that project filter; the viewer says so. A resource metadata revision guards
metadata changes. A content version and SHA-256 digest identify immutable bytes.
They are different values, even when both happen to be `1`.

## Read an exact publication

The left list and right reading pane scroll independently. Filter by title, ID or
filename on the loaded page; this is not a workspace-wide search. Project selection
filters resource associations, and **Include archived** adds archived records.
**Previous** and **Next** below the file list preserve the directory
capture and the selected document. If a workspace change invalidates a page request,
the last readable page stays visible with the error. **Refresh directory** starts
a new capture from its first page. On a narrow screen, **All resources** returns
from the document to its list.

An ordinary directory selection follows new content publications after verifying
their complete bytes. **History** opens published versions; its **Previous** and
**Next** buttons keep the original list revision, even if metadata updates while
the dialog is open. A failed page request leaves the previous page visible with
the error. Close and reopen history after refreshing metadata to start a fresh
capture. Choosing a version
pins the reader to those immutable bytes. Evidence links can additionally pin the
expected digest. Current metadata continues updating in either mode, including
the title and archive state. Metadata refresh never substitutes newer content for
an explicit version pin. A missing version, unavailable retained connection generation or
digest mismatch remains an error; the UI never substitutes current content.

The browser fetches bounded chunks at the same capture, validates their identity,
range and digest, and verifies the complete file before enabling **Download
verified file**. Files up to 64MiB are supported. Rendering uses a bounded preview;
a partial preview is labeled and its download is distinct from the complete
verified file. Raw bytes and source remain available. Markdown and the bundled
code languages render passively, with a language override. Embedded HTML, images
and external links do not execute or fetch automatically. Binary data has a raw
byte fallback.

History can identify a content version without a recorded digest. Progress and
review evidence can identify both version and digest. Unversioned fact references
explicitly resolve the current resource at their retained endpoint. None of these
links silently switches to a different connection generation.

## Edit a document or metadata

Choose **New document** or **Edit text publication** for a complete verified file.
**Details & actions** contains metadata, association and archive controls. Closing
an editor dialog retains its original draft under **Retained document drafts**;
reopen that draft to continue with the same captured author and guards. The text
editor accepts at most 64KiB for responsive editing; larger text remains readable,
downloadable and replaceable through file upload. This convenience limit does not
make a resource type unsupported.

Each editor captures the connection generation, workspace, writer and metadata
revision when opened. Switching the acting actor does not rewrite that capture.
Metadata fields distinguish **Keep** from **Replace**, including an intentionally
empty description. Incomplete metadata cannot be overwritten with guessed
defaults. Associations and archive state use separate labeled actions.

An explicit **Save** captures an ordinary operation, prepares its native journal
and sends it once. Local validation failures retain editable input. Once admitted,
the saved intention remains available even after closing its editor. A lost reply
requires exact operation inspection or retry, not a fresh Save with a new identity.
These ordinary operations are separate from native file-transfer identities.

## Publish a file

Choose **Upload file** for a new resource, or **Replace binary publication** on a
captured record for a guarded replacement. Select the complete source, check its
resource ID, title, filename, MIME type and optional ticket link, then:

1. **Stage exact file** hashes the source in a local worker and copies bounded
   chunks into private companion storage. Staging does not publish a resource.
2. **Prepare native upload** durably saves the captured plan and its exact native
   request identity. No daemon upload is sent during preparation.
3. **Start prepared upload** explicitly admits publication. Inspect its saved
   transfer to observe the result.

Before semantic work, each explicit Start, exact retry or receipt-only recovery
qualifies the captured daemon against the companion's exact package version.
There is no cross-invocation qualification cache. Internal native Transfer
exchanges use that captured client; cooperative local sockets do not authenticate
same-version process replacement during an invocation.

Cancelling staging stops the browser observer and may leave a resumable private
input. Retrying staging with the same source identity resumes at the validated
received boundary, including when a chunk or seal acknowledgement was lost. After
native admission, closing or navigating away detaches observation; it does not
roll back or cancel publication.

A committed publication and its optional ticket link have separate outcomes. If
the publication succeeds but the link conflicts, the file is published and its
exact version can be opened. The UI shows the link problem and does not invent a
new link mutation, refreshed guard or successful association.

## Recover without recreating an uncertain write

Open **Transfers**, then **Load native transfers and staged inputs**, to discover
saved jobs and sources after
a browser or companion restart. Use **Inspect saved transfer** first. A running
job found after restart becomes outcome unknown; it never resumes automatically.

**Inspect exact receipts only** reads the saved finish/link receipts without
uploading bytes or making a link change. A missing receipt does not prove that the
write was unsent. **Retry exact saved upload** retains the original native
requests, mutations, guards and source identity. It can replay committed receipts
after the private source has been cleaned. Qualification failure preserves an
older unknown outcome rather than presenting it as a safely replaceable failure.

If local journal publication failed, the job remains **Local save incomplete**.
**Finish saving exact upload** reconstructs the same saved preparation from the
native inventory and completes its local journal save. It needs neither a browser
File nor a new source upload or identity, and it does not contact the daemon.

Private source capacity is separate from mutation state: at most two unprepared
inputs, 64MiB per source and 128MiB total retained source bytes, including prepared
and unknown jobs. Unknown sources cannot be discarded as unprepared input. After a
verified finish is durably recorded, source cleanup is attempted even if the
optional link failed. Cleanup failure is reported independently and does not
negate the committed publication. Saved plans and deduplication identities remain.

These native records live in the companion's private data root. Browser editor
state belongs to the current application launch. Keep the same companion root and
saved identities when restarting; replacing them is not recovery.

### Uploaded file types

An upload without an explicit MIME type is stored as `application/octet-stream`,
which means the type is unspecified. The reader uses filenames such as `.md`,
`.json` and `.py` to select a suitable preview. Other readable UTF-8 text defaults
to Markdown; invalid UTF-8 and binary control bytes keep the binary view.

Changing a resource's filename or MIME type updates the current publication's
preview without uploading its content again. The verified bytes, content version
and downloads stay unchanged. Opening an older version uses that publication's
recorded type; edits to the current document do not rewrite historical versions.
