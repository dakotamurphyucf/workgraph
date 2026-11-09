# UI design continuity: Overview and Manage Workspace

This is the working design reference for continuing the Workgraph UI, recorded
from the November 2026 user walkthrough. Read it after context compaction and
before changing another page, modal, tab, editor or shared component.

It records the user’s direction, the implemented changes, their rationale and
implementation boundaries. It is not a declaration that the entire UI is approved,
that every page already follows these rules, or that release qualification is done.
The user accepted the first Manage Workspace redesign as a reasonable first pass,
then requested additional close controls and explanations. Continue the joint,
page-by-page review rather than treating that acceptance as blanket approval.

## 1. Design intent and reference precedence

The target is a polished local command hub with a Linear-like feel, specialized
for Workgraph’s planning, communication, context and execution records. It should
be inviting and understandable to someone who has never used Workgraph. Functional
forms alone do not meet the design goal.

The user’s original POC was valuable because its text was easy to read, colors
made information recognizable, and rounded enclosing panels gave each section a
clear shape. The early implementation lost that character: small gray text,
faint borders, compressed forms and weak hierarchy made information feel
unimportant and the application unfriendly. The redesign deliberately reverses
those choices.

Use references in this order:

1. The user’s latest explicit notes for the page under review.
2. A fresh screenshot of the **current Overview**, which now incorporates the
   readability and color refinements. It is the visual baseline for other pages.
3. The original mockup and POC for page structure and interaction intent.
4. The real API, schemas and controller contracts for what the UI can truthfully
   show and change. A visual example never overrides data semantics.

The original mockup must be opened and compared visually for every view it covers.
Similar colors on a substantially different layout are not fidelity. For features
without a mockup, use the same visual language and informed judgment. Do not
revert to the older, smaller typography because it exists elsewhere in the code.

Do not ship local demonstration screenshots or workspace data merely to preserve
a reference. The local recovery notes identify the private evidence. Capture a
fresh reference during the next session; the live application may have evolved.

## 2. Core rules

- **Readable first.** Supporting information should remain worth reading. Muted
  text establishes hierarchy; it must not look disabled or nearly disappear.
- **Color communicates meaning.** Use recognizable status, category and actor cues,
  accompanied by words or icons. Avoid both a monochrome interface and arbitrary
  decoration with no stable meaning.
- **Compact rows, spacious forms.** Reduce unnecessary vertical stacking in lists.
  Give editors enough width, field spacing and explanation to be understandable.
- **Sections have a visible shape.** Use rounded enclosing cards, with headings
  inside the border and a distinct header surface. Avoid floating headings over
  visually unrelated content.
- **Preserve the reader’s place.** Refreshes must not collapse details, replace
  usable content with loading prose, reset scroll, or disturb a draft.
- **Make cause and effect clear.** Explain what each action changes before it is
  applied. Review, execute, inspect, hide, cancel and discard are different actions.
- **Progressive detail is purposeful.** Optional conceptual help can collapse.
  An action’s essential effect belongs visibly inside its form. Ordinary users
  should not have to open raw JSON to understand the operation.
- **The data must remain honest.** Unknown is not zero; a recorded claim is not
  proof a process is alive; partial results are not a complete inventory.
- **Consistency includes behavior.** Matching typography while retaining broken
  navigation, one-way pagination or disruptive refreshes is insufficient.

## 3. Visual language

### Color and surfaces

These are the current Overview dark-theme values. Overview uses local tokens such
as `--text`; the management modal uses corresponding `--wg-*` overrides. Reuse
semantics rather than assuming these namespaces are already a global theme.

| Role                   | Current value | Use                                                   |
| ---------------------- | ------------- | ----------------------------------------------------- |
| Application background | `#111318`     | Quiet canvas behind panels                            |
| Sidebar                | `#15171d`     | Navigation surface                                    |
| Panel                  | `#1c2028`     | Card and modal body                                   |
| Raised surface         | `#252b35`     | Card headers, inputs, explanatory panels              |
| Border                 | `#3c4554`     | Clearly visible section boundaries                    |
| Primary text           | `#f4f5fa`     | Titles, content and important values                  |
| Secondary text         | `#c8cfdd`     | Explanations and supporting information               |
| Muted text             | `#aeb9cc`     | Metadata that still needs to be readable              |
| Accent                 | `#a1a8ff`     | Navigation and interactive emphasis                   |
| Green                  | `#7de4aa`     | Ready/to-do cues                                      |
| Yellow                 | `#f4d76d`     | In-progress cues                                      |
| Orange                 | `#ffb86e`     | Blocked or attention-worthy conditions                |
| Blue                   | `#91baff`     | Completed work and selected structural cues           |
| Purple                 | `#c4a3ff`     | Claimed/backlog or project-category cues, with labels |
| Pink                   | `#f6a6d4`     | Questions                                             |
| Danger                 | `#ed8d99`     | Error/destructive emphasis where appropriate          |

The metric cards use soft tinted backgrounds and stronger colored icons. Most
body text remains neutral and bright. Category colors do not replace status
labels: for example, a purple Projects tab is navigation, not a claim state.

Manage Workspace distinguishes Projects with purple, Milestones with gold,
Workspaces with blue and Maintenance with green. Maintenance sub-tabs additionally
use green for Exports, blue for Restore, gold for Offline migration and purple for
Journals and recovery.

Light mode needs its own readable contrast. The manager uses primary `#202635`,
secondary `#455168`, muted `#5c687b`, white panels, raised `#f1f4f9` and borders
`#cbd3df`, with darker category accents. Do not copy pale dark-theme foregrounds
onto white surfaces. Check the actual rendered screen in both themes.

### Typography, spacing and shape

| Element                                     | Current reference                            |
| ------------------------------------------- | -------------------------------------------- |
| Base readable content                       | Approximately 15px, line-height 1.5          |
| Supporting explanations                     | 14px, often line-height 1.65                 |
| Main section headings                       | Overview 16px; management card headings 17px |
| Modal title / internal page heading         | Approximately 21px / 23px                    |
| Large Overview metric values                | Approximately 30px                           |
| Dense row metadata                          | 12–13px when genuinely secondary             |
| Enclosing section cards                     | 16px radius and visible 1px border           |
| Metric and management navigation cards      | Approximately 14px radius                    |
| Main management modal                       | 20px outer radius                            |
| Inner tables, help and explanatory surfaces | Approximately 10–12px radius                 |
| Overview list row spacing                   | Roughly 10–11px vertical, 16px horizontal    |
| Actor/avatar marker                         | Approximately 30px in Overview               |
| Management panel padding                    | Approximately 18–22px                        |
| Form field spacing                          | Approximately 20px vertical, 24px horizontal |
| Input text / labels                         | 15px / 14px                                  |

The “wider borders” request was implemented as more substantial, clearly enclosing
surfaces and spacing, not indiscriminate thick outlines. Active navigation may use
an additional inset stroke. Keep keyboard focus visibly distinct.

Use the system sans-serif family already used by Overview. Keep identifiers in a
readable monospace style; do not make an entire row look like a debug log. These
values are a baseline, not a command to give every compact timestamp the same size
as a paragraph. Never shrink a whole page just to fit more rows.

## 4. Overview changes and their rationale

### Page composition and statistics

The page has a clear workspace/project heading, short explanation, concise live
summary, distinct metric cards and two columns of bounded section cards. Cards
include Needs attention, Ready to pick up, Claimed work, Recent activity and
Projects. Follow the current responsive layout instead of adding unrelated boxes.

Metrics are individually rounded, separated and softly tinted, with a colored
icon, readable label and prominent number. The top row must not change height
because one count refreshes. Missing data uses a neutral placeholder, never a
fabricated zero. A genuine persistent count failure is reported outside the metric
grid rather than expanding one card with a long warning.

### Projects and progress

Project rows now show a linked title, completion percentage, segmented progress
bar, completed/total count and a compact colored legend. Status segments partition
the total: Done is blue, In progress yellow, To do green, Backlog purple and
Canceled muted. The percentage measures completed tickets.

**Blocked is an overlapping readiness count, not another status segment.** It is
shown separately. Adding blocked to the stacked bar would double-count tickets.
If the complete breakdown is unavailable, show the known completion bar and state
that the full breakdown is unavailable. Do not invent missing segments.

Project enrichment uses real project briefs and status counts at the parent
planning capture. Counter calculations preserve decimal-string/BigInt semantics
until a checked display conversion; do not casually coerce API counters to numbers.

### Needs attention

Rows use kind-specific colored icons and labels, a meaningful title, compact
supporting context, available actor attribution/avatar and expandable details.
Questions and review items deserve distinct treatment; a generic warning glyph
for every row loses the distinctions the user requested.

Enrichment must respect the source: planning detail must match the parent planning
revision. Request/question enrichment has an independent communication query
revision and is admitted only for the same still-open request/question. Do not
label independently current communication data as the same planning snapshot.
Missing actors stay unknown rather than borrowing the currently selected user.

### Claimed work

Use a recognizable actor marker, ticket title, actor/run context and available
progress excerpt. The excerpt is a short, visually subordinate quote with a small
accent border, not another giant card. Compact rows can still contain several
useful pieces of information by arranging a title, byline and excerpt coherently.

Resolve actual claim attribution when the API supports it. An expired claim must
not silently appear as an active worker, and an actor record does not prove a
process is running. Demonstration claims are data fixtures, not live agents.

### Recent activity and Details

Overview reuses the Activity entry component for actual attribution, event time,
category, source links and details. Use recorded audit attribution, not the
current assignee of the affected ticket. Include visible time; retain access to
its full value and source revision where available.

The initial Overview activity read was bounded to the latest 100 workspace
revisions with a 100-item limit and 1 MiB request budget. Preserve explicit user
filters; a bounded recent feed is not an exhaustive audit history. These limits
are implementation choices, not generic defaults for every activity surface.

The Details affordance was moved into the normal row flow next to the metadata.
It must not sit at a far edge, fade until hover, or be clipped by the card. It is a
plain disclosure with a transparent background, like Needs attention, and a
visible focus outline. Metadata and Details can wrap; expanded detail takes a
full row. Do not restore the pill background or absolute positioning that caused
the original awkward alignment.

### Initial loading, refresh and live changes

First load uses **one coherent skeleton** resembling the final page, with a single
accessible loading message. Skeleton blocks are hidden from assistive technology.
They do not pretend to be real counts. Overview waits for its initial essential
reads to settle; a failed read must still leave a usable error/partial state,
not an endless skeleton.

After useful data exists, refresh retains it. Returning from another page should
reuse available state without flashing separate loading messages in each card.
Background refresh and foreground refresh must not compete to replace the screen.
The Questions metric no longer embeds a generic loading wrapper that expanded
the stats row. Refresh controls retain their width to avoid layout movement.

The brief yellow “count cannot be refreshed” warning was a real cancellation
ownership bug, not a color problem. A foreground refresh canceled a passive read,
which published an aborted result as a failure. The fix passed ownership
cancellation into the read slot as well as the transport, combined scope/caller
signals, and stopped passive refresh from starting while a foreground refresh
owned the page. Superseded reads cannot publish warnings into a new owner. Real
failures remain visible; do not fix flicker by suppressing every error.

New data must appear through live observation while the view is active. A Refresh
button is a manual recovery/convenience action, not the sole update mechanism.
Live refresh must preserve expanded details, stable row identity and scroll
position. It must also preserve drafts and avoid replacing deliberately pinned
or historical content. This rule applies equally to ticket comments, discussions,
history, resources and other views as they are revised.

## 5. Manage Workspace redesign

### Layout and navigation

The modal was widened from roughly 860px to `min(1240px, 100vw - 48px)`, with height
`min(940px, 100dvh - 48px)`. On narrow screens it uses smaller viewport margins and
a two-column tab grid; form fields become a single column. These are maximums,
not a requirement to overflow a smaller screen.

The title and category navigation remain visible while the content scrolls.
The modal body uses a flex layout with `min-height: 0`; the section content owns
its vertical overflow. This is deliberate: putting `overflow: hidden` on the
wrong ancestor previously made entire views impossible to scroll.

The four category tabs have colored icon tiles, readable titles and small purpose
labels. Selected tabs have a clear border and tint. Each section begins with a
plain-language explanation. List/table containers and maintenance cards use the
same rounded surfaces and bright typography as Overview.

Editors now appear ahead of the list, inside a category-colored enclosing card,
rather than being a difficult-to-find form below a long table. Short fields use
two columns when space permits; longer description/instruction fields span the
width, and related rich-text fields can share a row. Labels remain readable.
Guarded forms show the captured item ID/version in a compact summary instead of
making those technical values dominate the form.

Priority uses named choices: 0 Unspecified, 1 Urgent, 2 High, 3 Normal, 4 Low.
Do not describe 0 as highest; that was caught and corrected against the API.

### Drafts belong to their originating section

The original bug was a retained editor rendered without checking its action kind.
Opening a project edit, then selecting Milestones, left a project editor under
the wrong heading. Maintenance had an equivalent sub-tab issue.

The lifecycle editor now renders only in its owning section. Section-local state
such as notices and selected inspection is reset through a keyed section, while
the actual draft remains in the external store. Returning to the section restores
the draft. **The current lifecycle store still supports one retained draft at a
time.** Trying to begin another section’s draft gives an explanation instead of
silently replacing the retained one. Do not claim independent simultaneous
lifecycle drafts have been implemented.

Administration already supports multiple drafts. Its active/fallback selection
and draft shortcuts are filtered by the owning sub-tab; returning restores the
appropriate draft. Frozen/pending requests keep their captured actor, endpoint,
scope, guards and retry identity. Navigation never silently recaptures a draft.
Closing an editable draft and hiding an inspection are different operations.

### No raw-data clutter in the manager

Passive raw registry/page/continuation/response disclosures were removed from
this modal. They were distracting to beginners and could trigger expensive viewer
work when observations changed. Removal is at render/presentation level, not
merely CSS hiding a still-mounted JSON viewer.

A scoped `ManagementPresentation` context preserves raw tooling in other surfaces
that need it. Important information remains available as ordinary UI: labeled
captured action values, completion checks, offline plans/results and journal file
rows. `CapturedValues` passively renders validated values without starting a
syntax-highlighting worker. `JournalDirectorySummary` retains filenames, errors
and duplicate/conflict information without displaying the protocol envelope.

Do not blindly remove information needed to review a change or recover an
uncertain result. Conversely, do not reintroduce generic “Raw object” controls in
this beginner manager just because a shared component supports them.

### Every opened result needs a way back

The follow-up added hide/reopen controls to loaded export/receipt results, offline
job lists, saved operation lists, journal directory/request inspections, project
completion checks and saved-action reviews. Users must not have to change tabs
to get rid of an opened section.

Dismissing a query clears/cancels its browser read, not the underlying daemon job.
Hiding a saved-action review preserves its exact request and shows a reopen
control with its current state. Hiding is not cancellation, deletion, discard,
acknowledgement or execution. Existing draft close controls retain their own
semantics. Use precise verbs and check reopening, not just hiding.

### Two levels of instruction

There are two deliberately different help surfaces:

1. **Section help** (`ManagementHelp`) is a compact, collapsible guide below the
   introduction. It explains concepts and when to use the section. Expanded help
   uses short term/definition groups in responsive columns, with the section’s
   accent color. It can always be collapsed again.
2. **Action help** (`ActionExplanation`) is visible inside every editor, before
   the fields. The “What this will do” panel states the concrete outcome, important
   constraints/field behavior, and Review → Execute/Apply steps. Essential
   consequences are not hidden behind optional documentation.

Keep language concrete. Explain a term on first use rather than assuming the
reader understands daemon, actor, receipt, mutation ID, stage or guard. Teach
where it is useful; avoid an unrelated glossary occupying the whole screen.
Do not replace specific action explanations with a generic “manage this item.”

The action explanations cover:

