# Workgraph UI

Workgraph UI is an optional local browser interface for the same Workgraph records
used by the CLI. This guide describes the **0.8.2 UI**,
including its connection, planning, communication, history and content tools.
The independently installable CLI is described in the [main guide](../../README.md).

A **workspace** holds related work and shared context. A **ticket** describes one
unit of work. An **actor** names the person or agent attributed to an action. A
**run** records one invocation of an agent. The **daemon** is the local service
that checks changes and saves records. Your runner starts processes and performs
external actions; Workgraph coordinates those actions and retains their evidence.

A **guard** is an expected revision or claim token checked to prevent stale or
wrong-owner edits. **Durable** means saved to storage before success is acknowledged.

A **capture** identifies the data returned by a read. Planning lists use a workspace
revision to keep pages consistent: if the workspace changes, continuing that list
may fail and require a fresh capture. That revision does not reconstruct old
planning state. A history head, resource content version or fact version can instead
identify retained historical data. The UI distinguishes these from live views. In Facts
and Resources, a failed continuation leaves the last readable page visible.

Start with [installation and connections](installation.md).
Read the [0.8.2 release notes](../releases/v0.8.2.md) for version and
upgrade boundaries.
[Optional platform packages](packages.md) describes package builds and paired daemon setup. Read
[recovery](recovery.md) before resolving an interrupted change, and
[architecture](architecture.md) for the boundary between browser, companion and
daemon. [Administration](administration.md) covers export, restore, offline migration
and exact journal recovery. [Resources](resources.md) explains immutable file viewing,
private staging and receipt-first upload recovery. [Rich viewers](viewers.md) covers
lossless JSON, static raster previews, syntax/source controls and exact version comparisons. The [agent reference](../../skills/workgraph/references/ui.md) explains how
UI activity and CLI ownership coexist.

## Continuing the UI design

For contributors and agents, [Design continuity](design-continuity.md) records the
Overview and Manage Workspace refinements, their rationale, implementation map and
page-by-page checklist. Read it before extending the visual or interaction design.

## Find your work

[Overview and Activity](overview.md) explains current counts, bounded readiness,
foreground change observation and captured source links.
[Search and typed links](search.md) explains captured results and exact destinations.

The UI is organized around a selected connection, workspace and planning scope.
A connection is a remembered local Unix socket endpoint. Each browser tab has its
own selection. Changing tabs or switching an actor is not a login operation.
Actor names are cooperative attribution, not authenticated credentials. The
daemon still enforces eligibility and ownership for the supplied actor.

| Area | What it is for |
| --- | --- |
| Overview and board | Scan projects, milestones and tickets; filter work and inspect readiness, ownership and review blockers. |
| Graph | Explore and edit dependencies and containment through guarded workflow changes. A parent-child relationship alone is not a scheduling dependency. |
| Workflows and policy | Prepare related planning changes, eligibility policies, guardrails, evidence and review requirements; inspect their guards before submitting them. External tools still run through your runner. |
| Agents, runs and attempts | Inspect recorded participants, invocation state, ownership and checkpoints. These records do not launch agents or prove process liveness. |
| Communication | Read messages, discussions, questions and inbox delivery. Reading a notice does not acknowledge it; resolving a question is a separate recorded action. |
| History | Browse arbitrary recorded event collections, search a captured range and inspect exact payloads. |
| Reported usage | Inspect caller-reported run/attempt measurements with their units and coverage. These are not provider billing or quota enforcement. |
| Facts and resources | Read small structured memory and versioned artifacts, inspect links and publish guarded changes. |
| Activity | Observe recorded changes and attention without confusing an update with acknowledgement or completion. |
| Custom views and Advanced | Choose bounded declarative presentations or inspect discovered methods and their current schemas. |

Lists can be partial. Continue available pages and inspect coverage, omissions and
capture information before interpreting an empty result. Live, stale,
disconnected and partial describe different observations. A refresh must not mix
pages from different captures or silently replace content you pinned for reading.

## Read and answer discussions

Discussions uses a collection on the left and the selected conversation on the
right. On narrow screens, select a conversation to open it, then use **All
discussions** or **All requests** to return to the collection. Browser Back and
Forward retain ordinary navigation history.

