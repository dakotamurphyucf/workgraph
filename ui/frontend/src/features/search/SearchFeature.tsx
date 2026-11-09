import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { routeHref } from "../../app/navigation";
import type { Route } from "../../app/types";
import { Icon, type IconName } from "../../components/Icon";
import { Badge, Button, Field, Select } from "../../components/Primitives";
import * as d from "../../core/protocol/decoders";
import type { ReadState } from "../../core/state/read-slot";
import { failureText } from "../connections/failure";
import { searchRoute } from "../history/analytics/model";
import type { SearchQuery as HistoryQuery } from "../history/analytics/types";
import { matchParts } from "./codecs";
import { queryKey, scopeKey } from "./client";
import { retained } from "./controller";
import { mapEndpoint, pastedRoute } from "./navigation";
import type {
  PlanningCapture,
  PlanningQuery,
  SearchFeatureProps,
  SearchHit,
  SearchKind,
  SearchScope,
} from "./types";
import "./search.css";
const sourceIcons: Record<SearchKind, IconName> = {
  ticket: "work",
  comment: "discussions",
  handoff: "participants",
  resource: "resources",
  resource_text: "resources",
  fact: "facts",
  project: "workflow",
  milestone: "milestone",
  workspace: "overview",
};
const kinds: readonly [SearchKind, string][] = [
  ["ticket", "Tickets"],
  ["comment", "Comments"],
  ["handoff", "Handoffs"],
  ["resource", "Resource details"],
  ["resource_text", "Resource text"],
  ["fact", "Facts"],
  ["project", "Projects"],
  ["milestone", "Milestones"],
  ["workspace", "Workspace"],
];
function identity(hit: SearchHit): string {
  const s = hit.source;
  switch (s.kind) {
    case "workspace":
      return s.workspace_id;
    case "project":
      return s.project_id;
    case "milestone":
      return s.milestone_id;
    case "ticket":
    case "handoff":
      return s.ticket_id;
    case "comment":
      return s.comment_id;
    case "resource":
    case "resource_text":
      return s.resource_id;
    case "fact":
      return `${s.scope.kind}${s.scope.kind === "workspace" ? "" : `:${s.scope.id}`} / ${s.key}`;
  }
}
function ReadStatus<T>({ state }: { readonly state: ReadState<T> }) {
  if (state.kind === "unexpected_error") throw state.error;
  if (state.kind === "loading") return <p role="status">Searching this captured scope…</p>;
  if (state.kind === "failed") return <p role="alert">{failureText(state.failure)}</p>;
  return null;
}
function Snippets({ hit }: { readonly hit: SearchHit }) {
  return (
    <div className="wg-search-snippets">
      {hit.matches.map((match, index) => {
        const parts = matchParts(match);
        return (
          <p key={index}>
            <span>{match.field}</span>{" "}
            {parts === null ? (
              match.snippet
            ) : (
              <>
                {parts.before}
                <mark>{parts.match}</mark>
                {parts.after}
              </>
            )}
          </p>
        );
      })}
    </div>
  );
}
function Result({
  capture,
  hit,
  open,
  disabled,
}: {
  readonly capture: PlanningCapture;
  readonly hit: SearchHit;
  readonly open: () => void;
  readonly disabled: boolean;
}) {
  return (
    <li className="wg-search-result" data-kind={hit.source.kind}>
      <Button
        className="wg-search-result-title"
        data-search-position={`planning:${hit.source.kind}:${identity(hit)}:${hit.source.revision}`}
        onClick={open}
        disabled={disabled}
      >
        <span className="wg-search-result-heading">
          <Icon name={sourceIcons[hit.source.kind]} />
          <strong>{identity(hit)}</strong>
        </span>
        <Badge>{hit.source.kind.replaceAll("_", " ")}</Badge>
      </Button>
      <Snippets hit={hit} />
      <small>
        {hit.source.kind === "resource_text"
          ? `Content version ${hit.source.revision} · exact descriptor resolved on open`
          : hit.source.kind === "fact" || hit.source.kind === "comment"
            ? `Pinned revision ${hit.source.revision}`
            : `Observed revision ${hit.source.revision} · opens current record`}{" "}
        · planning capture {capture.revision}
      </small>
    </li>
  );
}
function routeLabel(route: Route) {
  return `${route.view} · ${route.entityId ?? route.projectId ?? route.workspaceId ?? "home"}`;
}
function Recent({
  routes,
  open,
  clear,
}: {
  readonly routes: readonly Route[];
  readonly open: (route: Route) => void;
  readonly clear: () => void;
}) {
  return (
    <section aria-label="Recent typed links">
      <div className="wg-search-section-title">
        <h3>
          <Icon name="history" /> Recent places
        </h3>
        <Button tone="quiet" disabled={routes.length === 0} onClick={clear}>
          Clear recent links
        </Button>
      </div>
      {routes.length === 0 ? (
        <p className="wg-hint">
          Places you open from this menu appear here for a quick return. Clearing this list only
          removes these shortcuts; it does not delete workspace data.
        </p>
      ) : (
        <ul className="wg-search-recents">
          {routes.map((route) => (
            <li key={routeHref(route)}>
              <Button tone="quiet" onClick={() => open(route)}>
                {routeLabel(route)}
                <small>
                  {route.connectionId ?? "No endpoint"} · {route.workspaceId ?? "No workspace"}
                </small>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
export function SearchFeature({ context, controller, mode, footer }: SearchFeatureProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get),
    draft = state.draft;
  const { connection, route } = context;
  const scope = useMemo<SearchScope | null>(() => {
    const workspace = d.identifier.decode(d.jsonString(route.workspaceId ?? "")),
      project =
        route.projectId === null ? null : d.identifier.decode(d.jsonString(route.projectId));
    return connection !== null && workspace.ok && (project === null || project.ok)
      ? {
          connection,
          workspaceId: workspace.value,
          projectId: project === null ? null : project.value,
        }
      : null;
  }, [connection, route.workspaceId, route.projectId]);
  const key = scope === null ? null : scopeKey(scope);
  useEffect(() => {
    controller.scope(scope);
  }, [controller, scope]);
  useEffect(() => () => controller.dismiss(), [controller]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.position === null) return;
    const frame = requestAnimationFrame(() => {
      const button = Array.from(
        root.current?.querySelectorAll<HTMLButtonElement>("[data-search-position]") ?? [],
      ).find((value) => value.dataset.searchPosition === state.position);
      button?.focus();
      button?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [key, state.position, mode]);
  const [mapping, setMapping] = useState("");
  const [linkOpen, setLinkOpen] = useState(() => draft.paste.trim() !== "");
  if (state.unexpected !== null) throw state.unexpected.error;
  const edit = (patch: Partial<typeof draft>) => controller.edit({ ...draft, ...patch });
  const go = (target: Route) => {
    controller.remember(target);
    context.navigate(target);
    context.onClose();
  };
  const paste = draft.paste.trim() === "" ? null : pastedRoute(draft.paste),
    unknown =
      paste?.ok === true &&
      paste.route.connectionId !== null &&
      !context.profiles.some((value) => value.id === paste.route.connectionId);
  const mapped = context.profiles.find((value) => value.id === mapping);
  const planning = retained(state.planning),
    history = retained(state.history);
  const matchingPlanning =
    scope !== null && planning !== undefined && scopeKey(planning.scope) === key ? planning : null;
  const matchingHistory =
    scope !== null && history !== undefined && scopeKey(history.scope) === key ? history : null;
  const query: PlanningQuery = {
    text: draft.text,
    kinds: draft.kinds,
    includeArchived: draft.includeArchived,
  };
  const historyQuery: HistoryQuery = {
    text: draft.text,
    sessionId: draft.sessionId,
    kinds: [],
    capture: { kind: "current" },
    limit: "25",
    maxBytes: "65536",
  };
  const run = (next = false) => {
    if (
      scope === null ||
      draft.text.trim() === "" ||
      (draft.domain === "planning" && draft.kinds.length === 0)
    )
      return;
    if (draft.domain === "planning") void controller.planning(scope, query, next);
    else void controller.history(scope, historyQuery, next);
  };
  let body: ReactNode = null;
  if (draft.domain === "planning" && matchingPlanning !== null) {
    const capture = matchingPlanning,
      page = capture.value;
    body = (
      <section aria-label="Planning search results">
        <div className="wg-search-section-title">
          <h3>Results for “{capture.query.text}”</h3>
          <Badge>{page.items.length} on this page</Badge>
        </div>
        {queryKey(capture.scope, capture.query) !== queryKey(capture.scope, query) && (
          <p role="status">
            Retained results use the query above. Run Search to apply edited input.
          </p>
        )}
        <p className="wg-hint">
          Current revisions at capture {capture.revision} · {page.sources_scanned} sources scanned.{" "}
          {capture.partial && "Response coverage is partial."}
        </p>
        <p className="wg-hint">
          Captured kinds: {capture.query.kinds.join(", ")} ·{" "}
          {capture.query.includeArchived ? "including archived" : "active records"}.
        </p>
        <ul className="wg-search-result-list">
          {page.items.map((hit, index) => (
            <Result
              key={index}
              capture={capture}
              hit={hit}
              disabled={state.opening}
              open={() => {
                controller.position(
                  `planning:${hit.source.kind}:${identity(hit)}:${hit.source.revision}`,
                );
                void controller.open(capture, hit).then((target) => {
                  if (target !== null) go(target);
                });
              }}
            />
          ))}
        </ul>
        {page.items.length === 0 && (
          <div className="wg-search-no-results">
            <Icon name="search" />
            <h3>No matching records on this page</h3>
            <p>
              Try a shorter phrase, include more source types, or check the selected workspace and
              project. Coverage details below explain which resource contents were searched.
            </p>
          </div>
        )}
        <Button
          disabled={page.next_offset === null || state.planning.kind === "loading"}
          onClick={() => {
            void controller.planning(capture.scope, capture.query, true);
          }}
        >
          Next captured page
        </Button>
        <details className="wg-search-coverage">
          <summary>
            Search coverage · {page.coverage.indexed_text_resources} of{" "}
            {page.coverage.eligible_text_resources} eligible text resources indexed
          </summary>
          <p>
            Current revisions only. Up to 64 KiB per text resource and 1 MiB across the request.{" "}
            {page.coverage.truncated_text_resources} resources have only a prefix indexed;{" "}
            {page.coverage.unindexed_text_resources} are not indexed. Historical resource versions,
            thread/message text and arbitrary history payloads are outside this domain.
          </p>
          <ul>
            {page.unindexed_resources.items.map((item, index) => (
              <li key={index}>
                {item.source.resource_id} v{item.source.revision}:{" "}
                {item.reason.replaceAll("_", " ")} · indexed {item.indexed_bytes} bytes · omitted{" "}
                {item.omitted_bytes}{" "}
                {item.size_known ? "bytes" : "bytes reported; full size unknown"}
              </li>
            ))}
          </ul>
          {page.unindexed_resources.remaining !== "0" && (
            <p>{page.unindexed_resources.remaining} more coverage entries are not on this page.</p>
          )}
        </details>
      </section>
    );
  }
  if (draft.domain === "history" && matchingHistory !== null) {
    const capture = matchingHistory.value;
    body = (
      <section aria-label="History search results">
        <div className="wg-search-section-title">
          <h3>History results for “{capture.query.text}”</h3>
          <Badge>{capture.data.items.length} on this page</Badge>
        </div>
        <p className="wg-hint">
          Exact head <code>{capture.capture.head ?? "empty capture"}</code>.{" "}
          {capture.data.index_complete
            ? "Captured index is complete."
            : "Captured index is incomplete."}{" "}
          {capture.data.unindexed_events} unindexed · {capture.data.unsearchable_events}{" "}
          unsearchable · {capture.data.omitted_for_budget} omitted for budget.
        </p>
        {capture.data.restart_after_indexing && (
          <p role="status">
            Indexing can expose more results. Run a new search explicitly when ready; this capture
            will not change.
          </p>
        )}
        <p className="wg-hint">
          Captured session filter: {capture.query.sessionId || "all workspace sessions"}.
        </p>
        {(capture.query.text !== draft.text || capture.query.sessionId !== draft.sessionId) && (
          <p role="status">
            Retained history results use the captured query and filter above. Run Search to apply
            edited input.
          </p>
        )}
        <ul className="wg-search-result-list">
          {capture.data.items.map((hit) => (
            <li
              className="wg-search-result"
              key={`${hit.event_ref.session_id}:${hit.event_ref.sequence}`}
            >
              <Button
                className="wg-search-result-title"
                data-search-position={`history:${hit.event_ref.session_id}:${hit.event_ref.sequence}`}
                onClick={() => {
                  controller.position(
                    `history:${hit.event_ref.session_id}:${hit.event_ref.sequence}`,
                  );
                  go(searchRoute({ ...route, projectId: null }, capture, hit));
                }}
              >
                <span className="wg-search-result-heading">
                  <Icon name="history" />
                  {hit.event_ref.session_id} · event {hit.event_ref.sequence}
                </span>
                <Badge>{hit.kind}</Badge>
              </Button>
              <p>{hit.snippet}</p>
              <small>
                {hit.role} · byte offset {hit.byte_offset} · pinned head
              </small>
            </li>
          ))}
        </ul>
        {capture.data.items.length === 0 && (
          <div className="wg-search-no-results">
            <Icon name="history" />
            <h3>No matching events on this page</h3>
            <p>
              Try different text or remove the session filter. If indexing is incomplete or another
              page is available, this does not mean the whole history has no matches.
            </p>
          </div>
        )}
        <Button
          disabled={
            !capture.data.has_more || capture.data.next === null || state.history.kind === "loading"
          }
          onClick={() => {
            void controller.history(matchingHistory.scope, matchingHistory.requestedQuery, true);
          }}
        >
          Next scanned history page
        </Button>
        <details className="wg-search-coverage">
          <summary>Per-session index coverage</summary>
          <ul>
            {capture.data.coverage.map((item) => (
              <li key={item.session_id}>
                {item.session_id} · indexed through {item.indexed_through} / committed through{" "}
                {item.committed_through}
              </li>
            ))}
          </ul>
        </details>
      </section>
    );
  }
  return (
    <div className="wg-search-feature" ref={root}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
        className="wg-search-query"
      >
        <div className="wg-search-scope">
          <Icon name="connection" />
          <strong>{connection?.label ?? "No connection selected"}</strong>
          <span>
            generation {connection?.generation ?? "—"} · workspace{" "}
            {route.workspaceId ?? "not selected"}
            {route.projectId !== null
              ? ` · project ${route.projectId}`
              : " · all workspace projects"}
          </span>
        </div>
        <div className="wg-search-input-row">
          <Field
            label={mode === "jump" ? "Find in current scope" : "Search text"}
            value={draft.text}
            onChange={(event) => edit({ text: event.target.value })}
            placeholder="Try a ticket title, a decision, or a resource name…"
          />
          <Button
            type="submit"
            tone="primary"
            disabled={
              scope === null ||
              draft.text.trim() === "" ||
              state.planning.kind === "loading" ||
              state.history.kind === "loading" ||
              (draft.domain === "planning" && draft.kinds.length === 0)
            }
          >
            Search
          </Button>
        </div>
        <Select
          label="Search domain"
          value={draft.domain}
          onChange={(event) =>
            edit({ domain: event.target.value === "history" ? "history" : "planning" })
          }
        >
          <option value="planning">Planning, comments, resources and facts</option>
          <option value="history">Imported history · exact capture</option>
        </Select>
        {draft.domain === "planning" ? (
          <details className="wg-search-filters">
            <summary>
              {draft.kinds.length} source kinds ·{" "}
              {draft.includeArchived ? "including archived" : "active records"}
            </summary>
            <p>
              Choose which records to include. Resource details searches names and descriptions;
              Resource text searches indexed file content. Archived records are set aside from
              active work, not deleted.
            </p>
            <div className="wg-search-filter-presets">
              <Button onClick={() => edit({ kinds: kinds.map(([kind]) => kind) })}>
                All sources
              </Button>
              <Button onClick={() => edit({ kinds: ["ticket"] })}>Tickets only</Button>
              <Button onClick={() => edit({ kinds: ["resource", "resource_text", "fact"] })}>
                Resources &amp; facts
              </Button>
            </div>
            <div className="wg-search-kind-grid">
              {kinds.map(([kind, label]) => (
                <label key={kind}>
                  <input
                    type="checkbox"
                    checked={draft.kinds.includes(kind)}
                    onChange={(event) =>
                      edit({
                        kinds: event.target.checked
                          ? [...draft.kinds, kind]
                          : draft.kinds.filter((value) => value !== kind),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            <label>
              <input
                type="checkbox"
                checked={draft.includeArchived}
                onChange={(event) => edit({ includeArchived: event.target.checked })}
              />
              Include archived records
            </label>
          </details>
        ) : (
          <>
            <Field
              label="History session ID (optional)"
              value={draft.sessionId}
              onChange={(event) => edit({ sessionId: event.target.value })}
            />
            <p className="wg-hint">
              History searches imported events across this workspace, regardless of the selected
              project. Enter a session ID to narrow it to one conversation. Results retain the exact
              saved history version searched.
            </p>
          </>
        )}
        {draft.domain === "planning" && draft.kinds.length === 0 && (
          <p role="status">Choose at least one source type to search.</p>
        )}
        {scope === null && (
          <p role="status">
            Choose a connection and workspace to run a live search. Recent typed links remain
            available offline.
          </p>
        )}
      </form>
      <ReadStatus<unknown> state={draft.domain === "planning" ? state.planning : state.history} />
      {state.issue !== null && <p role="alert">{failureText(state.issue)}</p>}
      {state.opening && <p role="status">Resolving the exact result destination…</p>}
      {state.persistenceIssue !== null && <p role="alert">{state.persistenceIssue}</p>}
      {body}
      {mode === "jump" && (
        <div className="wg-search-jump-links">
          <Recent
            routes={state.recent}
            open={(target) => {
              edit({ paste: routeHref(target) });
              const profile = context.profiles.find((value) => value.id === target.connectionId);
              if (target.connectionId === null || profile !== undefined) go(target);
              else setLinkOpen(true);
            }}
            clear={controller.clearRecent}
          />
          <details
            className="wg-search-link-card"
            open={linkOpen}
            onToggle={(event) => setLinkOpen(event.currentTarget.open)}
          >
            <summary>
              <Icon name="connection" /> Open a Workgraph link
            </summary>
            <section aria-label="Open a typed link">
              <p className="wg-hint">
                Paste a link copied from Workgraph to open a particular view or record. A link from
                another setup may need you to choose its matching local connection.
              </p>
              <Field
                label="Paste a Workgraph link"
                value={draft.paste}
                placeholder="#/work?connection=…"
                onChange={(event) => edit({ paste: event.target.value })}
              />
              {paste !== null && !paste.ok && <p role="alert">{paste.message}</p>}
              {paste?.ok && (
                <>
                  <p className="wg-hint">
                    {routeLabel(paste.route)} · endpoint {paste.route.connectionId ?? "unscoped"}. A
                    pasted host does not prove the original endpoint.
                  </p>
                  {unknown ? (
                    <>
                      <p role="status">
                        This connection ID is unknown locally. Choose a profile explicitly to map
                        the link.
                      </p>
                      <Select
                        label="Map endpoint to saved profile"
                        value={mapping}
                        onChange={(event) => setMapping(event.target.value)}
                      >
                        <option value="">Choose profile and generation</option>
                        {context.profiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.label} · generation {profile.generation}
                          </option>
                        ))}
                      </Select>
                      <Button
                        disabled={mapped === undefined}
                        onClick={() => {
                          if (mapped !== undefined) go(mapEndpoint(paste.route, mapped));
                        }}
                      >
                        Map to selected endpoint and open
                      </Button>
                    </>
                  ) : (
                    <Button onClick={() => go(paste.route)}>Open exact typed link</Button>
                  )}
                </>
              )}
            </section>
          </details>
        </div>
      )}
      {footer}
    </div>
  );
}