| Actions                        | Required explanation                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create workspace               | Creates/registers/opens a new empty workspace at a fresh folder; name versus permanent ID; location is on the daemon machine                      |
| Register workspace             | Checks and opens existing data in place; does not make a copy or import an export                                                                 |
| Open / close                   | Loads/unloads availability; files remain; archive state is distinct; ongoing work may prevent closing                                             |
| Unregister                     | Removes the closed registry association, keeps files and allows later registration                                                                |
| Edit workspace                 | Updates displayed metadata/instructions; clearing text clears it; instructions are guidance, not permission enforcement; does not move the folder |
| Create project                 | Adds the project; does not create tickets or launch agents; explains next steps and generated IDs                                                 |
| Edit project                   | Updates the displayed fields; defines acceptance criteria; status editing is distinct from completion checking                                    |
| Finish project                 | Checks requirements and records evidence/handoff; does not finish open tickets implicitly                                                         |
| Create/edit milestone          | Explains a stage and owning project; status changes do not complete tickets or finish the project                                                 |
| Schedule milestone             | Sets the planning target date; blank clears it; does not start work or change ticket deadlines                                                    |
| Archive / restore archive flag | Sets aside/preserves data or removes the flag; does not delete, back up, import or mark work complete; explanation follows the selected action    |
| Export / export all            | Snapshot, destination rules, job outcome and implications of allowing partial capture                                                             |
| Cancel / retry export          | Targets an existing job; cancellation request is not proof it stopped; retry preserves its original capture/destination                           |
| Restore / restore all          | Validates an export into fresh locations, registers closed, explains ID conflicts and interrupted multi-root recovery                             |
| Cancel restore                 | Uses original actor/mutation identity; allowed only before targets are installed/occupied                                                         |
| Offline migration              | Converts only the supported released 0.6.2 format; stopped source, fresh output, report and separate registration                                 |
| Stage cleanup                  | Deletes only an unpublished owned temporary stage; explains the owner token and the destructive effect                                            |

Reviewing prepares a request. It does not apply the workspace change. Execution,
or applying the prepared offline helper, is a separate explicit action. Explain
this clearly without claiming preparation itself creates no local records.

## 6. Shared implementation map

Paths are relative to the repository root. Read the current source before copying
an approach; the table identifies responsibilities, not a promise of frozen APIs.