Use **Discussions** for boards, threads and ordinary replies. The inline composer
captures the acting author when you first type; switching actors does not rewrite
that draft. New messages appear through live reads without replacing your text.
Source and display controls expose the original text and alternative rendering.

Use **Requests** for questions with a designated resolver and recorded outcome.
The list has native open/resolver filters and a title filter that applies only to
the loaded page. Continue native pages to see further results. Opening a question
keeps the collection's filters; changing projects starts a fresh collection.
The detail separates question, responsibility, contextual comments and answer.
The question and answer are exact pinned versions; contextual discussion comments
are current versions in attachment order. **Accept responsibility** is distinct
from acknowledging delivery or resolving the question.

Type an answer and choose **Review answer & resolve** to inspect the guarded saved
action, then **Apply captured action** to submit it. Workgraph enforces the
resolver's authority. Request actions expose reassignment, cancellation, metadata,
delivery acknowledgement and history. Retained drafts and saved actions remain
available for inspection and exact recovery; a failed or uncertain write does not
create a replacement automatically.

## People, agents and runs

**Participants** opens with recorded runs. The table shows the actor, recorded
state, objective, last observation and capabilities. Counts describe the displayed
page; missing observation times stay unknown. These are workspace-wide records,
even when a project is selected. A recorded `running` state is not a process check.

Use **People and agents** for registered identities and retained authors, or
**Attempts** for work recorded against ticket claims. **Views & filters** includes
the actor catalog, coordination summaries, runner actions, attention limits and
heartbeat records. Run and attempt details open in a dialog; session links retain
the History capture associated with that record. Browser Back returns to the prior
view, and opening a record from a project keeps that project selected.

Choose **Record a change** for the available write actions. A form captures its
original writer and target when opened. Closing the dialog keeps the draft;
reopen it under **Record a change** to continue. Review the saved action before
executing it. Changing your current actor does not transfer a retained draft to
the new actor. Workgraph records invocations and observations; your harness still
starts and stops the actual processes.

## Allocation, reservations and outside work

The other **Participants** tabs organize workspace-wide coordination records:

- **Allocation rules** defines shared pools, ticket eligibility and declared paths.
  A pool slot is one allocated ticket; multiple attempts on that same ticket do
  not consume extra slots. Eligibility can require capabilities, pool capacity
  and an explicit set of actors.
- **Reservations** shows actual holders of named resources or logical paths.
  A logical path describes a scope in a named worktree; it does not restrict
  filesystem access. Inspect a hold to renew, release, add an advisory note or
  review guarded recovery. Expiry alone never releases ownership.
- **Outside conditions** connects tickets to external operations and exact
  artifacts. A matching signal records evidence that a condition was met;
  Workgraph does not run the outside work.
- **Recovery records** preserves past recoveries and lets an operator inspect
  a claimed ticket. Recovery requires explicit confirmation that the previous
  owner stopped or was isolated, along with the captured ownership guards.

Choose an action on a record or above the collection to open its dialog. Closing
keeps the draft under **Retained action drafts**, including its original author
and target. **Review** prepares a guarded request; **Execute saved request** sends
it. New updates preserve expanded record sources. Counts and capture labels
identify partial pages; a captured continuation stays pinned to that read.

Under Reservations, **Inspect holders and waiting runs** reads an explicit target
and then follows updates. Actual holders and advisory waiting are shown
separately: a waiting observation does not promise a queue position or a grant.
**Saved bounded waits** contains previously saved acquisition attempts. Inspecting
or reopening one never starts it; Start and Retry exact are explicit actions.

## Received direct messages

In **Discussions → Received messages**, choose an actor or run and select **Read
received messages**. **Use current actor as recipient** copies your current
identity once; changing the acting author later never retargets this query.
Expand **Ticket, interval and reading queue** to filter by ticket, skip earlier
notifications or exclude the recipient's own actions.

Message cards show the sender, recorded time and original delivered body. Source
edits do not replace that body. **Reply with direct message** opens a draft
addressed to the sender, using your acting author. Delivery details expose the
original notification and source revisions; **Open exact received-message
capture** retains the recipient, filters and notification interval in its link.

