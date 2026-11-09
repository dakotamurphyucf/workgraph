# Saved views and value renderers

Saved views use closed, passive configuration documents. They do not execute code, fetch remote schemas, infer process health, launch commands, or authorize mutations. The ordinary builder edits a draft separately from the last working view. Invalid fields, unfinished numeric text, and unsupported configuration versions stay available in Builder or Raw; they cannot activate a previous valid value silently.

## Library, Builder and Results

**Library** shows private configurations for the exact selected target, with a
filter for their titles and IDs. **Builder** holds the current editable draft;
**Results** holds the last successfully activated view. Switching sections keeps
unfinished builder inputs and the working results. **Discard draft** explicitly
abandons that draft without removing its saved configuration or working results.

**Import**, **Shared catalog** and **Saved targets** open focused dialogs. Closing
a dialog does not publish anything or discard the retained import text. A renderer
changes how an individual structured value is displayed; a view selects a
collection of records and arranges them into a table, list, board or timeline.
Both use the same passive configuration and guarded persistence rules below.

## Create and activate a view

Open **Saved views**, choose **New view**, then choose a source and layout. Filters and fields are limited to that source's native contract. Review the configuration and choose **Activate view**. A successful captured read replaces the working view atomically and opens Results; a failed candidate leaves the previous working view visible at the same target. Changing endpoint or workspace hides foreign captures and cancels pending reads.

The first activated page follows live updates without repeating its initial read.
After **Next source page** or **Retry source page**, the loaded sequence stays on
its captured query; **Fresh query** deliberately replaces it with current data.
This prevents a new write from mixing incompatible snapshots into one result.

The eight sources are tickets, runs, attempts, recorded sessions, resources, facts, discussions, and activity. Each page retains the exact endpoint generation, workspace, query, native response, and applicable capture. Planning revisions, history heads, communication captures, and activity intervals are distinct. Session continuations stay at their captured history head. Next and larger-budget retry follow only validated native continuations. The loaded view retains at most 512 rows; its capacity warning persists until a fresh query and further loading stops at capacity.

For **Resources**, scope selects a resource-link filter. Workspace scope means
resources explicitly linked to that workspace; project, milestone and ticket
scopes mean resources linked to that selected entity. Unlinked resources can
appear in the ordinary Resources directory while this view has no matching rows.
The scope explanation appears beside the control and captured results. It does
not change collection or byte-coverage reporting.

Server filters use the native source query. Loaded filters, secondary ordering, grouping, and presentations operate on the loaded rows; their coverage is shown next to the result. Collection traversal, reported field truncation, and value acquisition are independent. Some native sources do not report byte completeness; a complete traversal is not a claim that every field was returned. Fact joins and bounded resource JSON enrichment retain per-row decoded, missing, deleted, unsupported, budget, invalid, and unavailable observations, plus original read responses. Resource pointer columns read at most 64 KiB per resource and 1 MiB per page, verify exact content identity and digest, then parse in the worker. They never replace an unavailable historical version with current content.

Table and list layouts support source-appropriate columns. Grouped tables and boards use explicit supported grouping fields; ticket boards require status. Timelines use the first supported timestamp sort field and show it explicitly. Recorded sessions expose actual Unix-millisecond creation/last-event values; exact integer ordering preserves their native precision. Missing or out-of-calendar values appear as unknown time. Attempts have no native creation timestamp and cannot form timelines. Search options such as `text` and `include_archived` are query selectors, not fabricated row columns. Discussion actor is a server selector, not a projected ownership field.

## Private settings and preferred views

**Save privately** writes to the local companion's private settings, scoped to the exact retained connection ID, generation, socket, and workspace. This does not publish a daemon resource. There are at most 25 documents globally, each at most 64 KiB, within a 2 MiB canonical settings envelope. Each save captures the global private revision, full document set, preferred ID, and target before I/O. This private revision is unrelated to planning, resource metadata, or content revisions.

**Set preferred** is an explicit private write. It marks a preferred saved document; opening the target does not automatically activate it. Open the document, review it, and activate deliberately. Unsupported saved source remains available in Raw. **Saved private targets** lists bounded retained target buckets, including old generations. Inspect one explicitly to remove its documents and recover capacity; this does not retarget them onto the current endpoint.

The private inventory shows a supported configuration's validated title beside
its stable ID. Titles are optional bounded read-side projections, separate from
save acknowledgement. Unknown, invalid, mismatched-ID or temporarily unavailable
source retains the ID and its Open/Remove controls; displaying a title never
activates a view or queries its source.

