# Search and typed links

Open the command menu with **Cmd+K** on macOS or **Ctrl+K** on other platforms.
**Jump** combines recent places, pasted links and scoped live search. **Search**
focuses on result discovery. **Actions** retains the view, connection, workspace
and acting-context commands. Use Tab to move through search controls and results;
the section tabs also support Left/Right, Home and End. Escape closes the menu.

Live search uses the displayed connection generation and workspace. A selected
project filters planning search; history search has its own session filter and
does not inherit the planning project filter. Search never fans out to other
connections or workspaces automatically. Changing the acting actor does not
reissue a query or rewrite an already captured result.

## Choose the search domain

Planning search covers current workspace, project, milestone and ticket details,
comments, handoffs, resource metadata, eligible resource text and facts.
It does not search thread/message text. The source filters and archived-record
choice are explicit. Resource text indexing reads at most 64 KiB per resource and
1 MiB across one request. Expand **Search coverage** for indexed, prefix-only and
unindexed resources and the reason each reported resource was omitted. Coverage
entries have their own bounded page; a missing entry does not prove full indexing.

Imported history is a separate domain. Its results retain an exact history head,
per-session committed/indexed positions and a scanned-event continuation. The menu
reports incomplete indexing, unsearchable events and byte-budget omissions.
Indexing progress can make a new search more complete; it does not change an old
capture or trigger an automatic retry. Open a result to inspect its exact event.

**Next captured page** and **Next scanned history page** use the displayed
capture's original query and revision/head. Editing the text or filters leaves
that result set labelled with its captured query. Paging it does not overwrite
new, unsent input. Select **Search** to apply the new input. Closing or switching
menu sections retains the input and captured results without reissuing reads.
Changing the endpoint, workspace or project cancels obsolete reads and hides the previous scope's results. The four most recently used exact scopes retain their successful captures, unsent input and chosen result locally. Returning with Back restores that page and result focus without another search; an evicted scope starts empty. Dismissing
the menu cancels a pending destination lookup so it cannot navigate later.

## Understand result identity

A planning entity or handoff result shows the revision observed by search and
opens the current record at the retained endpoint. That is not a historical
planning reconstruction. A comment result opens the exact comment revision,
including for non-ticket targets; its target button is separately labelled
**current resolution**.

A fact result retains its explicit scope, key and fact revision. A fact revision
is distinct from a planning query revision. Refresh does not remove the fact
version pin. An explicit planning query revision is a consistency guard, not a
replayable historical database: if it becomes stale, the read reports a conflict
instead of silently substituting current data. Use **Return to current value**
to deliberately clear those pins. A resource metadata result opens the
current resource selection. A resource-text result retains the immutable content
version and resolves its descriptor and digest before opening the actual viewer.
If that version or descriptor is missing or incomplete, it reports failure;
current content is not substituted. The normal source, raw and verified download
controls remain available in the destination view.

Links retain the connection ID, generation and workspace alongside their typed
entity, scope or content identity. A missing retained profile or target fails
explicitly. A profile's newer generation is not substituted for an old link.

## Paste a link or use recent places

Paste a Workgraph browser URL or a typed `#/…` view link in **Jump**. Only the
validated view fragment is consumed; the pasted hostname does not prove the
original daemon endpoint. An unknown connection ID requires choosing a saved
profile and generation explicitly. **Map to selected endpoint and open** preserves
the content pin while deliberately changing the local endpoint mapping. A matching
ID or successful lookup still does not authenticate the link's original source.

Recent typed links are local to this browser origin, bounded to 32 links and
64 KiB. They remain available when a live search fails or the daemon is offline.
They contain navigation identities, not cached content or acting credentials.
**Clear recent links** removes that list. Storage denial or malformed stored links
are reported visibly; they are not treated as a successful save. Another browser
or companion port has a separate origin-local list.