This browser uses its own read-only consumer (a named reading queue). It never
acknowledges notifications and does not change your actionable Inbox. External
acknowledgements for this exact consumer can still remove entries. These are
received deliveries, not a complete sent-message or conversation archive.

## Inbox and notification routing

**Inbox** reads notifications for an explicit actor or run. Choosing another
acting author does not change that recipient. **Read Inbox** follows new events;
**Wait once** performs a single bounded read. A captured notification link keeps
its original recipient, consumer and range. With no notification kinds selected,
the UI reads all kinds; selected kinds narrow the query.

A consumer is a named reading queue for that recipient. Select the notifications
you have handled, review **Acknowledge selected for this consumer**, then apply
the saved action. Other consumers retain their own unread state. Reading, waiting
and expanding source details never acknowledge anything. Live updates preserve
checked notifications and expanded details for the same query. Acknowledgement
uses only the selected IDs still present in that captured page. Request delivery
acknowledgement, responsibility and resolution remain separate actions.

**Routing** lists teams and subscriptions. Teams group recipients; changes affect
future expansion, not recipients already recorded on requests. Subscriptions
route future matching notifications to an actor or run. Their cards show active
state, recipient, scope and event-kind filters. Use the guarded editors to review
and apply changes; the subscription's recipient remains immutable.

## Wait for a request

In Discussions → Requests, open a current request and expand **Wait for resolution with a time limit**.
Enter a total of 1000–300000 milliseconds (1–300 seconds) and a polling interval of
250–25000 milliseconds (250 milliseconds–25 seconds), then explicitly select
**Start wait**. **Stop waiting** cancels only this foreground
read; it does not acknowledge delivery, accept responsibility or resolve the
request. Navigating to another request stops the old wait. Historical snapshots
require opening current before waiting.

The result distinguishes a pinned answer, resolution without an answer, request
cancellation, incomplete data and the wait deadline. A pinned answer keeps its
captured revision even if the current comment is later edited. Deadline or
transport errors do not trigger a retry: start again explicitly when ready. The
page labels any retained result from an earlier completed wait separately.

## Act as the intended writer

You can freely choose the actor for a new draft and, where appropriate, an
optional run. Switching the selector does not rewrite an existing draft or saved
operation. Its original connection, scope, actor, run and guards remain visible;
prepare a new draft deliberately when those inputs should change.

Choosing an actor does not grant a ticket claim. Starting eligible work asks the
daemon to claim it. Keep the actual returned claim token and use that owner, token
and run for protected progress or completion. Never adopt another owner's visible
token. Recorded ownership, an expired lease or a cancellation request does not
prove that an external agent process stopped.

In Work, fill the draft and select **Review action** to capture and prepare it
without sending. Check the original writer and destination, then select **Apply action**.
A committed creation shows **Saved** and, when its exact destination is available,
**Open created ticket**. Other tools name their explicit send action separately,
such as **Execute saved request** for a workflow batch. A lost reply retains the
saved operation identity. Follow
[recovery](recovery.md) rather than creating the same change again. A workflow can
combine up to 128 expanded planning operations in one bounded transaction;
preflight checks neither commit the change nor reserve future state. Completion
still obeys current prerequisites, amendments, evidence and review policies.

## Read history without guessing its meaning

Workgraph history is an ordered collection of caller-supplied events. It may hold
agent conversations, logs, sensor records or arbitrary binary data. The Generic
view is always available and shows recorded metadata, ordering, capture coverage
and safe payload previews without imposing agent semantics.

Use **History → Sessions** for the session overview, then open a row to read its history.
**Open**, **Archived**, and **All sessions** are visible lifecycle filters. Open
means the session accepts new events; it does not mean an agent is running.
Archived sessions retain their events and payloads, reject appends, and cannot be
reopened or deleted through the current API. The Archived view filters each
loaded page of the native all-sessions directory; continue paging when more
entries are available. Overview counts describe the captured page, not workspace
totals. Recorded actors, scopes and server-observed timestamps come from the
API; unknown timestamps stay unknown. Use **All sessions** above a transcript to
return to the overview. The directory covers the
workspace, even when a planning project is selected. **Find in loaded sessions**
filters titles, actors and IDs on the current directory page; **Search** is the separate
history-content search. **Filter sessions** changes directory order or the exact originating run. **Session actions** provides creation,
import and archiving. The overview also shows independently captured, externally
reported usage by project. Run reports are not attributed to individual sessions,
and arbitrary named metrics are not guessed to be dollar costs. Search, Usage
and Summary have their own navigable tabs.