A definitive conflict or invalid input is a rejection, not an uncertain write. Inspect the original target, review its observed revision, and explicitly choose a new guard before saving again. A lost response, canceled admitted save, or local post-publication failure is uncertain. The original immutable save remains available for inspection and reconciliation; reads never silently refresh its guard or trigger another write. A matching desired state observed later does not prove which attempt installed it. Failed durable reconciliation fences further writes until a successful explicit read. A new read never rewrites an existing draft's captured guard. A preference, removal, or import may conflict without an editing draft. After inspecting that conflict, **Discard intention and inspect current settings** explicitly abandons the saved plan and clears stale observations before a fresh read. It performs no write, does not undo or resolve a prior publication, and retains imported source/mappings. Once the fresh read succeeds, deliberately review the desired action again; concurrent documents remain part of the current settings. Failed refresh stays unavailable and can be inspected again.

## Portable import and export

Export includes only the chosen portable document IDs, exact source text, preferred ID, and settings format version. It excludes endpoint sockets, actors, credentials, authority, and native revision guards. Import retains unsupported versions as opaque inactive source. Supported view documents require explicit scope mapping, including an explicit confirmation for workspace scope. Newly mapped known documents are validated again before saving. Invalid mappings and unfinished form text cannot save an older valid candidate. A new import, mapping change, target switch, or disposal cancels obsolete adoption work before it can launch a save.

Builder-to-Raw preserves unfinished local text for return to Builder. The representable Raw JSON may still contain the previous numeric value. Editing Raw explicitly replaces that form state; the UI explains this boundary.

## Shared configuration publication

Shared publication captures an explicit writer and retained endpoint/workspace. Configuration and catalog resource IDs must differ. Review captures current resource metadata guards, complete retained content-version counts, the catalog's exact verified bytes, existing links, and the `ui.config.index` fact guard. It prepares one bounded native transaction with one new mutation identity. **Execute saved request** is the explicit write action; observation and previews do not send it. Exact retry keeps the same saved identity and parameters. Rebase requires a new reviewed intention.

Resource linking and index fact scope are separate inputs. Config/catalog resources link only to an explicit workspace or project. The index fact may use workspace, project, milestone, or ticket scope. Both stay within the same captured endpoint/workspace. Existing resource bases retain their full provenance; same IDs or revisions from another workspace/generation cannot supply guards. Every catalog entry pins the decoded kind/ID and exact staged content version, SHA-256, and size. Content-version prediction uses retained content history, never metadata revision. Native transaction CAS prevents stale index/content guards from partially replacing a working catalog. An uncertain outcome does not automatically replace the working view or refresh guards.

## Verified renderer selection

The value renderer chooser is composed into captured Fact values, Resource content, and original History payloads. It performs no additional subject reads. Generic remains selected until an explicit choice. **Match verified catalog** requires exactly one matching verified renderer; no match, ambiguity, unavailable catalog entries, partial values, binary content, and values above 64 KiB retain the generic viewer. Explicit selection retains an exact resource/content-version/digest/size pin. Unsupported or disappeared pins do not fall back to current content.

Matchers can use entity, fact key prefix, normalized MIME, root JSON kind, and an explicit schema declaration. A declaration is only this own root object field:

```json
{"schema":{"id":"example-measurement","version":"1"},"temperature":21.5}
```

`schema` must contain exactly `id` and `version`; ID uses the native Identifier domain, and version is a nonempty string of at most 64 UTF-8 bytes. This informs optional matching only, not authoritative validation of arbitrary payload. Missing declarations (including root arrays and nested schema-like values) mean no schema. Malformed declarations display a concise diagnostic and remain no-schema; there is no inference, coercion, schema fetching, or modification of the original source. Explicit verified renderer selection still wins.

Renderers select fields, bounded tables, passive Markdown, fixed-language code, or JSON. Missing/wrong-kind pointers have explanatory fallback. Numbers retain their exact lexemes; missing and explicit null remain distinct. The original viewer appears exactly once, under **Original viewer · Source / Raw** when a renderer is selected, including table and incompatible-field modes. Raw/provenance and source availability remain accessible. Custom HTML, script, arbitrary URLs, and executable formatting are not supported.

Renderer state is keyed by full captured connection ID, generation, socket, workspace, and content identity. Changing any association resets selection and fences late parsing. History may use only a matching current profile or an already verified matching catalog profile; if the exact retained profile is unavailable, it stays generic without extra profile reads. Provider-independent transcript projections and their source controls remain separate from this optional interpretation of the original payload.