| Source                                                                  | Responsibility                                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ui/frontend/src/features/overview/prototype-overview.css`              | Overview palette, typography, cards, compact rows and scoped activity styling |
| `ui/frontend/src/features/overview/dashboard.tsx`                       | Main Overview composition and data presentation                               |
| `ui/frontend/src/features/overview/project-progress.tsx`                | Status partition, progress bar and legend                                     |
| `ui/frontend/src/features/overview/attention-appearance.ts`             | Attention category/icon/color presentation                                    |
| `ui/frontend/src/features/overview/client.ts`, `types.ts`, `codecs.ts`  | Native data enrichment and validated contracts                                |
| `ui/frontend/src/features/overview/controller.ts`, `presentation.tsx`   | Retained reads, quiet refresh, ownership and cancellation                     |
| `ui/frontend/src/features/overview/OverviewLoading.tsx`                 | Coherent initial loading surface                                              |
| `ui/frontend/src/features/overview/OverviewFeature.tsx`                 | Loading gate, modal composition, keyed management sections                    |
| `ui/frontend/src/features/overview/overview-settings.css`               | Management layout, category colors, forms and explanations                    |
| `ui/frontend/src/features/activity/ActivityEntry.tsx`                   | Shared activity row and metadata/details structure                            |
| `ui/frontend/src/features/connections/LifecycleFeature.tsx`, `store.ts` | Lifecycle lists/editors, capture preservation and draft ownership             |
| `ui/frontend/src/features/administration/AdministrationFeature.tsx`     | Maintenance tabs, filtered drafts and dismissible reads                       |
| `ui/frontend/src/features/connections/shared.tsx`                       | Shared review controls and management-specific hide/reopen behavior           |
| `ui/frontend/src/features/connections/management-presentation.ts`       | Scoped beginner-management presentation context                               |
| `ui/frontend/src/features/connections/CapturedValues.tsx`               | Passive labeled review values                                                 |
| `ui/frontend/src/features/administration/JournalDirectorySummary.tsx`   | Readable saved-request inventory                                              |
| `ui/frontend/src/features/connections/ManagementHelp.tsx`               | Contextual section explanations                                               |
| `ui/frontend/src/features/connections/ActionExplanation.tsx`            | Typed action-by-action consequences and review/apply guidance                 |
| `ui/frontend/src/components/Dialog.tsx`, `Primitives.tsx`               | Native dialog/focus behavior and common panel/field/button primitives         |

The action copy maps are typed against lifecycle/admin action kinds. Keep them
exhaustive when adding actions. Archive explanation depends on the actual archive
selection. Do not freeze instructional text to the button that originally opened
the editor if the user can change that selection.

Keep semantic HTML, native disclosures, accessible labels, focus outlines,
keyboard operation and modal focus handling. Text is rendered passively; do not
introduce executable custom markup. Preserve strict decoding, exact counters,
revision guards, cancellation, immutable captures and explicit retry behavior.

Many refinements are intentionally scoped to Overview or the management modal.
They have **not** automatically migrated every shared consumer. The full Activity
page still has its own presentation rules, for example. Inspect every consumer
before broadening a selector. Consolidating shared tokens/components is useful
when actual reuse warrants it; do not perform an unrelated CSS rewrite in the
middle of a user’s page-specific walkthrough.

## 7. Applying the pattern to the next page

Before implementation:

- Read this guide and the current engineering standards. Recover the active
  ticket, latest user feedback and the correct preview from local/Workgraph notes.
- Screenshot the current Overview and compare the target view with its mockup.
  Inspect actual rendered styles; source declarations alone do not establish the
  winning cascade or final layout.
- Read the API and models for the page’s entities, actions, timestamps, status,
  ownership, pagination, partial results and live/pinned captures.
- Inventory the whole page: empty and populated views, every tab, modal, editor,
  detail disclosure, result panel and recovery/error state.

During implementation:

- Apply readable typography, colored semantics, rounded enclosing cards and a
  coherent hierarchy. Keep compact lists and spacious forms distinct.
- Add actor avatars, time, provenance and progress only where the data supports
  them. Use meaningful sample data to exercise claimed work, attention and errors.
- Explain each section and every action’s consequences. State important blank-field
  behavior, target machine/folder, completion semantics and review/apply boundary.
- Give opened subviews close/hide/back controls. Preserve drafts and exact requests
  when hiding or changing navigation. Do not use remounting as accidental discard.
- Use one tidy first-load state, retain useful content during refresh, and keep
  details/scroll/focus stable. Make real failures visible without treating
  cancellation as a new error.
- Ensure live changes are observable without Refresh. Preserve explicit historical
  pins. Fix Browser Back/Forward and both directions of pagination where relevant;
  do not present a one-way “Next” interaction as a complete design.
- Verify the actual scroll container and min-size constraints, including inside
  dialogs. Long IDs and titles must wrap or scroll locally without breaking the
  page. Do not solve crowding by clipping necessary controls.
- Avoid mounting expensive raw viewers unnecessarily. Normal rendering bursts
  should queue/cancel appropriately instead of forcing manual refresh. The user
  rejected tiny arbitrary content budgets; justify limits with representative
  measurements rather than making normal JSON or ticket content unusable.

Before presenting the page:

- Inspect screenshots personally against the reference in dark and light mode,
  desktop and relevant narrow widths. Check expanded content, not only empty cards.
- Exercise create/edit/archive forms and their explanations; check archive/restore
  copy changes with the actual selection. Check hide/reopen and retained drafts.
- Trigger a live update and manual refresh while reading an expanded item. Check
  scroll position, retained detail state, stable metrics and absence of false
  loading/error flashes. Include cancellation during navigation when relevant.
- Run focused type/lint/format and behavior checks appropriate to the changes.
  Do not substitute massive repeated test runs for visual judgment during design
  iteration. Full repository/native/browser/platform gates remain required at
  final qualification; focused preview checks are not that qualification.
- Keep the established preview URL and preserve its demo data. Update only owned
  preview processes, verify their identity, and avoid navigating the user’s browser
  unexpectedly. Prefer an isolated browser for checks and screenshots.
- Present the page for the user’s walkthrough. Do not close visual acceptance
  tickets or proceed to release because the code compiles or silence follows.

## 8. Evidence and recovery boundaries

The Overview passes included focused controller checks and native-browser tests
for project status bars, attribution, retained Details, initial loading, quiet
refresh and the Questions cancellation race. Management checks covered 19 editor
flows, tab-scoped draft retention, dark/light/narrow layouts, hidden/reopened read
results, and a real prepared-but-unexecuted action whose review retained its values
and state. Action-copy checks included archive-to-restore transitions. These are
specific observations, not exhaustive release certification.

The development preview used a previously qualified native baseline with a
reviewed source overlay. It must not be described as full qualification of every
current-root native change. Keep exact build hashes, process IDs and private test
artifacts in local evidence notes, not this durable design document.

After compaction, the minimal recovery sequence is:

1. Read this document through the pointer in `AGENTS.md`.
2. Read the active agent’s recovery index for current scope, newest notes and
   remaining approval gates. Old appended process IDs are not authoritative.
3. Query the actual Workgraph project/ticket and retrieve the design-continuity
   resource if needed. A copied resource is a snapshot; compare it with this file.
4. Verify the current preview state and take a new Overview screenshot before
   styling another view.
5. Continue from the latest user feedback. Do not restart the design from an old
   mockup, silently resume stopped workers, or mark the overall project complete.

When a later walkthrough changes a rule, update this guide, its Workgraph copy
and the short recovery pointers together. Keep source documentation authoritative;
keep local experiments and session-specific handoffs in `scratch/`.

## 9. Notifications modal: applying the same design language

The Notifications button beside Manage Workspace opens a spacious dialog sharing
the manager's header, readable type, dark/light palette, rounded outer border and
scrolling body. Reuse that foundation rather than maintaining competing modal
sizes. The content is split into two clearly titled cards: **Choose update
sources** and **Observed changes**. Purple identifies preferences; green identifies
the live reader. Each card has a colored icon, raised heading area, generous form
spacing and concise purpose text. Narrow screens stack the choices vertically.

The source selector uses three radio cards instead of an unexplained small select:
workspace changes only, workspace plus selected actor, or workspace plus selected
run. Define actor and run in place, show the selected identifier, and explain how
to make an unavailable choice available. Disabled choices remain readable. Keep
unsaved selection separate from the currently applied filter, disable redundant
Apply actions, and initialize reopening from the controller's actual selection.
The modal is keyed by connection/workspace/project/actor/run scope so old recipient
rows cannot leak into a different selection.

Explain effects honestly: applying changes this Overview's read filter, not daemon
subscriptions, desktop alerts, message acknowledgement or question resolution.
Preferences currently survive closing the dialog within this Overview controller,
not a browser reload. Optional detail belongs in a reversible “What these settings
change” disclosure; the primary choices and apply consequences remain visible.
Provide a direct route to Discussions for replying or acknowledging messages.

Observed changes use compact rows with semantic icons and colored category labels:
blue tickets, purple facts, gold readiness/policy, and pink communications. Show
real revision and notification count where available, and link ticket changes to
the ticket. Do not invent avatars or timestamps when this API row lacks reliable
attribution or wall-clock time. These observations are not the complete activity
history or a durable inbox; say so explicitly.

While the modal is open it follows changes through the existing attention reader,
with visible Pause/Resume and close controls. Closing stops its listener without
turning off the main Overview's independent live refresh. A captured result with
remaining pages requires Load more before the reader advances to newer changes;
never skip a continuation to make the UI look live. Errors and exhausted read
budgets remain visible and automatic retry does not spin on them.

Keep the latest 100 observed rows locally, deduplicated by kind, exact revision,
change index and communication fragment notification IDs. Sort decimal counters
exactly, without JavaScript Number truncation. Empty wait responses preserve rows;
changing the applied source resets the local observations. Read progress should
change a compact status badge, not clear the list or expand the whole dialog with
loading messages. The observed list scrolls within the overall scrolling modal.

Implementation references: `NotificationSettings.tsx`, `notification-model.ts`
and `notification-settings.css` under `ui/frontend/src/features/overview/`, plus
the shared modal rules in `overview-settings.css`. Focused model/controller checks
and native browser checks cover this design pass; they do not replace final full
repository/platform qualification or the user's visual acceptance.

## 10. Work: boards, lists, filters and ticket conversations

Apply the Overview palette and readable hierarchy to the entire Work surface,
including actions opened from it. The user's board reference combines compact
colored status headers with rounded, clearly separated cards; the inspector
reference gives the ticket's description and conversation enough room to read.
Keep lifecycle status distinct from computed readiness: a To do ticket can still
be blocked by dependencies or actor rules. Do not translate Graph ready into a
persisted status or imply that a graph check grants permission to start work.

### Collection layout and loading

Board cards use 14px corners, 15px titles, readable secondary text, colored status
icons and real actor avatars. Columns are about 320px wide and scroll with the
collection. List sections have rounded enclosing borders, a clear heading/count
and compact rows. Preserve long titles and locally wrap identifiers. Use named
priorities instead of unexplained numbers. Empty assignment is Unassigned; a
recorded assignee and the current claim owner are different properties.

The board traverses the daemon's validated ticket continuations and displays all
matching tickets. Each traversal must retain one revision, contiguous offsets and
unique IDs. Publish a successful collection together; never combine different
revisions or replace useful rows with a failed intermediate traversal. Keep byte
truncation and missing continuations visible. Full collection reads still use
bounded native requests; removing page buttons does not remove protocol budgets.

The list initially displays 20 tickets per group. **Load more** reveals another 20
in that group without replacing previous rows or changing other groups. This is
currently local reveal over the same complete captured collection, not an API
query per status. This deliberate local-workspace tradeoff makes the board and
list agree and avoids a confusing global Next page interaction. Consider larger
collection optimization only with evidence; do not quietly introduce a low total
cap. Keep reveal counts and scroll stable during refresh. Reset them on changes
to actual scope, filters or grouping. On initial load use one coherent state;
background refresh retains the last useful collection and inspector.

### Filters and action forms

Start Filter with common presets and visible search, lifecycle, assigned actor
and named priority fields. Fetch known actors through the existing Participants
API, preserving its validated pagination and revision semantics. Include observed
actors even if they lack a registration record; presence in this list does not
mean they are online or eligible for a ticket. Explain that assignment filtering
does not filter active claims. Assigned to me uses the selected acting actor.

Keep manual actor IDs, labels, milestones and archived records in a reversible
Custom filters disclosure. If actor lookup fails, show a retry and leave manual
entry available. Changing read filters never updates tickets. Close controls and
Apply actions must remain visible and usable at narrow widths.

New Ticket, ticket actions and Labels & statuses share spacious rounded dialogs,
clear purpose/effect explanations and readable two-column fields that stack on
small screens. Label and status choices are explanatory cards. Existing-record
directories support loading an edit target, and each form explains whether blank
values are unchanged, absent or cleared according to the actual command. Describe
archive/restore effects without implying deletion or daemon shutdown. Review shows
human-readable prepared values before Apply. Hiding an editor retains its draft;
only explicit discard removes it. Preserve original actor/run and revision guards
through all of these presentation changes. Label/status definitions decorate
records; they do not redefine the daemon's fixed lifecycle or admission rules.

### Inspector and conversation

The inspector opens about 780px wide on desktop, can grow to 1080px, and fills
narrow screens without horizontal overflow. Use a 26px title, readable properties
and description, rounded readiness/property cards, and clearly separated tabs:
Conversation, Links, Completion, Who can work and Details. Give status and readiness
semantic color without relying on color alone. Keep the selected ticket mounted
when a live workspace revision changes; revision changes are data updates, not a
new navigation identity.

Render ticket comments as a chronological conversation: author avatar/name,
colored comment kind, timestamp, Markdown/code body, then compact Reply and
Edit/history controls. Place the composer after the conversation. Keep exact
source/display tools secondary, below rendered content; provenance should not
visually overwhelm the message. A reply records its actual parent comment ID.
Editing and history still use guarded operations and author rules. Comment kinds
such as progress or decision distinguish updates without inventing separate
messages or changing request-resolution semantics.

Merge loaded comment pages and live updates by ID, retaining the newest revision
and sorting sequence counters exactly. Preserve already loaded comments when
loading another page, preserve tombstones/history, and never resurrect an older
revision over an edit. Stable record keys keep disclosures open when another
message arrives. Scope the retained timeline to connection generation, socket,
workspace and ticket; do not leak messages when switching targets. Retain existing
live-reader limits and report partial content honestly. Comments are not the
complete workspace activity feed, and posting one does not automatically resolve
an open question or acknowledge a notification.

Clear the composer only after confirmed commit. Failed or uncertain writes keep
the draft and exact operation identity; a closed successful editor still leaves
its journal receipt. Additional attempt, checkpoint and handoff controls remain
available below the conversation rather than interrupting ordinary reading.

Implementation references: `features/work/collection.ts`, `read-model.ts`,
`actor-choices.ts`, `views/WorkFilters.tsx`, `views/WorkFeature.tsx`,
`views/TicketInspector.tsx`, `views/work-continuity.css`,
`actions/ActionExplanation.tsx`, `actions/WorkActionsFeature.tsx`,
`progress/comment-timeline.ts`, `progress/ProgressReads.tsx` and
`progress/InlineComment.tsx` under `ui/frontend/src/`.

This pass was checked with focused model/controller tests and isolated native
browser interactions, including full board traversal, independent list expansion,
known-actor filters, populated dialogs, all inspector tabs, live external comments,
confirmed composer posting, retained disclosure/list state, and narrow/light
layouts. It remains subject to the user's page-by-page visual review and final
full-source qualification; do not infer acceptance from these checks.

## 11. Ticket refinement: open conversations and understandable tools

The follow-up walkthrough refined section 10. **Conversation messages should flow
on the page, not become cards inside a conversation card.** Keep the conversation
section itself unboxed. Put each avatar, author, message kind and timestamp above
the message body, outside its softly outlined rounded surface. Use subtle blue for
progress, green for decisions and orange for blockers. Reply and Edit/history sit
below the body as compact links. Keep a clear gap before the composer. Message
content still supports Markdown and code highlighting. Check long and short
messages, replies, empty conversations and light mode, not just one screenshot.

Linked discussions and ticket history follow the same open layout inside their
single disclosure: plain section headings, compact activity rows, attribution and
subtle separators. Do not put an enclosing card around every group and every row.
This is distinct from the **Links tab**, whose Child tickets, Related tickets and
Linked resources collections have intentional colored section headers, icons,
counts and explanations. Related links provide context without blocking readiness;
state that below the title rather than appending technical wording to the title.
Avoid duplicating related records in a second list of IDs.

Secondary tools use a consistent disclosure header: colored icon, clear title,
one-sentence purpose and visible chevron. The body explains any unfamiliar concept
before presenting controls. Handoff means a summary for the next worker; attempts
are recorded work sessions, not proof an agent is running; evidence supports a
completion claim. Acknowledging an instruction change is separate from merely
reading it. Keep these sections reversible and retain open state during updates.

Each inspector tab starts with a short explanation. Who can work is a two-step
flow: check dependencies or the selected actor/run, then explicitly start work.
Show the selected actor's avatar and identify missing run/capability context.
Checking eligibility is neither assignment nor reservation. Completion displays
named checks with explanations rather than bare schema keys, and still requires an
explicit completion operation. Details explains acceptance criteria and holds.

Actions use visible category tabs and descriptive choices rather than cascading
selects. Common shortcuts expose priority, assignment/labels, ticket editing,
hold/lift hold and a ticket-linked question. Priority uses named choices and opens
the existing guarded review; selecting it alone never changes the daemon. Put a
prepared action's review first and collapse the disabled input fields, rather than
making the user scroll through a large frozen form to find Apply. Asking opens an
unsent question draft in Discussions with the actual ticket/project attached. The
user still chooses the resolver, recipients and question text; no message is sent
merely by opening it.

Replace the toolbar's Open editor/Captured intention selects with **Drafts & saved
actions**. Its dialog explains browser-session retention and lists each draft's
ticket, author/avatar and state. Closing hides; explicit discard removes an unsent
draft; prepared operations retain their saved identities and recovery controls.
Do not silently switch a draft's author or scope when a user switches pages.
Message/work-update drafts remain accessible through the participation section.
Replies quote the original message when it has already been read for the draft's
exact endpoint and ticket. Keep the optional target ID under secondary controls.
Never fetch or quote content from another scope to fill that preview.

**Raw Workgraph metadata is not part of these normal ticket views.** Remove JSON
object viewers and fine-print capture/source dropdowns from ticket tabs, linked
history, evidence readouts, comment tools and action forms. Present meaningful
values and review outcomes instead. This is a presentation decision: keep internal
validation, counters, revision guards, saved request identities and partial/error
reporting. Do not hide uncertain-write recovery or claim that a partial read is
complete. Raw inspection can be revisited if users establish a need; it is not a
prerequisite for understanding or using this UI. This rule does not turn user-
authored code or JSON in a message into metadata; continue rendering that content.

Implementation additions: `views/InspectorParts.tsx`, `views/ticket-refinement.css`,
`actions/QuickTicketActions.tsx`, `actions/action-summaries.ts`,
`actions/ask-ticket.ts` and `progress/ReplyContext.tsx`. All changes remain subject
to the user's walkthrough and final qualification. Keep the older sections as
rationale, but use this later feedback where the presentation differs.

### Ticket entry and tab lifecycle

Every newly opened ticket starts on **Conversation**, including reopening the same
ticket after closing it, selecting another ticket directly, or opening a ticket
in a different workspace/project scope. A tab selected for one ticket must not
silently become the starting view for another. Conversation is the predictable
entry point for reading updates and contributing a comment.

Reset the tab at the controller's ticket-selection boundary, not in response to
data arrival or component rendering. Live updates, manual refreshes, and an
identical remount of an already open ticket preserve its selected tab. This is
the distinction between starting a new inspection and preserving the reader's
place during an existing inspection. Explicit actions such as reviewing completion
checks may still navigate to the relevant tab after the ticket is open.

Verify both sides: close/reopen and direct ticket switching return to Conversation;
refreshing while reading Links, Completion, Who can work or Details leaves that tab
selected. The controller regression lives in `tests/work/read.test.ts`.

### Human-readable linked content

Linked resource summaries use the resource's metadata title and filename rather
than generic labels such as "Entry 1". Display descriptions when supplied. Removing
a raw-object viewer must leave a useful summary, not force the user to infer what
an item represents. Keep human attribution and timestamps where useful; internal
revision and sequence counters do not need a permanent place in ordinary rows.
The board's snapshot-details disclosure is also removed; retain meaningful counts,
partial-read warnings and error/recovery controls without routine capture internals.

## 12. Workflow: one place to understand and build connected work

The Workflow page is one continuous workspace. Keep **Graph, Relationships,
Templates, Drafts and Execution evidence** visible in a shared header across all
five views. Switching to a template or a saved execution must not strand the user
on a different-looking page with no route back. On narrow screens the tab strip
scrolls horizontally; the active view has its own bounded scrolling region. Close
the ticket inspector when changing these views, while retaining unfinished drafts
under their original actor and endpoint. Do not duplicate the navigation inside
individual features.

### Graph presentation and interaction

Use the POC's compact, connected-work feel with the Overview palette: a subtle
dotted canvas, rounded nodes, bright readable titles, semantic status accents and
actor avatars. Real ticket cards are 104px high, with two lines for the title and
its full text available on hover. Boundary placeholders are 92px high. Show ticket
key, actual status and concise prerequisite/hold context. Status is not a claim of
readiness: a To Do ticket may still be blocked. An avatar represents the recorded
claim actor or assignee, not proof that an agent process is currently running.

Selecting a node highlights the entire connected component in the captured graph.
It does **not** open the inspector: that would obstruct the trace. Each node has a
separate visible Open action that opens the normal Conversation-first inspector.
Closing that inspector preserves the trace; Clear trace removes the highlight.
Keep graph trace state separate from inspected-ticket selection. Resolving a display
key centers/traces the resolved record rather than opening an obstructing sidebar. Trace across
prerequisite, parent/child and related links in both directions; handle cycles
without recursion or repeated visits. Dim unrelated nodes and emphasize connected
edges. This is a visual relationship trace, **not** a critical-path calculation.
All relation layers are initially visible. Hiding a layer changes presentation,
not dependency rules or the underlying connected-tree calculation. Existing
ancestor, downstream and subtree focus options remain available in Display.

Keep zoom controls immediately visible: minus/plus, a 25–200% slider, reset to
100%, Fit graph and Center selected ticket. Zooming must not unexpectedly recenter
the selected node; centering is an explicit action except when a new selection
needs to be brought into view. Keep keyboard selection, panning and relationship
ports available, with secondary ports appearing on hover/focus. Display and Add
relationship are spacious rounded dialogs with colored explanations, named
relationship types, clear endpoint choices and a plain-language proposal before
review. Retain the captured writer/scope and explicit hide versus discard choices.

Do not confuse a readable graph with a complete-workspace guarantee. The existing
projection limits (200 drawn nodes and 1,000 edges), scoped collection and any
partial results must remain visible when relevant. Fit respects the minimum zoom;
it cannot promise that an arbitrarily large graph will fit. Filtering and centering
are useful navigation aids; they do not alter stored relationships.

### Ticket and relationship consistency

Workflow reuses Work's ticket inspector and actions, including its Conversation
entry behavior. Review and evidence belongs in a **collapsed, explained disclosure
below the conversation/progress area**, not above the ticket's main content. Opening
a ticket should first help the reader understand the ticket and its discussion.
Reuse the ticket-linked Ask action; preparing it never sends a message.

The Relationships view shows readable ticket keys and titles, directional meaning
and clear edit actions. Explain prerequisite versus grouping versus informational
links. A related link does not block work. Retain review, cycle checking, revision
guards and recovery rather than letting a visual gesture silently commit changes.

### Templates and drafts: explain the work before the machinery

Introduce a template as a reusable blueprint for tickets, dependencies and review
rules. Show a simple three-step flow: **choose or author → review → apply**. Published
templates show task titles/counts and input names instead of a raw spec dump. An
instance draft prepares a new workflow; opening, editing or saving a draft does
not itself change workspace tickets. Authoring a template and publishing it are
separate steps. The demo includes a synthetic three-task feature-delivery template
so the walkthrough is not limited to empty states.

Explain a batch as a group of changes applied together, and that multiple batches
are independent: earlier successful batches remain applied if a later one fails.
Explain aliases, input parameters, dependencies, allowed actors, reviewers and
receipt bindings next to their fields. Use comfortable spacing, colored batch tabs,
clear editor titles and author avatars. Keep the human review near the action and
retain saved request identities/uncertain-write recovery. Editable plan/template
source is authored content and can remain under an advanced control; passive raw
metadata and frozen request dumps do not belong in the beginner flow.

State draft retention precisely. Navigation may hide an editor without changing its
captured writer. Explicitly closing/removing a local editor has different effects
from hiding it; explain export before removal and keep saved action recovery
available. Preserve the last same-scope template inventory during refresh instead
of flashing an empty list. Template inventory currently reloads on entry or its
Refresh action; this refinement does not add a separate live subscription.

### Execution evidence: visible purpose and honest outcomes

Explain a stage as a saved local execution folder, a capture as recorded output and
metadata, and publication as adding that evidence to Workgraph. The browser reads
saved command evidence; it does not execute the command merely by opening a stage.
An exit code is an observed result, not review approval. Show clear sections for the
saved capture, retained output and saved publications, with readable field labels,
comfortable spacing and explicit publication/cleanup actions. Preserve actual
output rendering, byte-range controls, source-coverage limitations and recovery.
Remove passive raw manifest, receipt and capture metadata dropdowns. Where exact
records are necessary, use labeled values and meaningful partial-result notices;
never imply a truncated read is complete.

### Implementation and verification scope

Shared styling lives in `features/workflow/workflow-continuity.css` and navigation
in `WorkflowFeature.tsx`. Graph model/controller/canvas own tracing, compact node
geometry and zoom behavior. Plans, local-evidence and evidence features retain
their existing typed controllers and guarded operations. The shared Work action
wrapper places workflow evidence below progress instead of creating a second ticket
layout.

For this design pass, verify focused graph/plan logic, type checking, lint and
formatting, then inspect the real preview in dark/light themes and at narrow widths.
Exercise all five tabs, selection, zoom, dialogs, template-to-draft navigation and
saved output. These focused checks support the walkthrough; they are not a new full
native/package qualification or a substitute for the user's visual approval.

### Follow-up walkthrough: a draft library, not a crowded control panel

A draft is a local plan of changes; a template is a reusable recipe. Do not assume
that knowing Workgraph's APIs makes this distinction or its UI obvious. Present
**Saved drafts** as a readable library with Open, Export and Remove on each entry,
plus author/avatar and storage status. Opening a draft replaces the library with a
focused full-width editor. **All saved drafts** deselects the editor and preserves
its saved data. Remove is explicit and confirms the draft's name, what local data
will disappear and the option to export first. It never deletes existing tickets,
published templates or Workgraph operation journals. Saved/uncertain actions need
an explanation that draft removal does not cancel, reverse or erase them. Prevent
removal during preparation and surface local-storage deletion failures.

Inside an editor, omit the large library introduction and creation toolbar. Show
its name, original writer, save status and a short next-step explanation. Keep
batch settings, receipt bindings, reorder controls, copy/restore tools and exact
source under descriptive disclosures. Show required and already configured fields;
put unused optional fields under More options. Template task rules for parentage,
capabilities, allowed actors and review get a separate disclosure. Closed sections
must preserve values and pending edits. An optional checkbox must have a visible
label; do not leave an orphan checkbox above an input.

Add a clearly discoverable, collapsible **worked-example guide** beside the forms.
Use three task-based paths: create a one-off plan, author a reusable Build → Review
template, and use a published template. Give the actual control names and concrete
values, explain local aliases ($build in transaction references versus build in a
template's Depends on list), input substitution, review, saving a proposed action
and explicit execution. Explain that Work → New ticket is simpler for one ticket.
A new one-off draft currently starts with one Create work operation and no hold;
users must declare its intended availability. Additional batches have their own
starter defaults, so never infer first-draft behavior from those helpers. Held intent
alone does not add a hold: a matching hold operation must be in the same batch.
Published templates create no tickets until instantiated. These distinctions must
remain correct as controls evolve; verify explanations against the implementation.

### Follow-up walkthrough: automatically resolve ancestor information

The old incomplete-ancestry count commonly meant parent policies had never been
loaded, not that the workspace had an excessively deep hierarchy. Automatically
follow missing parent records and read their policies, deduplicating shared parents
within the current capture. Do not impose a total ancestor depth or record-count
cutoff on this traversal. Read incrementally without flooding the daemon. Preserve
cancellation, cycle detection, partial-read honesty and exact workspace-revision
checks; current-only policy reads cannot be mixed into an older graph capture.

Use a plain status describing loading, successful coverage, or a real failure, with
an explicit retry where useful. Do not require clicking Capture policy dozens of
times. Scope changes abort/ignore obsolete traversal results. This change concerns
ancestry data, not the separate canvas rendering limits. Evidence includes 68 child
tickets sharing a 70-level off-view parent chain, deduplication, revision drift and
scope replacement, plus browser proof of automatic completion.

## 13. Discussions, requests, delivery and routing

The Discussions walkthrough follows the same Overview palette and the user's POC:
a compact collection on the left, a conversation on the right, visible authors
and timestamps, and enough color to distinguish questions, answers and status.
It is a refinement of all communication surfaces, not just the first thread view.
Keep the four section tabs visible throughout Discussions, Requests, Inbox and
Routing. Explain each section in one sentence below that navigation. Do not assume
that a new user knows how a thread, request, notification and direct message differ.

### Visual hierarchy and conversation flow

- Use 15px message bodies, 14px supporting instructions, 13px timestamps and
  controls, and 26px conversation headings. Metadata should remain readable.
- Use rounded 16–18px message surfaces and utility panels, and 22px editor dialogs.
  A message has one body surface with its avatar, author and time outside it. Do
  not put a second article card around that entire structure.
- Resolved answers use green outlines and labels, questions use pink labels,
  awaiting-response threads use gold, and open threads use blue. Include the
  actual status text; color alone is not sufficient. Light mode uses darker
  semantic colors with the same layout.
- Conversation lists show recognizable actor avatars beside participant names.
  Preserve full titles through wrapping instead of silently cutting off the
  question. Maintain compact row padding even as text becomes easier to read.
- Separate the reply composer from the preceding message with a deliberate gap.
  Show the original author, visible outcome, and a clear action. Live updates must
  preserve an unsent reply and any open disclosure.
- Message formatting/source controls are for the authored message itself. They
  are different from raw Workgraph record JSON, which is removed from ordinary
  discussion, request, notification, team, subscription and wait views. Preserve
  partial-result warnings, continuations, failed-read retries and exact saved-write
  recovery. A hidden JSON dump must never be the only explanation of a problem.

### Boards and the first conversation

A board groups threads. A thread contains a conversation. Describe both concepts
before expecting someone to create them. Create board is a visible action beside
New thread, including when no boards have been returned. Empty board and thread
collections have their own explanations; do not render a blank panel or imply that
an incomplete read establishes that nothing exists.

Opening a board shows its title, scope, purpose, Edit board and Start a thread in
this board. The collection shows its threads; starting there selects that board
in the editor. Check all three states: no boards, a board with no threads, and a
board with conversations. Use a separate synthetic project for this check so
existing demo conversations and actual development records remain untouched.

Thread shortcuts expose All threads, Unresolved and With me. With me filters by
the selected actor; it does not change the acting identity. The detailed filter
still supports board, participant, scope and status. Title search is applied by
submitting the field. Keep explicit pagination honest; do not relabel replacement
pages as an append operation unless the controller actually accumulates results.

### Editors explain effects before applying them

`ActionGuide.tsx` contains concise, typed explanations for every communication
operation. Each dialog starts with its effect and whether the next action merely
prepares a change or posts it. Examples:

- A new thread is initially an empty conversation. Create it, then post a message.
- Editing a board or thread changes settings while retaining messages and history.
- A request's designated resolver is allowed to answer/resolve it. Naming that
  actor does not itself send the question. Direct recipients control delivery.
- Accepting responsibility, acknowledging delivery, answering a request and
  acknowledging an Inbox queue are distinct operations. Explain the distinction
  near the relevant action instead of exposing implementation vocabulary.
- Cancel closes an open request and retains its history. Removing a comment leaves
  earlier versions available; completion evidence needs a correction reply.
- A team groups recipients. A subscription selects future notifications for one
  actor or run. Updating either does not rewrite past delivery recipients.

Dialogs have a visible original-author avatar, roomy inputs, and secondary settings
behind named disclosures. Review prepares and validates; Apply change performs the
saved write. Simple message posting retains its existing direct Post/Send behavior.
Keep draft and close retains the editor in the current application session; it is
not a promise of durable browser storage. Discard editor is a different action.
Saved-action inspection/recovery remains available, without passive raw JSON.

Board and thread IDs are generated once at explicit draft creation. The optional
identifier section allows an intentional override; do not regenerate on rerender
or retry. New Thread offers a board selector from the loaded directory and a manual
ID fallback, because that loaded directory can be filtered or paginated. Existing
board/thread editors start with the displayed values. Review still loads current
revision guards; prefilled data does not remove concurrency checks. Existing boards
retain their scope, and existing threads retain their board.

The question form has an explicit **Also notify the resolver** shortcut. It adds
that actor to recipients only when clicked and avoids duplicating an existing
recipient. Do not silently equate resolver, recipient and responsible party. Group
the destination separately; the selected project breadcrumb is not a substitute
for a board or linked ticket when the API defaults to the workspace board.

### Inbox and received-message actor selection

Both recipient inputs provide **Choose actor / Enter ID**. The dropdown displays
registered, non-archived actors across the selected workspace, with names and IDs.
It reuses the validated participant directory and follows every exact continuation;
a partial directory or revision change is reported rather than presented as a
complete list. The selector reloads when opened/focused, and failures leave manual
entry available. There is no hard-coded list of demo actors.

Changing input mode preserves the selected ID, including an ID absent from the
returned directory. Run recipients remain a separate kind with a typed run ID;
actor choices must not be mistaken for runs. Browsing another recipient never
changes the acting author. A saved-link recipient remains disabled. Directory
reads are scoped by connection generation, socket and workspace, cancelled on
scope change, and never filled from a newer connection when the link retains an
older generation. Do not narrow the actor directory to the current project.

### Routing, history and honest read state

Teams and subscriptions have clearly shaped sections, descriptions, readable
member/filter summaries and direct Edit actions. Do not require a redundant
Read button followed by finding an unrelated panel elsewhere. Only render a
selected-record detail disclosure when a record has actually been selected/read.
Show additional team members through a disclosure rather than silently omitting
them after a small avatar preview.

Conversation settings/history and message revisions are closable disclosures.
Questions linked to a conversation are secondary to its messages. Render their
loaded list only when its actual capture belongs to that thread and endpoint;
changing the requested filter alone is not enough to establish that the previous
response belongs to the new conversation.

Quiet refreshes retain existing results instead of adding a transient Loading
badge or paragraph. Real failures and incomplete reads remain visible. Direct
messages are received delivery records, not a guaranteed bidirectional chat
archive. Inbox reads never acknowledge automatically. Acknowledgement affects
its consumer/recipient queue, not all queues and not the request's resolution.

### Implementation and verification boundaries

The shared communication presentation lives in `discussion-continuity.css`, which
imports the existing threads and requests styles before its refinements. Keep that
ordering deterministic; importing the override independently before an older sheet
can silently restore smaller text or erase semantic answer borders.

This pass preserves native APIs and the controller-owned write/recovery lifecycle.
Evidence includes creating a board and thread from an empty project, messages from
two actors appearing live without replacing an unsent draft/open disclosure,
selecting and typing recipients in both delivery views, writer independence, run
separation, populated routing, narrow layouts and light/dark inspection. Focused
checks are not full native/package qualification. The user's visual walkthrough
remains the acceptance gate; a passing browser script does not approve the design.

### Workspace references should be discoverable inside the form

When an input points to an existing workspace record, provide a way to find that
record without leaving the form. Do not assume users have memorized actor, board,
ticket, project, resource or discussion IDs, or make them close a dialog to copy
an ID from another page. This is a general design rule for new work and future
page-by-page revisions, not a claim that every existing field has been migrated.

- Use a dropdown for manageable sets such as known workspace actors and discussion
  boards. Show human-readable names alongside stable IDs; names alone can collide.
- For tickets and other larger collections, offer search as the user types, with
  initial choices before searching. Match titles/names, IDs and display keys where
  available. Keep search text separate from the selected value.
- Retain explicit manual ID entry. Missing, archived or temporarily unavailable
  records must not erase a saved selection or force the user to abandon their form.
  Empty, loading, failed and no-match results need plain explanations and a retry.
- Read from the correct workspace and connection generation. Do not use a partial
  directory from an unrelated page as if it were the full set of available values.
  Follow validated continuations and keep incomplete results explicit. Searching,
  selecting and refreshing choices never submits or changes the acting identity.
- Distinguish **creating an ID** from **referencing an existing record**. Generated
  new-record IDs stay editable identifiers; they should not suggest replacing an
  existing record. A picker offers candidates, not permission or validity guarantees:
  normal review and daemon validation still apply when saving.
- Preserve all unsaved text, manual IDs and selections while browsing choices,
  refreshing, switching input modes or encountering a read failure. A retained
  editor keeps its original endpoint; switching workspaces must not silently
  substitute that new workspace's records into it.

Discussions now applies shared actor choices to request recipients, designated
resolvers, team members and subscription recipients. Ask a Question offers board,
searchable ticket and existing-discussion choices. New Thread uses a full board
directory and searchable linked tickets; direct messages offer a related-ticket
picker. Participant, mention and direct-message actor lists include an actor
chooser and an explicit Add button, alongside editable lists for pasted IDs. These controls are reusable for the remaining pages as they are reviewed.

Fresh Inbox entry defaults to the selected UI **actor**, even if a run is also
selected, and reads their notifications automatically. Manual recipient choices
remain stable while the view is open. Reopening it starts with the selected actor
again. Saved captured Inbox links keep their exact original recipient, consumer,
filters and boundaries. Reading an Inbox never acknowledges its notifications.

### Selection must look selected; write forms should explain one decision at a time

The first searchable reference implementation used a permanently visible native
listbox. It updated the value, but stayed open and gave weak feedback, so users
reasonably thought clicking a ticket or discussion did nothing. A programmatic
`selectOption` assertion did not reveal this usability failure.

Reference pickers now have an explicit closed selection display: a checkmark,
record title and stable ID. Clicking it opens an in-form search panel. Clicking a
result sets the field, closes that panel and returns focus to the selected-value
button. Reopening marks the chosen item. Clear is an explicit action; changing
search text never clears the saved choice. Enter ID remains available. Escape
closes only the chooser, and Arrow Down/Up plus Enter support keyboard selection.
The result list scrolls within the form, and long names and IDs wrap rather than
forcing the modal wider. No selection submits the parent form.

Verify this with actual result clicks, visible selected text and a closed panel,
not just the presence of a value in a native control. Cover shared uses in Ask a
Question, attached-comment requests, direct messages, thread board/linked-record
selection and subscriptions. Also check keyboard behavior, retained unsent text,
manual IDs, empty search results and narrow layouts.

Discussions write forms use the shared `FormSection` for flat, sibling sections:
content, people, destination and delivery/settings as appropriate. Each section
has a readable heading, a short explanation, a semantic colored icon and room for
its fields. Avoid nesting another bordered box around every recipient or input.
Recipient rows use spacing and dividers; actor lists show avatar chips with remove
actions, an explicit Add control, and a secondary Edit IDs disclosure for pasting.
Keep resolver authority distinct from notification recipients.

Optional mentions, links, closure rules and identifiers are separate, labeled
sibling disclosures. Do not put them all into one deeply nested catch-all panel.
Essential titles, message bodies and recipient controls remain visible. Technical
identifiers and update-existing modes remain accessible but do not lead the form.
Create/edit team, subscription, board and thread forms share these rules, as do
request resolution/metadata/responsibility and message/comment write actions.
Their original review, preparation, writer identity and retry behavior is unchanged.

### Conversation-list density and preview hierarchy

The collection sidebar defaults to 420px, can resize from 320 to 560px on desktop,
and retains the existing narrow-screen navigation. A compact row must not squeeze
all of its metadata into a single wrapping paragraph. Use a two-line title, a
separate status/message-count line, compact participant avatars, and a short
message excerpt. Reserve space for compact dates; expose the exact timestamp on
hover. Requests show their creation or terminal-action time with type and resolver
context. Do not describe that timestamp as the latest message time.

The native thread list does not contain message bodies or timestamps. Visible
thread rows use the existing validated thread adapter at the list's communication
revision. A one-message read captures the required discussion serial before a
nonzero offset fetches only the final message. Never guess that serial from the
thread metadata revision. Show the final message's author, recorded time and a
two-line plain-text excerpt. Offscreen rows do not start preview reads. Cancel
reads when rows leave their capture; errors keep the thread link usable and do
not fabricate a preview. Empty threads say No messages yet. Layout must stay
readable for long IDs, multiline titles and both themes, without shortening the
actual data or fetching an entire transcript just to show one preview.


### Shared page navigation and plain-language orientation

Work, Workflow and Discussions use `components/section-navigation.css`: the same
23px title with a colored icon, 14px tab labels, 11px rounded tab corners, 17px
icons, and violet selected state with a visible border. The title, navigation
and right-aligned primary actions belong to one consistent header. On narrow
screens navigation moves to a horizontally scrollable row. Do not wrap one page's
tabs in a different pill container or independently tune their spacing.

Discussions adds a compact orientation strip under that navigation. Use a colored
icon, a short bold purpose statement and a readable explanatory paragraph. Explain
what the user can do and introduce concepts such as actor, request, subscription
and acknowledgement before relying on those terms. Each tab gets its own purpose:
conversations, accountable questions, personal notifications, or future routing.
Routing is delivery configuration, not ticket permission configuration.

Inbox controls separate recipient choice, shortcuts, optional filters and read
actions into distinct rows. Align the recipient-kind and actor/ID input labels;
place Choose actor / Enter ID below the input, not above one field in an otherwise
aligned row. Show the current actor with an avatar. Keep advanced consumer and
interval settings in one explained disclosure, with a searchable ticket choice.
Read Inbox is the primary action; waiting is a secondary one-time read. Neither
implicitly acknowledges notifications. Keep these distinctions in the instructions.

### Preserve the collection while selecting its detail

Selecting a thread or request updates the reading pane and selected-row highlight.
It must not remount the sidebar, reset its width, lose its scroll position, reload
its collection from the first page or discard its filters. A detail ID is not a
collection identity. Retain the exact list capture, continuation, selectors and
active read slot when moving between details within the same collection. Cancel
and clear obsolete detail reads so a late reply cannot replace the new selection.
Preserved list slots must still support live refresh after selection changes.

Connection generation, workspace and project changes remain real scope changes:
reset their collections and reject late results. Changing board also changes the
collection. **All discussions deliberately clears the board filter**, including
when returning from a thread selected inside that board. Scroll preservation must
never turn an explicit return-to-all action into a stale filtered view.

Test actual clicks near the bottom of a populated list and then on neighboring
rows. Check unchanged sidebar DOM/scroll, selected highlight, retained filters,
correct detail, and continued live reads. Also test board → thread → All
discussions, narrow layouts and changing projects. Reserve preview height so
asynchronously arriving author/time/excerpt content does not jump neighboring rows.


Primary header actions must retain their own foreground/background pair. Scope
shared tab styles to the header's direct navigation toolbar; nested action toolbars
must not inherit muted tab text over a bright primary background. Work's New ticket
uses a deeper violet fill and white label. Its disabled state uses a subdued surface
and readable muted label, with the existing prerequisite tooltip. Check enabled,
hover and disabled appearances in both themes after changing shared header styles.

## 15. Participants: people, work records and coordination rules

Participants follows the same visual system as Work, Workflow and Discussions.
Its purpose is to make recorded work and coordination understandable, not to look
like a process monitor. This pass covers people/agents, the actor catalog, runs,
attempts, focused overview and limit views, allocation, reservations, outside
conditions, recovery records and their action dialogs. It remains subject to the
user's page-by-page visual review.

### Explain the model before presenting its controls

Use three levels of explanation, without repeating a large manual in each row:

- A short page description says what the selected collection is for.
- A rounded, lightly tinted introduction defines the concept and gives a practical
  example or the distinction most likely to surprise a beginner.
- The action form describes exactly what saving changes. Essential consequences
  remain visible; optional settings can collapse.

Define **actor** as a person or agent identity, **run** as one recorded working
session, and **attempt** as a run's work on a particular ticket claim. A person can
have several runs; a run can make several attempts. Registering a run does not
start an agent. Completing an attempt does not automatically complete its ticket.
Keep recorded states, observations, claimed ownership and actual process health
separate in labels and prose.

For coordination, introduce the terms before relying on them:

- A **pool** limits concurrent allocated tickets. It does not count processes or
  multiply slot use by the number of attempts on the same ticket.
- A ticket's **eligibility policy** names required capabilities, pools and optional
  allowed actors. Saving the policy replaces the complete set; it is not an
  additive patch. Other readiness rules still apply.
- **Logical paths** coordinate names in a worktree. They are not filesystem locks,
  glob expressions or proof that two physical directories are the same.
- A **reservation** records a resource holder. Exclusive/shared modes have visible
  labels. A timed lease does not silently release ownership when time passes.
- A **waiting note** and a **holder note** communicate intent. Neither creates a
  fairness guarantee, grants ownership or renews a lease.
- An **outside condition** declares a required external result. A **signal** pins
  evidence against its exact declaration. Workgraph records that evidence rather
  than performing or independently verifying the outside operation.
- **Recovery** needs attributed confirmation that the old owner stopped or was
  isolated. Expiry, quietness and cancellation requests are not substitutes.

### Navigation, views and empty states

Use the shared `wg-section-navigation` header with icons and readable tabs. Keep
People and runs, Allocation rules, Reservations, Outside conditions and Recovery
records accessible. The common Runs / People and agents / Attempts controls form
one secondary toolbar, with Views & filters and Record a change on the other side.

Views & filters uses named choices with short explanations instead of an opaque
select containing ten unfamiliar API concepts. Run limits and heartbeat require
a run; Actor overview requires an actor. If a required selection is missing, show
clear instructions and clear the obsolete collection. Never display records from
the previous view underneath the new heading after query preparation fails.

Be explicit about scope: most participant/coordination catalogs are workspace-wide,
even when a project appears in the breadcrumb. Only supported overview filters
should claim to narrow results to a project. Counts describe the loaded page and
must retain partial/continuation notices.

Condition signals are a subordinate view with their own heading and an explicit
Back to conditions action. Saved acquisition waits belong with Reservations, not
as an unexplained utility repeated under every coordination tab. Retained action
drafts remain accessible and keep their original scope and writer.

Empty states explain what belongs there and how to begin. An empty recovery list
is normal, not a prompt to manufacture a recovery. An empty attempt list should
point to recorded work and filters, not claim no agents are running.

### Forms and record presentation

Record a change is an action chooser grouped into People, Runs and observations,
and Ticket attempts. Each card has a descriptive title and effect statement.
Choosing a card opens the actual editor. Avoid an Action dropdown followed by an
unexplained Open form step.

Editors use a wide rounded modal, an actor avatar and captured-writer summary,
readable labels, approximately 20px field spacing and clear section headings.
Reset the base `.wg-field` margins inside grid-based editors: combining the old
block margins with grid gaps creates excessive blank space and needless scrolling.
Parent-run/external references in registration are optional and collapsible. Do
not hide the immutable-registration explanation or required ID/objective fields.

Lists of capabilities, pools, paths and proof pins use flat sibling sections with
light dividers. Nested proof records may use a single slim left rule; avoid several
boxes inside boxes. Add/remove controls belong next to the list they affect. An
empty proof list explains how to attach evidence and that removing a draft pin
does not delete its source record.

Reuse workspace choices for actors, tickets, runs, attempts, pool names and named
reservations. Allow manual entry, including new names where creation is allowed.
A selected reference must be visibly retained and its menu must close after a
mouse or keyboard selection. Lookup does not grant permission, replace the writer
or change a retained action's destination. Exact evidence versions/digests remain
explicit; choosing an identity must not silently replace a pin with its latest
version.

Run tables use avatars, readable objectives, observation times and status pills
with icons and words. Actor kinds and catalog archival state remain distinct.
Reservation holders and recovery authors also get avatars. Path records show the
actual declared paths, worktree and mode, not just a count. Run detail includes
parent behavior, external references, outcome evidence and associated sessions;
attempt detail explains checkpoints and the distinction from ticket completion.

Remove passive raw record/page/metadata JSON disclosures. Keep human-readable
signal details, proof pins, captures and wait outcomes when they explain the work.
Use the shared management presentation for action review: visible changed values,
original destination, Apply change, actual outcome, inspection and exact-retry
controls. Hiding debug JSON must not hide uncertainty or remove recovery controls.
Closing retains a draft; Discard removes an unsent draft; Apply sends the reviewed
change. Explain these three different effects in the editor.

### Styling and verification notes

`participants-continuity.css` is imported after the feature base styles in
`application.tsx`. This order is deliberate: the runs and coordination trees had
separate older styles, and importing the refinement from the first tree let the
second tree override its typography, spacing and corner radii. Check computed
styles and screenshots in both subtrees rather than assuming a shared class won.
Modal colors are scoped through their content markers so a portal does not lose
the Participants palette. Both run and attempt detail use the same marker.

Review populated and empty collections, the ten alternate participant views,
all authoring forms and conditional evidence/lease settings. Include actual
reference selection, clear missing-selector feedback, close/reopen and discard,
condition-to-signals-to-condition navigation, light/dark themes and narrow layouts.
Use an isolated real daemon for representative reviewed writes; UI appearance
alone cannot establish that a new form sends the intended values. Keep the existing
immutable captures, native guards, live-read controllers and uncertain-write
handling intact. A focused design pass is not full package/release qualification.

## 16. History: conversations, session navigation and usage

### The user’s intended reading experience

History is a generic event store, but recognized conversation data should read like
an actual chat. Keep the readable conversation in the foreground: user and
assistant identities, source time where present, Markdown, code, and clearly
separate tools and recorded reasoning. Do not surround every paragraph with nested
panels or make the user choose one content block at a time. Render all retained
blocks in their original order. A single message may contain text, a tool call,
more text, and a reasoning summary; all are part of that message.

The important ingestion case is **one conversation item per Workgraph history
event**. An OpenAI Responses input/output item or an Anthropic message does not
need to be wrapped in a whole API request/response just to render. Full envelopes
remain supported for callers that actually store them. Common `{role, content}`
shapes are labeled as conversation items, not proof of a particular provider.
Never infer provider identity from a model-looking string, actor name or ID prefix.

### Conversation presentation

- Assistant prose flows directly in the transcript. User messages get a restrained
  tinted surface, rounded corners and their own avatar. Use readable 15px body
  copy, comfortable line height and visible separation between turns.
- Tool calls use amber icons and compact expandable headers naming the tool.
  Tool results have a distinct success/error treatment; a tool result inside an
  Anthropic `user` message is still a tool result, not a human chat bubble.
- Retained reasoning and saved summaries use a violet disclosure. Encrypted,
  signed or redacted fields stay opaque. Never manufacture or recover missing
  reasoning. Empty/unknown blocks stay visibly accounted for.
- The shared content viewer has `message` chrome for already interpreted text.
  Successful rendering omits duplicate per-paragraph source controls. Its
  containing event must provide original source/download access; rendering errors
  still expose recovery and byte controls. Markdown/code remain passive, with no
  automatic external image fetch or executable tool invocation.
- Consolidate event internals under a small **{ }** button beside its timestamp and event number.
  Keep original bytes, continuations, integrity checks and exact capture links.
  Indexed search text is not a second chat message. Ordinary conversation view
  does not need a searchable-text disclosure on every turn. Real attachments and
  the explicit raw-events presentation remain accessible.

### Schemas and truthful fallbacks

Claude Code disk JSONL, Claude Agent SDK messages, Anthropic Messages, OpenAI
Responses, Chat Completions and Codex rollout JSONL are different shapes. Validate
the fields actually consumed by each adapter. The Claude Code reader evidence is
the published Agent SDK 0.3.319 source plus its session API documentation; it is
not a claim that every historical Claude Code file conforms to a stable public
JSON Schema. Its disk records use `sessionId`, `uuid`, `parentUuid`, `timestamp`
and nested `message`; SDK records instead use their own wrappers. Preserve branch
metadata and disclose side chains. This UI does not reconstruct a canonical branch
through compaction or flatten subagent conversations automatically.

Codex support combines the original pinned source definitions with observed local
rollout variants. Local logs include custom tool calls/results, agent messages,
turn settings and per-response token-usage records. `token_usage_record.usage`
is per response; `thread_token_usage`, `turn_token_usage` and `event_msg.token_count`
can overlap it and must not be added to it. Known metadata-only events remain
compact markers; unknown variants keep their original content. See the format
module README for current coverage and evidence links.

Partial/unsupported data is a real state. Auto-detection works per complete
captured payload, with the existing worker/parser bounds. It does not certify the
whole upstream schema or the completeness of the source session. Manual format
selection must not turn malformed data into a recognized message. Generic and raw
views remain available, including arbitrary non-agent histories.

### Navigation, loading and controls

Use the same colored section header as Workflow, Work and Discussions. Keep
Sessions, Search, Usage reports and Session summary available throughout. Explain
what each is for, including that Session summary describes loaded events rather
than claiming a complete-session AI recap.

The session sidebar shows a readable title, actor avatar, open/archived state and
recorded activity time. Its DOM and scroll position survive opening a session in
the same workspace. Directory continuation appends to the captured list; it does
not replace the first page. Its head must stay pinned across pages. Session-local
selection and raw/conversation mode reset when switching to a different session,
without remounting the directory.

Preserve successful projections while live refresh checks unchanged immutable
events. Do not temporarily turn already rendered messages back into generic JSON.
Quiet refresh retains previous confirmed data. Normal session entry starts at
event 1 with up to **60 events**, not a window at the end. **Load 60 more events**
appends beneath the existing transcript; **Load all** drains the captured bound
and has a Stop loading control. Exact event links from search still open their
specific captured event. Keep original sequence order, never timestamp-sort.

Do not expose individual “not loaded” placeholders or big loading panels inside
messages. Stage each event page, its complete verified message bodies and format projections
before publishing the page. Disable continuation until that work finishes; an
interrupted load retains the prior complete page. Do not briefly mount generic
custom renderers before format recognition: doing so wastes processing capacity.

Bottom-follow is a reading choice, not a response to every layout change. A user
scrolling to the loaded end can follow appended events. Scrolling upward, opening
a tool/result or JSON detail, or using a control pauses following. Expanding a
large block must not trigger an auto-scroll/resize feedback loop. Preserve mounted
messages, disclosures and scroll positions across refresh. Stable content identities
include scalar rendering hints; constructing an equivalent hints object on each
render must not restart the renderer. Successful content stays visible when it
leaves and reenters the viewport. Keep source timestamps distinct from Workgraph
receipt timestamps.

Open means history can accept events, not that an agent is alive. Archived means
retained and readable with further appends disabled. No delete/reopen action is
invented. Explain this in directory filters and archive confirmation.

Session actions use a spacious dialog with separate create/import/archive cards,
icons, concise explanations and clear outcomes. Their editors use flat form
sections and captured-writer identity. Hiding retains the draft; Discard removes
an unsent draft; Review prepares it; Apply sends the reviewed operation. Existing
uncertain-write inspection/retry is preserved. Import currently accepts Workgraph
event inputs, not arbitrary provider files. Existing session/run/attempt fields
use workspace reference choices and still allow exact typed IDs.

### Usage and cost: the accepted attribution rule

Use existing **run/attempt usage reports**. Do not add a parallel session-fact
accounting store. Native `usage.aggregate` with `group_by: run` and nested metrics
folds run and attempt reports into one row per run. Complete all guarded aggregate
pages before presenting workspace totals. Native `run.sessions.total`, including
explicit links and automatic history links at the requested head, determines
association count; the currently visible directory page is not evidence that a
run has only one session.

- One associated session: display that session’s title and the run’s usage, clearly
  labeled **Sole session · run-reported usage**. This is attribution, not proof that
  every billed request was captured in that transcript.
- Multiple sessions: display one **Shared by N sessions · counted once** row. Do
  not copy the full run total onto each session or divide it arbitrarily.
- No associated session: keep the run visible, labeled accordingly. Missing usage
  or cost is unknown, never a fabricated zero.

The dashboard uses explicit standard metric name/unit pairs documented in
`history-usage.md`: input/output/cache tokens and reported or estimated micro-USD.
Arbitrary custom measures have no inferred currency semantics. Metric sample
coverage matters: values from only some reports are labeled partial. Saturation
is not an exact total. Reported and estimated costs may be combined only as
non-overlapping report samples, and the estimate label remains visible.

Cost calculation uses caller-supplied, recorded rates with exact integer
arithmetic. No hardcoded model price catalog or automatic price fetch is required.
The report editor calculator covers ordinary input, cached input and output;
separate cache-write/context/media rates and other charges need external
calculation. It updates an unsent draft and its price provenance, not the daemon.
Cached input is included in total input; reasoning is included in output. Never
bill either twice. Subscription utilization and API-equivalent cost are different;
show estimates as estimates, not verified invoices.

### Review and demo evidence

Use actual local conversation excerpts only in the private, disposable demo and
label their omissions. The 320-event Codex example is from this Workgraph UI
conversation; it omits internal prompts, hidden reasoning, images and oversized
records and anonymizes local paths. It is not a complete original log. Keep source
files, request journals and screenshots under ignored scratch. Use explicitly
synthetic fixtures for publicly committed regression tests and other provider
examples. Real token counts and illustrative demo prices must be distinguished.

Review long and short conversations, every block within a message, tools/results,
retained reasoning, unknown content, raw download, earlier/later windows, sidebar
continuity, archived sessions, every action editor, search, usage, light/dark themes
and narrow layouts. Focused browser checks and the stable preview are design
feedback evidence; they do not imply full current-root native or release
qualification. User visual acceptance remains a separate gate.

### Session POC refinements and many-to-many accounting

The six session POC screenshots supplied on 2026-11-09 demonstrate a transcript-first
layout: compact tool headers, readable messages, quiet reasoning markers, a small
JSON affordance and related work above the conversation. Match that hierarchy;
do not add metadata boxes to each message. Render all the individual blocks in
source order. Unknown text defaults to Markdown; explicit retained language/MIME/
filename hints and known command/file-input shapes choose code highlighting.
Tool strings are never executed or treated as instructions.

The JSON button displays indented, highlighted JSON while preserving exact number
lexemes and field ordering. Original byte copy/download remains separate from the
formatted display. Partial or invalid JSON is never presented as a complete parsed
object. A custom rendering rule is optional and must not interfere with the default
formatted source path or cause eager background work for every hidden message.

Session headers show the recorded actor and lifecycle, token input/output and cost,
linked scopes, all associated runs and attempted tickets. A ticket discovered
through a run rather than an explicit session/attempt reference is labeled “via run.”
Resolve full guarded association pages; a truncated preview cannot prove absence.
Do not claim a run is an active process merely because its recorded state is running.

Association is **many-to-many**: a session can contain several runs, and a run can
span several sessions. For a session, sum each distinct associated run once. If all
those runs belong exclusively to this session, label it Session cost. If any are
shared, label it Associated run cost and explain the shared component; it is not an
exact per-session allocation. Workspace totals always count each run once and must
never sum displayed session totals. No report is created merely by viewing history.

Do not combine estimated and reported currency metric families within the same run
unless their underlying report identities prove they do not overlap. Aggregate
sample counts alone cannot establish that. The dashboard conservatively shows
unknown cost for mixed families; the original metrics remain in Usage reports.

### Final History pass: grouped tools and beginner orientation

Treat one tool invocation as one visual operation. In Conversation mode, place the
input and its uniquely matched result in the same rounded card, at the call's
position. Use a colored tool icon, tool name, readable input and an expandable
result beneath a quiet divider. Keep result event number and its own small JSON
button; both original payloads remain accessible. A call can sit between prose
blocks, and a result event can contain other messages: hide only the matched
result block, never the entire mixed event. Raw mode preserves every event in
original order. Exact links to a result retain that result in place.

Pair by a unique recorded source call ID within the same workspace session,
adapter, source-session/agent identity and recorded run. Reject conflicting explicit
correlations, reversed results and duplicate IDs. Sidechains without a usable
source agent identity stay separate. Known conversation schemas can pair without
an importer inventing a Workgraph correlation; unknown formats require it. Missing
or ambiguous results are described as not matched in the loaded events, not as a
running, failed or successful tool. Grouping is a display choice, not branch
reconstruction or a claim that an incomplete import is complete.

Specialize tool inputs from observed schemas. Codex `exec`/`functions.exec` uses
JavaScript; Claude Code Bash and Codex shell-command inputs use Bash. File writes
use their recorded filename; edits show Before and After; Read shows the file path.
Patches use diff highlighting. Function argument JSON may be decoded for display
with the bounded lossless parser; this does not rewrite the original string or
execute any tool. Unknown inputs remain readable text or formatted JSON.

Codex output text blocks can contain JSON strings or several complete JSON documents
concatenated by the tool harness. Recognize only a completely valid structured
stream; malformed, partial or mixed prose stays unchanged. Preserve number lexemes.
For a known command-output envelope, display its output and recorded exit status,
with other execution fields in a disclosure. JSON inside that output is formatted
again for reading. Do not assume every JSON-shaped output is a shell result.

An ordinary session must not auto-select the final event or draw an outline around
its whole message. Tool/result disclosure state and reading position survive
refresh. The group adds no new follow-on-scroll trigger. Input code remains readable
at approximately 13px with a bounded scroll area for long scripts; messages keep
the normal prose scale. No JavaScript, shell script or embedded markup is executed.

Keep one History tab bar. Search, Usage reports and Session summary do not need a
second row of duplicate navigation buttons. Explain each task before its inputs,
show advanced retrieval controls in disclosures, and give empty states a next
step. Search explains that only supplied indexed text is searchable. Usage reports
separate comparing totals, browsing measurements and recording a new measurement.
Use familiar token/cost names and formatted numbers while retaining exact source
names and values in titles. Do not auto-expand repeated run-attribution totals or
show raw aggregate JSON as another ordinary-user option.

Session summary leads with loaded events, events at the snapshot, events with
measurements and lifecycle. Explain that source metrics may be cumulative, are not
summed, and differ from saved Workgraph usage reports. With no selected session,
provide a Choose a session button. Session actions and Report usage explain when
an acting actor must be selected, rather than letting an unexplained write button
lead to a validation error. Create makes an empty collection; import appends
prepared Workgraph event inputs; archive permanently closes appends and preserves
reading. Hiding retains an editor, Discard removes its unsent draft, and neither
saves anything. Import instructions explicitly distinguish display adapters from
JSONL-file conversion.


### Complete bodies before recognizing or pairing conversation events

A payload prefix is transport progress, not a usable conversation message. Fetch
continuations automatically for each ordinary event before format detection and
publication. In particular, JSON tool outputs must be complete before their call
IDs can be trusted and paired. The initial 32 KiB batch prefix is an optimization,
not the message preview limit. Fetch remaining bytes at the same captured head,
validate offsets and blob identity, reject stalled reads, and verify the complete
SHA-256 digest. Cancellation or failure must not publish a truncated replacement.

The automatic event preview and format worker share a **16 MiB per-event** ceiling
(the same byte ceiling as an inline append batch). Keep complete loaded bodies
while browsing a transcript; opening another source or attachment must not evict
large messages and undo their tool/result pairing. Events larger than the preview
ceiling show an explicit download explanation instead of attempting to render
partial JSON as a message. Explicit source inspection can still show loaded bytes,
clearly marked as incomplete. Full verified download remains a separate action.
A result whose call genuinely is not among the loaded events remains unpaired;
never guess a match to make the transcript look complete.

## 17. Resources: a readable library with understandable file management

Treat Resources as the place to keep documents, research, code, files and evidence
connected to work. Explain this before introducing transfer or version concepts.
Use the same readable typography, rounded cards, colored icons, subtle borders and
restrained primary buttons as Overview and the other redesigned pages. File-kind
badges, author avatars, publication state and timestamps make the library useful
without opening each item. Do not make raw metadata JSON a normal management view.
The actual contents of a JSON resource are user content and must remain readable.

Keep a library beside a spacious reader, each with its own working scroll area.
On narrow screens, show one at a time and provide an explicit route back to the
library. Labels must state retrieval limits truthfully: the current text filter
searches the loaded page, not every resource in the workspace. Include archived is
an explicit choice. Empty states explain how to create a document or upload a file;
no results and failed reads must remain distinguishable. Preserve live refresh,
selection and the user's reading position instead of replacing the entire reader.

The reader leads with title, description when present, author, time and current
content version. Separate Preview, History, and Details & actions. Group management
into About this resource, Connected work, and Content availability. Use readable
properties and link chips rather than raw API objects. History rows show version,
filename, size, actor and time. Opening an earlier version pins that content; show
a clear Return to latest version action. Prevent a pinned old preview from becoming
an accidental replacement of the current document.

### Forms, links and retained editors

Use spacious dialogs with named, colored sections and short explanations of the
result of saving. New document separates identification from writing; metadata
editing explicitly selects which fields will change. Explain resource IDs, filenames
and content types instead of assuming familiarity. Keep field labels visible.
Document editing reports its UTF-8 byte count and current 64 KiB write limit; larger
files use Upload file. These are existing transport contracts, not new visual caps.

Association inputs offer known workspace tickets, projects, milestones and resources
with human-readable labels and manual-ID fallback. Fetch complete choice lists at
one captured revision; reject incomplete, repeated, stalled or changing captures.
Changing the association kind clears the previous identifier. Removing a link removes
that association only. Archive hides the resource from ordinary listings while
preserving content and history; Restore makes it visible again. Neither deletes the
file. Present these meanings beside the actions, not as unexplained jargon.

Closing an editor retains its unsent draft. An Unfinished editors disclosure offers
named Resume and Discard actions and makes clear that discarding is not deleting a
saved resource. Editors retain their captured actor, workspace and revision even if
the surrounding UI changes. Human-readable operation review stays available; hiding
raw diagnostic JSON must not weaken revision guards or uncertain-write recovery.

### Versions, rendering and file transfers

Comparison is a read-only disclosure: the file being read stays on the left; the
user chooses a saved version for the right. Offer a fetched version selector and
manual number fallback, with recoverable loading failures. Preserve exact numeric
values in JSON and verified file identities. Explain JSON navigation, text comparison,
image presentation and original-file access in ordinary language. Do not confuse
loaded previews with complete verified downloads.

Explain upload as three explicit steps: choose and stage a complete local file,
prepare its saved operation, then publish. File selection and preparing never publish
by themselves. Show the captured writer, workspace, file size, stage progress and
plain-language transfer status. Publishing a replacement preserves earlier versions.
The current upload ceiling is 64 MiB; state it before file selection.

Saved transfers and temporary files are secondary management, separated from the
main form. Explain that this inventory belongs to the connected local service and
can include work from other workspaces. Transfer details can be closed. While a
selected running transfer is visible, read its status automatically using cancelled,
non-overlapping polling. Never auto-retry or repeat the publish command. An observation
must not steal selection from a later user action or publish after unmount. Preserve
monotonic job revisions and distinguish publication from its optional ticket link.
Checking completion reads the outcome; retry uses the exact saved operation. Removing
an unprepared temporary file frees staging storage, not a published resource.

Qualification for this pass includes real-daemon document creation, retained draft
resume, association selection, comparison, archive, staged file publication and live
transfer completion. Keep visual acceptance with the user separate from these checks.

JSON expansion must preserve reading position. Keep the previously rendered tree
mounted while its worker computes the next expansion, retain the current row page,
and key addressable rows by stable JSON pointer (including duplicate occurrence).
Do not temporarily replace a tall tree with a loading sentence: that shrinks the
scroll area and jumps the reader to the top. Mark the tree busy and briefly disable
its navigation controls instead. Verify expand and collapse well below the fold,
including that the clicked field remains at the same visible position.

## 18. Saved views: teach the task before exposing configuration details

Saved views need more guidance than ordinary browsing pages. Introduce a view as
a reusable selection and layout of records, with examples such as a project ticket
table, status board or research resource list. It does not copy or mutate those
records. Keep Library, Builder and Results as distinct, retained tabs with the same
colored icon navigation as Workflow and Discussions. Give each tab a short purpose
statement. Avoid repeating a large hero explanation above the getting-started card.

The library explains three steps: choose records, arrange them, save and open.
Keep a small optional glossary defining view, renderer, private library, shared
catalog and preferred selection. A renderer is an optional passive display recipe
for a value, not a query, agent runtime or executable plugin. Private storage belongs
to this local UI service and its connection/workspace; it is not an actor security
boundary. Preferred selection is remembered but does not automatically activate a
query. Explain export and removal effects beside the library: they affect settings,
not the records being displayed. Show useful no-match and empty-library states.

### Building a first view

Arrange the ordinary form in order: name and layout, scope, columns/cards. Follow
with optional filters, ordering/grouping and advanced renderer configuration.
Explain fields immediately beside their controls, including ID versus display name,
source, layout, scope, filter mode, operator, value type, sort direction, grouping,
column ID/label, known field versus JSON path, formatting and optional width.
Describe JSON paths with concrete examples such as /summary and /items/0. Keep
exact field values internally; friendly option labels must not change API semantics.

Offer an explicit **Use suggested setup** action for each of the eight data sources.
It replaces draft columns, filters, sorting, grouping and layout with a compatible
simple table, keeps the configuration identity/name, and uses Workspace only if the
existing scope is unsupported. Explain that effect before the action. Merely changing
a source does not erase the user's settings. Preserve unknown fields during edits;
such unsupported fields remain subject to validation and must not become silently
accepted by a preset. For an ordinary first ticket view, the generated configuration
already works without advanced fields.

Use workspace-backed choices for scope IDs and supported record/actor references
in filters and renderer pins. Keep manual entry. Suggestions belong to the draft's
captured endpoint and workspace; navigating cannot retarget it. Changing scope kind
clears the old ID. Be precise about scope: resource and fact views are not recursive
inventories of every project, and resource views list links at the selected scope.

Explain **Save privately**, **Activate view** and **Discard draft** separately.
Saving keeps a configuration; activation reads data and opens Results even before a
save; discarding removes unsaved edits. Switching tabs retains the draft. Existing
results stay on their activated definition while the builder changes. Keep revision
recovery in an explained advanced section below the ordinary form, with uncertain
save/conflict actions still available. Configuration source editing remains a legitimate
advanced authoring tool; raw backend reply dumps are not ordinary result controls.

### Results, sharing, imports and renderer previews

Use the same rounded panels, readable 14–15px explanations, colored headings and
spacious forms as Overview. Check table/list/board/timeline presentation, empty and
partial results, as well as light and narrow layouts. Explain what a fresh query
replaces and what Load more results adds. Counts describe loaded records. Collection
traversal, missing fields and unavailable value reads are distinct limitations;
simplifying their language must not imply global counts or complete data. Retain
existing live-read ownership and cancellation rather than adding a competing poller.

Sharing is an advanced, explained task: a configuration resource stores the recipe,
a catalog resource lists shared configurations, an index fact points to that catalog,
and a resource link associates it with work. Provide example IDs and explain each
scope. Review precedes explicit application. Opening a shared entry creates a draft;
it does not activate or publish automatically. Explain actor selection when required.

Import instructs users to paste an exported settings file, review it, map supported
views to local scopes, confirm each mapping and save privately. State that an existing
configuration ID will be replaced while other local configurations remain. Show
validation/save feedback inside the import dialog. Changing pasted input invalidates
the displayed review, and a failed review must never expose a previous import as if
it described the new text. Save stays disabled until required view mappings are
confirmed. Closing and reopening the dialog retains its text.

Saved targets are explained as local libraries for connection/workspace locations;
inspecting them does not reconnect a daemon or transfer a draft. Renderer creation
explains match conditions, presentation choices and JSON paths before asking for
inputs. Offer an explicit sample-data preview that does not publish. All renderers
remain passive and preserve generic fallback when the content is incompatible.

## 19. Facts: small shared knowledge with understandable, reviewed changes

Facts uses the Overview typography, local dark/light color tokens, rounded enclosing
surfaces and spacious forms. The directory and selected value keep their existing
independent scroll owners. The new treatment covers the library, structured and
JSON value presentations, scope/filters, exact-key creation, references, history,
restore, retained drafts, editing, deletion and conflict comparison.

### Teach the model and make records discoverable

- Explain a fact as a small shared value under a reusable name (its **key**).
  Give ordinary examples such as `release.ready` and `review.summary`. Explain when
  Resources, Discussions or Tickets are more appropriate. The introductory card
  appears with no selection and is always reachable through **About facts**,
  including on narrow screens.
- A scope is where a fact belongs: workspace, project, milestone or ticket. Facts
  do not inherit values or recursively include child scopes. The same key may
  mean different values in different scopes. Keep this distinction visible in
  the scope picker and creation form, not only in advanced help.
- Keep a compact, readable directory: clear key, type and revision, actor avatar,
  linked-record count, available size and a visible selected state. Show how many
  keys are loaded and how many remain. Directory text filtering only examines
  the loaded page; explain that a prefix filter searches the scope. A local
  no-match result needs its own useful explanation, not an unexplained blank list.
- Workspace record IDs use the shared searchable reference picker with manual
  entry available: scope selection, reverse-reference search and draft links.
  Selecting a different kind clears the old ID. Suggestions remain tied to the
  draft's original endpoint generation, socket and workspace. Never move a draft
  to the currently visible target just to make its picker work.

### Read values and history without a diagnostic interface

- The selected fact has a rounded document surface with a distinct heading,
  scope, revision/type, actor avatar, timestamp and ordinary actions. Keep disabled
  write actions understandable: selecting an acting actor is required to author.
- Objects display named fields; nested objects and arrays expand in place. Text
  remains readable, exact numeric spellings remain intact, boolean values have a
  recognizable color, and null is visibly distinct. JSON is a legitimate value
  presentation here, not an excuse to expose a backend envelope or connection
  debug metadata. Removed the former exact-attribution/capture disclosure.
- Preserve missing, null and deleted states. Missing means no recorded key in
  that scope; null is a stored value; deletion retains the key's prior history.
  Do not relabel null as absent or render a deleted value as an empty object.
- History uses readable author/time/version rows with expandable values. Explain
  oldest-first traversal, opening an earlier version, and restoration: restoring
  makes a new reviewed draft; it does not erase intervening history. Keep previous
  and next history controls and exact revision navigation.
- Related tickets and resources explain current links versus frozen resource
  versions. Reverse lookup searches explicit links in the current scope, not
  arbitrary text mentions. Removing a link never deletes its destination.

### Forms should explain effects, not expose protocol terminology

- Put **Where to look** and **Narrow the current scope** in separate colored cards.
  Browsing a scope and applying filters are distinct actions. Match exact key
  prefixes with an example; put field-value predicates behind an explained
  advanced disclosure. Explain JSON pointers, quoted text, all-conditions-match,
  absent versus null, and exact numeric spelling without implying a query language.
- Separate a full-width creation key field from its action row. Inspect only
  reads; Edit or create opens a draft. No change is saved merely by opening the
  form. Empty keys and missing scope IDs should not offer an actionable submit.
- Editing has two stages: **Set the value**, then **Add context (optional)**.
  Explain whole-value replacement, the 4096-byte value limit and the alternative
  of storing larger material as a resource. Use everyday type labels (text,
  named fields, ordered list, true/false) alongside their JSON type names.
  Field locations are readable names, not unexplained `$` pointer syntax.
- Changing a value's type replaces that node with an empty value of the new type;
  say so at the control. Null stores an intentionally empty value and is never a
  delete action. JSON source remains an explicit authoring mode, with examples,
  invalid-source retention and exact-number handling preserved.
- A draft identifies its original author and scope. Explain that Review validates
  and prepares; applying the reviewed saved action performs the mutation. Keep
  uncertain-write recovery and exact retry behavior in the existing controller.
  The shared management presentation suppresses raw diagnostic clutter without
  removing review/recovery controls.
- Closing an editor hides but retains its draft in this UI session; it is not a
  promise of cross-reload persistence. The draft library shows the key, location,
  author and understandable phase. Unsent drafts can be discarded from the editor.
- Delete explains that the key leaves the ordinary list but history and references
  survive. **Include deleted keys** makes it discoverable again. Restore and edit
  still require review and explicit application.
- Conflict comparison is a collapsible secondary task with three named columns:
  originally saved value, your draft and latest saved value. Reading current data
  must not alter the draft. Creating a new draft against that version keeps the
  user's local value and demands another review; it is not an automatic merge.

### Implementation and checks

`features/knowledge/facts/FactDesign.tsx` owns the task guidance, presentation
sections and endpoint-bound reference wrapper. `FactsFeature.tsx` composes them;
`ValueEditor.tsx` preserves the lossless editing pipeline and adds field guidance;
`FactStructure.tsx` provides passive expandable values. `facts.css` owns scoped
visual tokens and responsive layout. No daemon/schema/storage behavior changes.

Use focused native browser flows for creation, reference selection, retained
editing, exact numbers, deletion/restoration, filters, empty scopes, dialogs and
narrow layouts. Preserve the existing component regression for typing focus,
invalid values and stale encoding. Changing scopes intentionally cancels the old
scope's change subscription; test diagnostics should recognize that exact owned
cancellation, not suppress unrelated network failures. This is a design-pass
qualification, not the final release gate or the user's visual acceptance.

## 20. Activity: a readable history of the work

Activity should answer **who changed what, when, and where can I follow it?**
It is a chronological record, not another task dashboard or a raw protocol log.
Use the same bright text, rounded panels and colored identity cues as Overview.

### Feed and recorded details

- Use one rounded timeline surface with day headings and lightly separated,
  free-flowing rows. Keep avatars, the contributor’s name and the affected item
  prominent. Supporting excerpts must remain readable; they are useful context,
  not disposable fine print. Clamp previews and reveal the full recorded text
  in Details rather than letting a single long comment dominate the feed.
- Show a local clock time on every row and a complete date/time in expanded
  details. Preserve the original timestamp in the time tooltip. Never manufacture
  a time for malformed or unavailable data.
- Category labels pair color with an icon and text: blue tickets, purple projects
  and resources, pink conversations, green facts and participants, orange
  handoffs/recovery. Category color does not imply a ticket’s status or that an
  agent is currently online.
- Put the lightweight **Details** disclosure beside the category underneath the
  excerpt. Do not hide it at the far edge, fade it until hover, or give it a
  prominent button background. It must remain obvious and keyboard accessible.
- Expanded details list every change in that saved operation, followed by
  contributor, recorded time and optional run. Replace raw audit JSON with these
  readable summaries. Retained resource metadata provides its title/ID; retained
  fact changes provide their key and distinguish deletion from an update.
- Be accurate about history. A ticket snapshot is not a field-by-field diff:
  “updated ticket” is valid, “changed its status” requires actual evidence.
  Comment revision events do not carry the original target; identify the comment
  and link its exact revision instead of inventing a workspace target.
  Ticket/run links open current views; recorded activity itself stays historical.
  Generic event families may have only a category-level summary: do not invent
  details that are not decoded from the retained event.

### Filters, navigation and guidance

- The scope toolbar explains whether this is workspace, project or ticket
  activity and that the newest records appear first. **My activity** uses the
  app’s selected actor as a read filter; it never changes the acting identity.
- The spacious Filter activity dialog separates **Follow a ticket** from
  **Focus on a contributor**, with icons, colored section headers and an
  explanation of each. Search known tickets by title/ID, select known workspace actors,
  and keep manual IDs for records outside the directory. Selecting an option
  closes the picker and visibly sets the field.
- Both filters apply together. An actor means the contributor who performed the
  operation, not the ticket assignee. A ticket filter searches across the
  workspace even if a project is selected; make that scope change explicit.
- Use removable applied-filter chips and Clear filters. Reset fields changes the
  unsaved filter form only; Apply filters performs the read. Cancel/close leaves
  the applied filters unchanged. No filter action writes workspace data.
- Distinguish an empty workspace from no matching results. Offer a useful next
  step instead of implying that missing results are a loading state.
- Provide **How activity works** as an optional, naturally formatted guide. Explain
  recorded operations, contributor identity, local timestamps, live updates,
  saved historical pages and current-item links without requiring API knowledge.

### Live reading and implementation boundaries

Keep exact native capture and paging behavior: the newest 25 records are sought
at one captured revision, byte-clipped pages are continued, and Earlier/Newer
browse that same historical capture. Earlier history has an explicit banner and
**Return to live activity** action. Do not imply pinned history is live.

Preserve the existing retention and scroll-anchor implementation. Expanded
immutable records and their initial surrounding window remain mounted when new
records enter the live page; closing all details releases the retained window.
Normal refresh keeps prior content visible without a loading banner. Actual
failures remain visible. Deliberate filter/scope/page changes reset that reading
window; a background refresh must not. Native browser coverage includes a full
page of new records arriving while a scrolled record is open, preserving its DOM
identity, open state and screen position.

`features/activity/activity-design.css` scopes the new visual rules to
`.ac-feature`. Overview uses the older shared Activity classes, so do not restyle
those globally. `AuditRow.tsx` owns readable event detail; `model.ts` derives only
supported historical descriptions. `ActivityFeature.tsx` owns guidance and filter
state while the existing client, capture, retention and anchoring remain intact.
Focused checks cover multi-change detail, reference selection, manual actor IDs,
empty results, historical/live navigation, narrow layouts and live retention.
This remains a user walkthrough pass, not release qualification or visual approval.

## 21. Advanced: approachable precision

Advanced follows the same bright text, rounded panels, visible borders, semantic
colors and spacious forms as Overview and the other refined pages. It is for
operations without a dedicated screen, API exploration and saved-request recovery.
Explain that purpose immediately; do not assume users already know what a method,
a family, a schema or a request draft means. Everyday views remain the easiest
starting point for everyday work.

### Discovery and navigation

- Keep **Methods, Helpers, Host tools and Saved** visible across the explorer,
  method details and draft flow. Pair icons and color with text, and introduce
  each section with a short explanation. A helper is instructions, not an API
  operation; host tools display commands and never execute a browser-side shell.
- Search method names and descriptions, group by family, and allow filtering to
  read-only operations or operations that can write. Read/write badges explain
  effects; they are not permission claims. Use explicit no-match and empty states
  with a way to clear the search.
- Preserve drafts when returning to the explorer. Keep the draft navigation
  accessible from the landing view so users can resume without discovering an
  invisible mode. Unsent drafts survive in-app navigation, not a browser reload.
- Introduce the flow as **Choose → Prepare → Review**, supported by an optional
  **How Advanced works** guide. Put complete examples and schema inspection behind
  labeled disclosures rather than presenting every technical detail at once.

### Request forms and directory choices

Separate **Destination and author**, **Request inputs**, and **Read result** into
clear panels. Explain that opening or editing a draft does not send anything.
Show the captured actor with an avatar and retain the exact destination. Changing
the app's current actor or workspace must never silently retarget an old draft.

Required inputs come first; optional and conditional inputs have a clearly labeled
expandable section. Keep that disclosure mounted while parameters are validated,
so applying a field does not close the section. Field presence distinguishes
omission, a supplied value and explicit null; do not imply null is accepted by
all schemas. Give each field a readable label alongside its actual API name,
explain its purpose, and tuck detailed format constraints into a disclosure.
**Apply** updates the local draft only. Pending field edits remain visibly staged
and prevent submitting stale values.

Use searchable directory choices for existing record references where the schema
and target are known. Suggestions must match the request's actual workspace,
captured connection generation/socket and current route. If those do not match,
keep manual input rather than offering records from another workspace. New IDs
for create/register operations remain free text. Preserve manual entry when an
existing record is absent from the directory. Filling captured scope fields is
asynchronous: show its pending state and disable conflicting edits/submission
until it finishes.

### Results, writes and recovery

Advanced is an intentional exception to the removal of raw object dropdowns from
ordinary screens: exact inputs, schemas and responses are core tools here. Render
JSON results as an expandable, lossless tree with exact numbers. Retain encoded
source and download in a clearly labeled secondary disclosure. Use the shared
resource JSON viewer, including its stable expansion/scroll behavior, rather
than creating a separate parser or coercing large numbers through native JSON.

A read result is one explicit response, not a live dashboard. Explain this and
retain the exact native continuation/retry requests; do not invent merging or
paging behavior. Read scheduling is an optional technical control.

For writes, clearly distinguish **Validate & prepare** from **Execute saved
request**. Preparing saves exact inputs and destination; execution applies the
saved request. Keep the native operation state, captured author and recovery
controls visible. Explain Inspect, receipt recovery and exact retry without
changing uncertain-write fencing or request identities. Closing a saved editor
must not imply deletion of its durable request. The Saved list describes requests
registered in this browser session, not all historical journals on disk.

### Implementation and review

`features/advanced/advanced-design.css` scopes these visual changes to Advanced;
light and narrow layouts retain clear boundaries and readable controls.
`AdvancedDesign.tsx` contains the guide and directory-choice presentation;
`design-model.ts` holds category descriptions and exact-scope choice rules.
`AdvancedFeature.tsx` keeps the existing controller, native preparation and
execution flow. The shared `JsonPane` accepts a contextual description without
changing resource viewing behavior.

Review native read/write flows, staged edits across navigation, original-author
execution after actor switching, repairable invalid inputs, retained journals,
choice selection and empty discovery states. Browser tests that deliberately
leave a page must allow its owned reads to settle before marking the remaining
reads as expected navigation cancellations; never broadly suppress failed writes
or unexpected requests. Visual review should cover dark/light and narrow layouts,
request forms, schemas/results, guidance and recovery. This is a user walkthrough
pass; completion does not substitute for the user's final visual approval.

## 22. Daemon connections: clear setup and lifecycle controls

The top-left Workgraph button opens the daemon connection manager. This is often
a new user's first setup screen, so introduce a daemon as the background service
that manages workspaces and a profile as a saved name and address. Explain the
companion as the UI's background server. A socket path belongs to that machine;
in WSL it is a path inside WSL, not a Windows path or a browser URL.

### Visual structure and navigation

Use a wide, rounded modal with Overview's bright text and contrasting borders.
Keep the modal title, section navigation and short purpose statement visible as
its contents scroll. On short windows allow the whole body to scroll so fixed
headers cannot consume the available reading area. Use blue for Connections,
green for Daemon, purple for Startup history and orange for Offline tools. Pair
color with icons and labels. Narrow layouts stack forms and maintenance cards.

Connections show recognizable labels, saved addresses and the app's selected
profile. A selected badge is not evidence of daemon health. Manage opens controls
for that address; Use connection changes the app's selected connection and returns
to the workspace interface. Profile editors explain each field: a stable profile
ID, a human-readable label and an absolute Unix socket path. Explain save effects
before submission. Saving changes future connection use, not stored workspace data
or the destination of an existing prepared action. Back retains a draft; Discard
profile draft clears unsent fields and returns to Connections. Closing the modal
retains in-app drafts; do not promise persistence across a browser reload.

### Connection checks, startup and shutdown

Separate everyday selection/checking from process lifecycle operations. Attach
checks protocol and health; it does not select a workspace. Show the latest check
as a historical observation, not a continuous health monitor or proof of process
ownership. Its optional detail uses readable field/value summaries instead of raw
JSON. Connection messages can be dismissed without discarding any saved action.

Start a local daemon explains registry and diagnostic-log paths, the installed
paired executable and the readiness timeout. A timeout is an uncertain outcome,
not evidence that the process stopped. **Review startup plan** saves a plan;
**Start saved plan** is the separate action that attempts startup. Preserve exact
captured endpoint generation, author and paths throughout editing or switching
profiles. A saved plan can be hidden and reopened without deletion or cancellation.
Startup history has Previous/Next navigation, an explanatory empty state and a
route back to daemon controls. Its records describe saved attempts, not an
inventory of running processes. Failed history reads must not advance the page
navigation state.

Put **Stop this daemon** in a separate, orange-accented disclosure below the
routine controls. Explain that shutdown affects every client at that address,
including a daemon started elsewhere, and retains saved workspace data. Explain
why actor selection is required. Preparing shutdown does not execute it.
Disconnect clears the app's selection and keeps the daemon running. The captured
shutdown review can be hidden/reopened, and remains tied to its original address
and writer after disconnecting or selecting a different profile. Use the existing
operation controller and exact retry/uncertain-outcome rules unchanged.

### Offline tools and implementation

Offline migration and journal recovery inherit the same readable maintenance
presentation as Manage Workspace, including operation-effect explanations,
separated review/apply steps, close controls and readable captured values. Their
heading says local maintenance and recovery, rather than suggesting a connected
workspace is required. Retain the supported 0.6.2-only migration boundary and
original-source preservation; a redesign must not broaden migration policy.

`ConnectionIntro.tsx` owns purpose statements; `daemon-design.css` scopes the modal,
forms, disclosures and embedded maintenance styles. `ConnectionManager.tsx` retains
its existing lifecycle controller/store. `ManagementPresentation` supplies readable
review summaries without ordinary raw-JSON disclosures. Style specificity matters:
the original compact manager used more-specific zero-padding selectors, which
must be overridden explicitly to give card headers and bodies room.

Review populated and empty profiles/history, retained edits, captured startup
plans across endpoint changes, hide/reopen controls, actor-gated shutdown and
non-destructive disconnect. Exercise migration editors and journal sub-tabs,
dark/light themes and narrow windows. This walkthrough pass does not imply user
approval, native release qualification or permission to stop the user's daemon.

## 23. Command menu: find, return and navigate

The search control beneath Workgraph opens the Command menu, also available with
Ctrl/Cmd+K. Apply the same rounded modal, bright text, visible borders and semantic
colors as the rest of the UI. Keep the title, mode tabs, short explanation and
keyboard footer stable while the contents scroll. Short windows may scroll the
whole body so fixed headers do not make controls unreachable.

### Three understandable entry points

- **Jump** (blue) starts with the workspace search input, then recent places and
  an expandable **Open a Workgraph link** section. Searching should be immediately
  available; users should not have to navigate around a paste-link field first.
  Recent places are shortcuts from opened results/links, not an activity audit.
  Clearing them does not delete workspace data. Keep DOM order aligned with visual
  order for keyboard and assistive-technology users.
- **Search** (green) explains what can be found and presents workspace scope,
  search text, domain and source filters. Retain queries and captured results when
  closing/reopening or switching modes. Search runs on explicit submission; do not
  imply typing is live search. If edited inputs differ from retained results,
  continue to say which query actually produced those results.
- **Actions** (purple) separates page navigation from connection, workspace and
  identity setup. Use readable two-line command rows with colored icon tiles,
  headings and an obvious focus state. These shortcuts navigate or open settings;
  they do not immediately submit workspace mutations. Empty results explain what
  to try and offer Clear command search, returning focus to the input.

### Search controls and result presentation

Keep everyday search controls compact enough to leave room for results. Use
side-by-side domain/source controls on larger windows and stack them on narrow
ones. Expand detailed filters only when requested. Offer All sources, Tickets only,
and Resources & facts shortcuts, while retaining individual source checkboxes and
Include archived. Explain resource metadata versus indexed resource text and the
meaning of archived. A zero-source selection cannot be submitted and explains
what is missing, including when Enter submits the form.

Results pair colored source icons with explicit source labels, highlighted match
snippets, readable identities and exact revision context. Never fabricate a title
or avatar when the search response only includes an identity and snippets. Empty
planning/history pages offer useful next steps without claiming that a partial or
incompletely indexed capture proves no matches exist. Keep current-record links
separate from exact comment/fact/content pins, and preserve exact continuation
requests rather than mixing search revisions.

The selected daemon, workspace and project remain visible. History searches the
workspace independently of planning project filters; explain that distinction and
the optional session ID. Coverage and captured-query details remain available as
readable text/disclosures, not raw JSON. Search pages are explicit saved captures,
not automatically refreshed live views.

### Links, keyboard and implementation boundaries

A pasted link from another setup must still require explicit mapping to a known
local connection. Never trust its host as the actual daemon identity. If a recent
link cannot resolve its saved connection, reveal the link section so the mapping
controls are reachable. Retained pasted input reopens its section rather than
hiding the work the user was doing.

Retain arrow/Home/End tab navigation, Up/Down navigation between commands, Enter to
open, Escape dismissal and focus containment. Arrow navigation should consider
actual command rows only, not the empty-state reset button or group headings.
Search input comes before recent/link controls in DOM order. Opening a result and
closing the menu must continue to fence delayed destination resolution so a stale
response cannot navigate or add a recent link after dismissal.

`app/CommandPalette.tsx` owns mode descriptions and command grouping;
`app/command-design.css` scopes the palette styling. `SearchFeature.tsx` supplies
source choices, readable results, link disclosure and captured-query presentation.
The search controller, native decoders, exact destination handling and transport
remain unchanged. Browser tests should wait for actual ready/results states;
network-idle waits are inappropriate while the app keeps its live-change waits
open. Review the three modes, empty results, filters, link mapping, retained input,
keyboard navigation, narrow layouts and both themes before user approval.

## 24. Workspace and project scope: choose by name, understand the effect

Treat scope selection as navigation, separate from Manage Workspace editing and
from daemon lifecycle operations. Explain the terms before the choices: a
workspace holds related work, and a project groups a particular effort within it.
Applying scope changes what the pages focus on. It does not create records, move
work, open a closed workspace on the daemon, or transfer existing drafts to a new
workspace or identity. Some pages intentionally remain workspace-wide.

Use two numbered, rounded sections with blue workspace and purple project cues.
Show the connected daemon above them. Browse known workspaces and projects by
name or ID with explicit selected borders and checkmarks; labels and IDs remain
readable. Project choices include All projects and archived projects are identified.
Search filters choices locally; it never changes the selected value. Long choice
lists scroll inside their section, while the modal itself remains scrollable when
help or manual fields expand. Stack sections on narrow windows. Preserve light
and dark palettes, spacious fields, keyboard focus and an explicit Cancel action.

A workspace change clears the previous project immediately: a project ID from one
workspace must never silently carry into another. Keep a selection summary and
Open scope button below the choices so browsing alone does not navigate. Cancel
leaves the original route intact. Clear workspace selection is explicit and also
clears the project; do not describe this as an aggregate query over all workspaces.

Exact IDs remain available through clearly labeled, collapsible manual entry with
instructions and validation. Missing or failed directory results do not erase an
entered value or imply that it does not exist. Explain connection setup when no
daemon is selected, show retries on read failures, and distinguish an empty list
from a partial directory. Selecting a closed workspace does not implicitly open it.
The destination still verifies the selected records against the daemon.

`app/ScopeDialog.tsx` owns the staged selection and presentation;
`app/scope-design.css` scopes its styling. `app/scope-choices.ts` uses the existing
companion/read-slot infrastructure, workspace entity decoder and captured project
choice reader. Read identities include connection ID, generation, socket and
workspace; changing selection cancels old reads and hides old-workspace results.
Project paging retains one capture rather than silently showing only the first
page. Scope navigation keeps the existing route-reset and draft-ownership rules.
The acting-identity modal is separate and is not restyled by these selectors.

Verify search and selection, workspace changes clearing projects, All projects,
manual validation, Cancel versus Open scope, no-connection instructions, empty
project results, Escape/focus return, and both themes/narrow layouts. Tests that
enter exact IDs now explicitly open their disclosure. Selection must issue reads
and navigation only, never a mutation.

## 25. Acting actor and run: clear identity without hidden side effects

Explain actor and run before asking for IDs. An actor is a person or agent named
on actions; a run records a particular invocation or effort. This local selector
is not authentication. Choosing an identity neither transfers claims nor overrides
ownership or eligibility checks. Selecting a run does not register it, start a
process or claim work. Existing drafts and prepared requests retain their original
identity. Use selection applies staged choices; Cancel and Escape discard them.

Use the same spacious, rounded two-column layout as the scope selector, with blue
actor and purple run sections, readable explanatory text and visible workspace/
daemon context. Actor rows use stable avatars and display names alongside exact
IDs. Identify registered people, registered agents, archived registrations and
observed-but-unregistered identities honestly. Run rows show objective, exact ID,
owner avatar/ID and a colored recorded-status label. Recorded status is not a
process-liveness assertion. Do not imply a missing directory entry is invalid.

Keep direct actor/run ID fields visible, with search-and-select directories below
and clear selection indicators. This lets known-ID entry remain a quick operation
without hiding the beginner-friendly browse path. Search actors by name or ID;
search runs by ID, owner, objective or status. By default, an entered actor narrows
the run list. An explicit Show runs for other actors control broadens that browse
filter, not the actual action scope. Empty actor selection shows all runs.

Preserve the existing independent actor/run contract: changing an actor does not
silently clear or replace a run, and selecting a run does not silently impersonate
its owner. A known owner mismatch gets a readable notice explaining both values
and how to clear/change the run. It is guidance, not a new client permission gate.
An unverified run ID has an explicit explanation rather than invented metadata.
Empty actor and empty run selections remain possible. Clearing either field is a
separate explicit action.

Keep the staged identity summary and Use selection/Cancel controls in a fixed
footer while the content scrolls. The footer is a flex sibling of the scrollable
body, not an overlay that obscures the final row. Directories have their own
bounded scroll regions; on narrow windows, stack the sections without horizontal
overflow. Review both themes, selected states, mismatch notices and no-workspace
instructions. Without a selected daemon/workspace, known IDs can still be entered;
only browse choices are unavailable. No raw object metadata is needed.

`app/WriterDialog.tsx` owns staged values and presentation, with scoped styling in
`app/writer-design.css`. `app/writer-choices.ts` reuses participant/run decoders and
read slots; actor and run directories have independent failure states. Reads are
workspace-wide, keyed by endpoint generation/socket/workspace, canceled on scope
change/unmount, and refreshes do not rewrite selection. Run paging retains exact
revision/head continuations and rejects incomplete, changed or repeated results.
Do not infer run ownership by parsing a formatted label.

Focused validation covers directory filtering, avatars and labels, explicit
selection, mismatch preservation, Cancel/apply, manual validation, clearing each
field, no-workspace entry, narrow layouts and keyboard dismissal/focus return.
Verify that the modal issues no mutation or preparation requests. Keep legacy
manual-entry workflows usable, and test decoder/paging failure cases separately
from visual layout.


## 26. Fast scope switching and remembered identity

Keep the active workspace and project focus visible near the top of the sidebar,
above page navigation. Use separate, labeled controls with readable names, distinct
blue/purple icons, two-line titles when needed, and full-name tooltips. Breadcrumbs
also prefer names, falling back to exact IDs while directory data loads. The
sidebar remains scrollable on shorter screens; acting identity also appears in
the top bar so it is visible even when the sidebar footer is out of view.

Workspace and project controls open small, searchable choice dialogs. Show names
and IDs together, preserve a clear selected state, and explain what changing scope
does. A bookmark button beside each project toggles a persistent sidebar shortcut.
Pinned projects are shortcuts for switching one focused project at a time: they do
not combine project queries, totals or write destinations. All projects returns
to workspace-wide scope. Switching workspace clears the previous project focus
and uses that workspace's own pins. Do not silently delete a pin because a
partial or temporarily unavailable directory omitted its project. Keep unpinning
explicit and provide a refresh and full scope-settings path.

The user explicitly chose pinned shortcuts over a combined multi-project view.
Keep that distinction in future work. A union view would require a separately
specified creation destination, deduplication, totals and pagination contract.
Switching uses the existing route builder, clearing incompatible entity/filter
state while retaining the requested page. Choice dialogs use the shared native
modal for keyboard focus, Escape/backdrop dismissal and focus return; render the
quick switcher through a portal so sidebar scrolling cannot clip it.

Remember the actor/run pair and pinned project IDs in browser local storage,
scoped by connection ID, socket, endpoint generation and workspace. Project
switches inside one workspace keep the same identity. Different workspaces and
replacement connection generations do not silently inherit it. Clearing actor or
run is itself remembered. Storage is a local preference, not an account, daemon
record, authentication or credential store. It is tied to the browser origin;
changing the UI address, clearing site data, or replacing an endpoint can require
selection again. If storage is unavailable, retain choices in this tab and say
that refresh persistence is unavailable. Validate stored IDs and reject corrupt
preferences without throwing away the application's other data. Other browser
tabs do not silently change the identity in an active tab.

Use a persistent avatar and “Acting as …” control in the top bar, or an amber
“Read-only · Choose actor” control. Clicking either opens the existing identity
selector. Read-only here describes the identity for new actions; existing captured
drafts retain their original author. It is not a new daemon permission mode.

When a new action requires an actor, open the selector instead of disabling the
entry solely because no actor is chosen. The shared Button `requiresActor` flag
and `useActorGate` support buttons and action factories. Keep unrelated guards
(disconnected/stale endpoint, incomplete record, missing selection, author-only
rights, busy operation, etc.). Preserve underlying dialogs and staged fields;
Cancel returns without creating a draft, and applying an identity returns the user
to the action. Do not auto-submit or retry that action. Existing drafts, requests,
claims and prepared writes keep their original captured identities. Read-only
inspection must not acquire an actor requirement. Inline message composers offer
a clear Choose actor control when an author is missing.

The shell additions exposed a reproducible burst limit in the browser protocol
processor: opening a directory during page startup could exceed its old four-job
queue. It now allows 64 pending jobs while retaining one active worker, the 32 MiB
aggregate input reservation and existing deadlines/cancellation behavior. This
change neither retries writes nor changes daemon admission or resource sizes.
Keep capacity tests tied to the configured bound and verify opening selectors
while page reads are active.

Implementation lives in `app/SidebarScope.tsx`, `app/local-selections.ts`,
`app/sidebar-design.css` and `components/ActorAccess.tsx`, with explicit gates at
new-action entry points. Validate refresh persistence, multiple pins, project
focus/All projects, workspace isolation and return, clearing identity, nested
modal cancellation/apply, narrow layouts and both themes. Assert that switching,
pinning and choosing an actor issue no preparation or mutation by themselves.

## 27. Sidebar visual continuity

The sidebar is part of the product interface, not a dim utility strip. Use the
Overview's readable foregrounds:14px navigation and scope titles,12px supporting
labels, clear11px group headings, and distinct borders. Keep the daemon name
compact with ellipsis, full scope names available as tooltips, and room for up to
two lines in workspace/project selectors. Default desktop width is260px and can
be resized from228–340px; preserve the user's saved width within those bounds.

Group the existing destinations without renaming routes: Workspace contains
Overview, Work, Workflow, Discussions and Participants; Knowledge contains History,
Resources, Saved views and Facts; Tools & activity contains Activity and Advanced.
Use stable category-colored icons, always with text: blue for structural work and
resources, purple for workflows/saved views, pink for discussions, green for
participants/facts, gold for history and orange for activity. These are navigation
cues, not claims about live status. Selected links use a tinted rounded surface,
visible border, stronger text and a slim inset accent; selection is also declared
with aria-current. Hover and keyboard focus remain distinguishable.

Use11–14px corner radii across navigation, search, scope cards, pin shortcuts and
identity controls. Give workspace/project controls restrained blue/purple surface
tints. Keep the logo and search compact, with adequate click targets. Unpin controls
remain faintly visible at rest rather than being discoverable only on hover, which
also supports touch. Navigation tooltips explain each destination using the existing
short descriptions rather than adding paragraphs under every link.

Keep a fixed top containing daemon selection and search, a flex middle scroll
region containing scope/navigation/pins, and a fixed bottom containing companion
status and acting identity. The middle must have min-height:0 and overflow:auto;
clipping the whole sidebar makes later destinations inaccessible. The footer stays
visible on short screens without covering the list. Companion reachable describes
the companion only, not daemon health or agent liveness. An unselected identity
uses a subtle amber outline and a clear instruction to choose an actor. Selected
identity retains its stable avatar and optional run context.

Scope the palette to the sidebar, with darker corresponding accents and readable
secondary text for light mode. Import the sidebar refinement after the base shell
styles so the refined spacing and scroll behavior actually win. Verify both themes,
a short desktop viewport, navigation selection and the mobile drawer/identity
chooser. This pass changes presentation and scrolling, not scope, pinning, actor
persistence, write permissions or captured draft behavior.

## Recipient choices include observed actors

An actor can participate in a workspace without having a separate actor-directory
registration. Registering a run or authoring a comment does not require `actor.put`.
Recipient suggestions must therefore use the full `participant.list` directory,
including identities observed through activity, rather than filtering to catalog
registrations. Call these **known actors**, not registered actors. Show the
registered display name when available and mark activity-only choices with
“seen in activity”; this does not claim that a process is currently running.

The shared recipient picker excludes explicitly archived registrations from its
suggestions. Keep manual ID entry available for archived or otherwise unlisted
recipients. Refreshing the directory must retain the selected recipient. Reader
selection remains separate from the acting writer, and directory requests stay
scoped to the captured connection generation and workspace, independent of the
selected project. A failed or partial directory read is not an empty workspace.


## Change-driven refresh and multi-tab observation (0.8.2)

A healthy idle page must not reread its projections on a timer. The visible
feature owns one authenticated `/ui-api/v1/live-observations` long poll combining
planning and, for History, history-feed cursors. The companion waits for either
feed for up to 25 seconds; native HTTP keep-alive permits connection reuse. This
is deliberately a fixed-length JSON response using the existing capability
header, not an unauthenticated EventSource endpoint.

Establish cursors before refreshing current data, retain them across transient
network failures, and use a 250 ms batching window for changes. Never reset a
cursor merely because a connection dropped: that used to cause a full refresh
on every reconnect. Invalid native cursors may explicitly bootstrap again and
refresh current projections. Keep refreshes serial, retain prior rendered data,
and preserve fixed historical captures and all write guards. Quiet retries must
never reload the whole application or replay writes. Hidden, closed, reloaded or
superseded scopes cancel their foreground reads. Repeated focus events while
already visible are not a reason to reread everything.

Observation has its own 16-slot admission counter, owned by the companion's Eio
domain. It is separate from the generic two-slot Wait lane. Each observation
uses at most two simultaneous daemon connections; immediate capacity rejection
lets the browser back off and use bounded fallback refreshes. A queued long poll
must not occupy ordinary read or write capacity. Test multiple simultaneous
observers, cancellation and reopening, not just one tab's happy path.

Overview, Participants and Saved views also opt into a companion-side comparison
of default stale-run, stale-ownership and expired-ownership warning states at
observation boundaries. Fetch complete native warning pages; discard only their
age counter from the comparison, not the actual state or observed timestamp.
This preserves clock-only warning transitions without restoring unconditional
browser page polling. The check uses the daemon's default five-minute stale-run
threshold. A clock-only transition can take up to one 25-second wait interval.
It is not a general live execution engine for arbitrary custom time predicates.

The connection directory no longer polls every ten seconds while healthy. Read
it on opening, explicit profile changes, visibility restoration and online
recovery. Retry failed checks with bounded backoff while retaining selected
profile generations. Explicit per-operation monitoring (for example, an upload
in progress or a user-requested request wait) still has its own lifecycle.

Browser acceptance must count actual API requests across a complete idle wait
interval, then perform a native write and verify that the visible page updates.
Do not mistake an empty timeout for a change. Test transports and cleanup must
identify cancellation of the new read-only observation route as precisely as
ordinary read cancellation; do not broadly suppress network failures.