An ordinary current-session view follows new events automatically. When you
scroll back through the transcript or select an event, the visible event window
stays fixed while session metadata continues to update. A new-events notice tells
you when more has arrived; **Follow latest events** resumes the current window.
**Earlier events** and **Later events** browse retained windows. Explicit links to
a history head remain pinned until you deliberately refresh current. Format and
window details explain which events and bytes are actually loaded; a session's
total event count is not the number currently displayed.

Timeline presents the loaded messages inline. Tool output, original payloads,
reported metrics and exact source identities remain available in disclosures.
Large or partial bodies keep their retrieval controls and visible coverage
warnings. Rendering is bounded, and a failed preview never discards its raw source.

Auto selects a richer presentation only when a bounded complete payload validates
against exactly one supported versioned format. An explicit format choice still
validates. Ambiguous, malformed, unsupported and mixed events retain a Generic
fallback and exact raw access. A role label, model name, filename or vendor hint
alone is not proof of a format.

The supported format choices distinguish Anthropic Messages responses, OpenAI
Responses objects and events, Chat Completions, Claude Agent SDK messages and
pinned Codex rollout wrappers. These are separate formats with bounded supported
variants, not universal vendor decoders. Raw Claude Code JSONL remains Generic
unless its exact producer version and wrapper are supported. Format coverage
describes only the loaded event window; unloaded events and unsupported payloads
are reported separately. Selecting a format never rewrites native history.

For a validated session view, tool calls and results may be grouped only by exact
matching references. Unmatched or ambiguous events remain separate. A reported
final answer can point back to every source event without hiding raw records.
A source-reported success or end marker is not proof of ticket completion or
process exit. A missing timestamp stays unavailable; event order does not create
a source time. Hidden, redacted, encrypted or unretained reasoning is never
reconstructed.

Reported numbers retain source, units, scope and coverage. Missing is not zero.
Cumulative snapshots must not be added together or mixed with overlapping totals.
Run usage is not silently assigned to individual sessions. Search coverage and
whether more results exist are separate facts; neither a loaded range nor an
empty partial page describes the whole collection.

## Read and edit content safely

The UI provides readable Markdown with tables, bundled
syntax highlighting, lossless JSON, diffs and verified raster-image previews.
Known language hints, MIME types, filenames and code fences guide presentation;
readable prose defaults to Markdown where appropriate. A local language/render
mode override and Raw/Source access change presentation, never stored content.
Large, partial, invalid or unsupported content gets a clear fallback rather than
being passed off as a complete rich document.

Content remains passive. Markdown HTML, scripts, executable plug-ins and embedded
frames do not run. External Markdown images stay inert placeholders. Standalone
PNG, JPEG, WebP and GIF previews require complete pinned bytes, verification and
successful bounded decoding. Their controls include fit, actual size, zoom and
dimensions; motion respects reduced-motion preferences. Unsupported or malformed
images retain a download/raw fallback. No preview fetches a remote image merely
because an imported document names one.

JSON preserves exact numeric text, including integers beyond JavaScript's safe
integer range. Structured editing preserves unknown fields and distinguishes
missing, explicit null and deletion. Facts are small structured replacements with
explicit guards; larger artifacts belong in resources.

**Facts** has an independently scrolling key directory and value pane. The
initial scope is the selected project (or the workspace if no project is
selected). **Scope & filters** selects an explicit workspace, project, milestone
or ticket scope and applies literal key prefixes or exact scalar predicates.
The directory search filters only the loaded page; scopes never inherit values.
**Previous** and **Next** below the keys browse one captured directory.
Selecting a key keeps the directory page; **Refresh facts** starts from the latest
first page without discarding an explicit historical value selection.
Choose **Structure** for labeled JSON fields or **Raw JSON** for the lossless
value. Attribution shows the stored author, time and fact revision; ordinary
selected values update live without collapsing open details. Explicit historical
links retain their fact version. **Read fact history** opens attributed versions,
including deletions. **Previous history page** and **Next history page** browse
the same captured list. If intervening workspace changes invalidate a continuation,
the last page stays visible with the error; close the dialog, refresh the fact,
and reopen history to start a new capture. **Open this version** selects that exact version; **Return to
current value** explicitly resumes the latest value. Refresh keeps a historical
version selected. Restoring a version creates a guarded replacement draft.
Selecting a key or browsing an explicit scope updates the URL, so Back, Forward
and copied links restore that selection. Scope filters remain in this browser
session while switching keys in the same scope; they are not embedded in the URL.
**Find references** searches facts referencing a ticket or resource, with
**Previous** and **Next** for the captured results. Changing the referenced entity
starts a new lookup. Closing an
editor retains its draft, scope and original author in **Drafts**, even after
switching the acting actor. Values remain distinct from missing keys and deletions.

**Resources** has an independently scrolling file list and reading pane. Filter
by title, ID or filename within the loaded page, include archived records, or
use **Previous** and **Next** below the file list to browse the same
capture without closing the selected document. **Refresh directory** returns to
the latest first page. **History** opens immutable content versions with **Previous** and **Next** pages;
**Details & actions** contains metadata, associations and archive controls.
**New document** and **Edit text publication** open retained editor dialogs;
**Upload file** and **Transfers** expose the separate native transfer workflow.
Closing a dialog preserves drafts and never cancels an admitted publication.
Ordinary directory selections follow new verified publications. Explicit version
links keep their original bytes while current metadata continues updating.

A resource has current editable metadata and immutable published content versions.
A content pin identifies resource, version, SHA-256 and byte size. Downloads and
complete previews must verify all bytes before reporting success. Metadata edits,
links and archive changes advance metadata revision without publishing new bytes.
`resource.history` lists retained content versions in increasing version order,
including archived resources; it is not a log of metadata edits. Use
`resource.get` for current metadata. A diff compares explicitly selected versions
and discloses truncation or unsupported content.

**Saved views** separates your **Library**, unfinished **Builder** and working
**Results**. Switching sections preserves draft inputs. Import, shared catalogs
and retained private targets have their own dialogs. Opening or preferring a saved
configuration does not activate it. A successful **Activate view** opens Results;
the first page follows live changes, while continued pages keep their captured
snapshot until **Fresh query**. See [saved views and renderers](custom-views.md).

Custom views are small validated configurations for selecting and arranging known
data and renderers. They do not introduce an expression language, downloaded code,
arbitrary shell commands or a way around ordinary guards. Invalid configuration
keeps a visible error and safe default view instead of changing the data.

## Discover and run an exact operation

**Advanced** opens a method explorer beside recovery and host-tool shortcuts.
Search by method name or purpose, filter by family, or switch to **Helpers** and
**Host tools**. The catalog and selected method contract come from the installed
executable. Host commands are displayed for you to copy; the browser does not
execute them.

Select a method, then **New draft** to capture its connection and acting writer.
Edit parameters with the form or exact JSON source. **Run read** performs a read;
a mutation requires **Validate & prepare**, review of the captured destination,
and **Execute saved request**. None of those steps happens merely by opening a
method or draft. **Explorer** returns to discovery without losing the draft.

**Saved intentions** lists captured requests in this browser session, with their
original writer and outcomes. Only native-prepared operations have durable
journals; unprepared drafts do not survive reloading the application. Use the
existing inspection and exact-retry controls for an uncertain operation, as
explained in [recovery](recovery.md). The workspace and resource shortcuts lead
to the ordinary management and transfer screens.

### Daemon connections

Open the connection selector at the top of the sidebar to see saved profiles.
**Add connection** or **Edit profile** opens the connection form; closing the dialog
retains unfinished edits. **Manage** opens the selected profile’s daemon controls.
Use **Attach & inspect capabilities** to check that endpoint, then **Use connection**
to select it for browsing. Neither saving a profile nor inspecting it starts a daemon.

In **Daemon**, expand **Start a local daemon** to prepare a launch. Review and start
are separate actions. **Startup history** reopens saved launch records, and the
captured-review shortcut returns to an existing startup or shutdown plan. Editing a
profile never changes the endpoint captured by an already prepared plan. **Offline
tools** provides migration and saved-request inspection without needing a daemon.
