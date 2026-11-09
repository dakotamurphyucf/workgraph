import { useActorGate } from "../../../components/ActorAccess";
import { Dialog } from "../../../components/Dialog";
import { Icon } from "../../../components/Icon";
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { Badge, Button, Field, Select, Toolbar, StatePanel } from "../../../components/Primitives";
import * as d from "../../../core/protocol/decoders";
import type { Identifier } from "../../../core/protocol/types";
import { WorkActionsFeature } from "../../work/actions";
import type { WorkCollectionContext, WorkFilters } from "../../work/read-model.types";
import { ReadStatus } from "../../work/views/ReadPresentation";
import { GraphCanvas } from "./Canvas";
import { RELATION_LABEL } from "./labels";
import { GRAPH_LIMITS, focusedNodes, relationAction, ticketCapture } from "./model";
import { RelationComposer } from "./RelationComposer";
import { Relationships, type RelationEdit } from "./Relationships";
import type { GraphFeatureProps, GraphState, RelationKind } from "./types";
import "./graph.css";
import "./graph-polish.css";

function Query({
  collection,
  launch,
}: {
  readonly collection: WorkCollectionContext;
  readonly launch: (task: Promise<void>) => void;
}) {
  const filters = collection.state?.filters,
    [text, setText] = useState(filters?.text ?? ""),
    [milestone, setMilestone] = useState(filters?.milestoneId ?? ""),
    [archived, setArchived] = useState(filters?.includeArchived ?? false),
    [error, setError] = useState("");
  function apply(event: FormEvent) {
    event.preventDefault();
    if (filters === undefined) return;
    if (new TextEncoder().encode(text).byteLength > 256) {
      setError("Search must be at most 256 UTF-8 bytes.");
      return;
    }
    if (milestone !== "" && !d.identifier.decode(d.jsonString(milestone)).ok) {
      setError("Use a valid milestone identifier, or clear the field.");
      return;
    }
    setError("");
    launch(
      collection.controller.setFilters({
        ...filters,
        text,
        milestoneId: milestone,
        includeArchived: archived,
      }),
    );
  }
  const active =
    filters === undefined
      ? []
      : Object.entries(filters).filter(([key, value]) => key !== "includeArchived" && value !== "");
  return (
    <form className="graph-query" onSubmit={apply} aria-label="Graph query">
      <Field
        label="Filter graph tickets"
        value={text}
        placeholder="Title or instructions…"
        onChange={(event) => setText(event.target.value)}
      />
      <Field
        label="Milestone ID"
        value={milestone}
        placeholder="All milestones"
        onChange={(event) => setMilestone(event.target.value)}
      />
      <label>
        <input
          type="checkbox"
          checked={archived}
          onChange={(event) => setArchived(event.target.checked)}
        />{" "}
        Include archived
      </label>
      <Button type="submit" disabled={collection.disabled || filters === undefined}>
        Apply graph query
      </Button>
      <Button
        disabled={collection.disabled || filters === undefined}
        onClick={() => {
          if (filters === undefined) return;
          const clear: WorkFilters = {
            text: "",
            status: "",
            priority: "",
            assigneeId: "",
            labelId: "",
            milestoneId: "",
            includeArchived: true,
          };
          setText("");
          setMilestone("");
          setArchived(true);
          launch(collection.controller.setFilters(clear));
        }}
      >
        Show all project records
      </Button>
      <p className="wg-hint graph-query-summary">
        {active.length === 0
          ? "No ticket filters"
          : active
              .map(([key, value]) => `${key.replaceAll("Id", "")}: ${String(value)}`)
              .join(" · ")}{" "}
        · {archived ? "archived included" : "archived excluded"}. Off-view references remain
        explicit.
      </p>
      {error && (
        <p className="wg-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function Inheritance({
  state,
  props,
  launch,
}: {
  readonly state: GraphState;
  readonly props: GraphFeatureProps;
  readonly launch: (task: Promise<void>) => void;
}) {
  const unknown = state.projection.unknownAncestry;
  return (
    <div className="graph-inheritance">
      <p>
        Parent tickets can pass prerequisite rules down to their children. Workgraph loads the
        needed parent records and policies automatically, including parents outside the current
        project filter.
      </p>
      <p role="status">
        {state.ancestryLoading
          ? "Loading parent tickets and inherited rules…"
          : unknown.length === 0
            ? "All parent chains for these tickets have been loaded."
            : `${unknown.length} tickets still need parent information.`}
      </p>
      <p className="wg-hint">
        Inherited arrows show recorded relationships, including completed or waived prerequisites.
        They are not a separate readiness check.
      </p>
      {state.ancestryIssue && (
        <p className="graph-notice" role="status">
          {state.ancestryIssue}
        </p>
      )}
      {unknown.length > 0 && !state.ancestryLoading && (
        <Button
          disabled={props.context.profileState !== "current"}
          onClick={() => launch(props.controller.loadAncestry())}
        >
          Retry loading parent information
        </Button>
      )}
    </div>
  );
}

function GraphCollection({
  props,
  collection,
  state,
}: {
  readonly props: GraphFeatureProps;
  readonly collection: WorkCollectionContext;
  readonly state: GraphState;
}) {
  const allowNewAction = useActorGate();
  const [keyText, setKeyText] = useState(""),
    [tracedTicket, setTracedTicket] = useState<Identifier | null>(null),
    [dialog, setDialog] = useState<"query" | "display" | null>(null),
    [unexpected, setUnexpected] = useState<{ readonly error: unknown } | null>(null);
  const view =
    props.context.route.section?.view === "workflow" &&
    props.context.route.section.value === "relationships"
      ? "relationships"
      : "graph";
  const launch = (task: Promise<void>) => {
    void task.catch((error: unknown) => setUnexpected({ error }));
  };
  if (unexpected !== null) throw unexpected.error;
  if (state.unexpected !== null) throw state.unexpected.error;
  const matching =
      collection.state !== null &&
      state.scope !== null &&
      state.scope.connection.id === collection.scope.connection.id &&
      state.scope.connection.generation === collection.scope.connection.generation &&
      state.scope.workspaceId === collection.scope.workspaceId &&
      state.scope.projectId === collection.scope.projectId,
    graph = matching ? state : null,
    selected = collection.selected?.value.ticket.ticket_id ?? null,
    pages = graph?.pages ?? [],
    last = pages.at(-1),
    complete =
      last?.value.remaining === "0" &&
      last.controls.find((control) => control.path === "/data")?.complete === true,
    count = pages.reduce((n, page) => n + page.value.items.length, 0),
    disabled = collection.disabled;
  const ancestryCapture = graph?.pages[0]?.id ?? null;
  useEffect(() => {
    if (ancestryCapture !== null && props.context.profileState === "current")
      void props.controller.loadAncestry();
  }, [ancestryCapture, props.controller, props.context.profileState]);
  function edit(intent: RelationEdit) {
    if (graph === null || collection.disabled || !allowNewAction()) return;
    const captured = ticketCapture(graph, intent.target);
    if (captured === null) return;
    const id = props.actions.open(collection.context, intent.method, {
      scope: collection.scope,
      ticket: captured,
    });
    if (id === null) return;
    if (intent.other !== undefined)
      props.actions.edit(
        id,
        intent.method.startsWith("related.") ? "related_id" : "prerequisite_id",
        { kind: "scalar", presence: "value", text: intent.other },
      );
    if (intent.clearParent)
      props.actions.edit(id, "parent_ticket_id", { kind: "scalar", presence: "null", text: "" });
    collection.select(intent.target);
  }
  const selectedPolicy = selected === null ? undefined : graph?.policies.get(selected),
    subtree =
      graph && selected !== null ? focusedNodes(graph.projection, selected, "subtree") : null;
  return (
    <div className="graph-main">
      <div className="graph-filterbar">
        <div className="graph-topbar-actions">{collection.toolbarActions}</div>
        <span className="work-scope-chip">
          <Icon name="workflow" />
          {collection.scope.projectId ?? "All projects"}
        </span>
        <Button tone="quiet" onClick={() => setDialog("query")}>
          <Icon name="filter" />
          Filter
        </Button>
        <Button tone="quiet" onClick={() => setDialog("display")}>
          Display
        </Button>
        {graph && (
          <Button
            tone="primary"
            requiresActor={graph.composer === null}
            disabled={
              graph.composer === null &&
              (disabled || graph.projection.nodes.filter((n) => n.record !== null).length < 2)
            }
            onClick={() =>
              props.controller.compose(
                collection.context,
                selected === null ? {} : { to: selected },
              )
            }
          >
            {graph.composer === null ? "Add relation" : "Resume relationship draft"}
          </Button>
        )}
        <span className="graph-count">
          {count} loaded tickets{complete ? "" : " · partial query"}
        </span>
        <Button
          tone="quiet"
          aria-label="Refresh graph"
          disabled={collection.disabled}
          onClick={() => launch(collection.controller.refresh())}
        >
          <Icon name="refresh" />
        </Button>
      </div>
      <div className="graph-body">
        {collection.disabled && (
          <p className="graph-notice" role="status">
            Connection profile {collection.context.profileState}. Captured graph is retained; new
            reads and actions resume only on its exact current profile.
          </p>
        )}
        {collection.state && <ReadStatus state={collection.state.list} label="Graph ticket page" />}
        {graph?.issue && (
          <p role="alert" className="wg-error">
            {graph.issue}
          </p>
        )}
        {graph && (
          <>
            {dialog === "query" && (
              <Dialog
                title="Filter workflow"
                description="Choose the tickets to display. References outside your query remain visible."
                onClose={() => setDialog(null)}
                wide
              >
                <div className="graph-capture-strip">
                  <Badge tone={complete ? "neutral" : "warning"}>
                    {complete ? "Query pages loaded" : "Partial query capture"}
                  </Badge>
                  <span>
                    {count} query tickets · {graph.expanded.size} expanded references · revision{" "}
                    {graph.revision ?? "not captured"}
                  </span>
                  <span>
                    {last
                      ? `${last.value.remaining} query tickets remain after the last page`
                      : "No page captured"}
                  </span>
                </div>
                {collection.state && (
                  <Query
                    key={state.queryKey ?? "pending"}
                    collection={collection}
                    launch={launch}
                  />
                )}
                <p className="graph-capture-note">
                  This is a projection of returned records, not a complete workspace cycle analysis.
                  Hidden layers, filters and off-view records never clear native blockers. The
                  daemon validates every final edit.
                </p>
              </Dialog>
            )}
            {graph.projection.asymmetricRelatedPairs > 0 && (
              <p className="wg-error" role="alert">
                {graph.projection.asymmetricRelatedPairs} captured related declarations disagree
                with their loaded inverse. Treat this projection as inconsistent and refresh before
                editing those links.
              </p>
            )}
            {(graph.projection.omittedRelations > 0 ||
              graph.projection.omittedBoundaryNodes > 0) && (
              <p className="graph-notice">
                Presentation budget: {graph.projection.omittedRelations} relations and{" "}
                {graph.projection.omittedBoundaryNodes} boundary references are not drawn. Narrow
                the query or inspect the actual ticket. Loaded source pages remain retained.
              </p>
            )}

            {dialog === "display" && (
              <Dialog
                title="Graph display"
                description="Choose relationships, focus, and layout. These settings only change this view."
                onClose={() => setDialog(null)}
                wide
              >
                <div className="graph-display-settings">
                  <section className="graph-layer-options">
                    <h3>Which connections should appear?</h3>
                    <p className="work-section-help">
                      Prerequisites set the order of work. Inherited prerequisites come from a
                      parent’s rules. Parent / child groups tasks; related links provide context.
                      Hiding a line changes only the picture, never the underlying rule.
                    </p>
                    <div className="graph-layers">
                      {(["prerequisite", "inherited", "hierarchy", "related"] as const).map(
                        (kind: RelationKind) => (
                          <label key={kind}>
                            <input
                              type="checkbox"
                              checked={graph.layers[kind]}
                              onChange={(event) =>
                                props.controller.present({
                                  layers: { [kind]: event.target.checked },
                                })
                              }
                            />
                            <span
                              className={`graph-relation-swatch graph-relation-swatch--${kind}`}
                            />
                            {RELATION_LABEL[kind]}
                          </label>
                        ),
                      )}
                    </div>
                    <Select
                      label="Group tickets by"
                      value={graph.grouping}
                      onChange={(event) => {
                        const grouping = (["project", "milestone", "none"] as const).find(
                          (v) => v === event.target.value,
                        );
                        if (grouping) props.controller.present({ grouping });
                      }}
                    >
                      <option value="project">Project</option>
                      <option value="milestone">Milestone</option>
                      <option value="none">No lanes</option>
                    </Select>
                  </section>
                  <p className="work-section-help">
                    When you select a ticket, highlight its whole connected tree or a narrower path.
                    Other tickets remain visible but dimmed.
                  </p>
                  <Select
                    label="Focus on"
                    value={graph.focus}
                    onChange={(event) => {
                      const focus = (
                        [
                          "connected",
                          "neighbors",
                          "ancestors",
                          "downstream",
                          "subtree",
                          "all",
                        ] as const
                      ).find((v) => v === event.target.value);
                      if (focus) props.controller.present({ focus });
                    }}
                  >
                    <option value="connected">Entire connected tree</option>
                    <option value="neighbors">Selected + neighbors</option>
                    <option value="ancestors">Prerequisite ancestors</option>
                    <option value="downstream">Downstream dependents</option>
                    <option value="subtree">Parent subtree</option>
                    <option value="all">All loaded tickets</option>
                  </Select>
                  <details className="graph-edit-options">
                    <summary>Arrange the graph and find a ticket</summary>
                    <p className="work-section-help">
                      Zoom is also available directly above the graph. Moving cards and resetting
                      their layout never changes tickets or dependencies. Use a ticket key to locate
                      work outside the current view.
                    </p>
                    <Toolbar label="Graph editing and local layout">
                      <Button
                        disabled={graph.zoom <= 0.25}
                        onClick={() =>
                          props.controller.present({ zoom: Math.max(0.25, graph.zoom - 0.15) })
                        }
                      >
                        Zoom out
                      </Button>
                      <span>{Math.round(graph.zoom * 100)}%</span>
                      <Button
                        disabled={graph.zoom >= 2}
                        onClick={() =>
                          props.controller.present({ zoom: Math.min(2, graph.zoom + 0.15) })
                        }
                      >
                        Zoom in
                      </Button>
                      <Button onClick={() => props.controller.resetLayout()}>Reset layout</Button>
                      <form
                        className="graph-jump"
                        onSubmit={(event) => {
                          event.preventDefault();
                          launch(
                            (async () => {
                              const id = await props.controller.resolve(keyText);
                              if (id !== null) {
                                await props.controller.expand(id);
                                setTracedTicket(id);
                                setDialog(null);
                              }
                            })(),
                          );
                        }}
                      >
                        <Field
                          label="Jump to display key"
                          value={keyText}
                          placeholder="WG-42"
                          onChange={(event) => setKeyText(event.target.value)}
                        />
                        <Button
                          type="submit"
                          disabled={collection.disabled || graph.resolutionRead.kind === "loading"}
                        >
                          Resolve ticket
                        </Button>
                      </form>
                    </Toolbar>
                  </details>
                </div>
              </Dialog>
            )}
            {graph.resolutionRead.kind !== "idle" && (
              <ReadStatus state={graph.resolutionRead} label="Display key resolution" />
            )}
            {graph.referenceRead.kind !== "idle" && (
              <ReadStatus state={graph.referenceRead} label="Expanded graph reference" />
            )}
            {graph.policyRead.kind !== "idle" && (
              <ReadStatus state={graph.policyRead} label="Hierarchy policy" />
            )}
            {count === 0 && pages.length > 0 && (
              <StatePanel kind="empty" title="No tickets match this graph query">
                <p>Clear the ticket filters or create a ticket to begin connecting work.</p>
              </StatePanel>
            )}
            {view === "graph" && (
              <GraphCanvas
                state={graph}
                inspectRelation={(edge) => {
                  collection.controller.setPresentation({ tab: "relationships" });
                  collection.select(edge.kind === "inherited" ? edge.source : edge.to);
                }}
                interactionKey={JSON.stringify([
                  graph.queryKey,
                  graph.revision,
                  graph.pages[0]?.id,
                  collection.context.writer.actorId,
                  collection.context.writer.runId,
                ])}
                controller={props.controller}
                selected={tracedTicket}
                select={setTracedTicket}
                openTicket={collection.select}
                connect={(from, to) => {
                  if (allowNewAction())
                    props.controller.compose(collection.context, {
                      kind: "prerequisite",
                      from,
                      to,
                    });
                }}
              />
            )}
            <details className="graph-advanced-details">
              <summary>Hierarchy and inherited rules</summary>
              <Inheritance state={graph} props={props} launch={launch} />
            </details>
            {selected !== null && collection.selected && (
              <div className="graph-selected-context">
                <span>
                  Selected <strong>{collection.selected.value.ticket.display_key}</strong> · actual
                  project {collection.selected.value.ticket.project_id ?? "none"} ·{" "}
                  {subtree?.size ?? 0} loaded subtree records{" "}
                  {complete ? "in this query capture" : "(incomplete capture)"}
                </span>
                <Button
                  disabled={collection.disabled}
                  onClick={() => launch(props.controller.policy(selected))}
                >
                  Capture selected hierarchy policy
                </Button>
                <Button
                  requiresActor
                  disabled={disabled}
                  onClick={() => edit({ method: "ticket.move", target: selected })}
                >
                  Review moving subtree
                </Button>
                <Button
                  requiresActor
                  disabled={disabled}
                  onClick={() => edit({ method: "ticket.hierarchy.put", target: selected })}
                >
                  Review hierarchy rules
                </Button>
                {selectedPolicy && (
                  <p className="wg-hint">
                    Stored policy revision {selectedPolicy.value.policy?.revision ?? "0"} ·
                    inheritance {selectedPolicy.value.effective.descendant_prerequisites} · child
                    completion {selectedPolicy.value.effective.child_completion} · planning capture{" "}
                    {selectedPolicy.revision}
                  </p>
                )}
                <p className="wg-hint">
                  Moving a ticket atomically updates its descendants. Changing project clears
                  descendant milestone assignments; inherited blockers are recomputed. Loaded
                  subtree counts are not a promise that hidden descendants are absent.
                </p>
              </div>
            )}
            {view === "relationships" && (
              <Relationships
                state={graph}
                selected={selected}
                select={collection.select}
                edit={edit}
                disabled={disabled}
              />
            )}
            {last?.controls.some((c) => c.next !== null || c.retry !== null) && (
              <Toolbar label="Captured graph pagination">
                <Button
                  disabled={
                    collection.disabled ||
                    collection.state?.list.kind === "loading" ||
                    count >= GRAPH_LIMITS.tickets ||
                    !last?.controls.some((c) => c.path === "/data" && c.next !== null)
                  }
                  onClick={() => launch(collection.controller.page("next"))}
                >
                  Load next captured page
                </Button>
                <Button
                  disabled={
                    collection.disabled ||
                    !last?.controls.some((c) => c.path === "/data" && c.retry !== null)
                  }
                  onClick={() => launch(collection.controller.page("retry"))}
                >
                  Retry captured page
                </Button>
              </Toolbar>
            )}
          </>
        )}
      </div>
      {!graph && <p role="status">Loading the exact workflow scope…</p>}
      {graph && pages.length === 0 && collection.state?.list.kind === "ready" && (
        <p>No graph records were captured.</p>
      )}
    </div>
  );
}

export function GraphFeature(props: GraphFeatureProps) {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.get);
  return (
    <>
      <WorkActionsFeature
        context={props.context}
        readController={props.readController}
        controller={props.actions}
        operations={props.operations}
        {...(props.askTicket === undefined ? {} : { askTicket: props.askTicket })}
        {...(props.renderProgress === undefined ? {} : { renderProgress: props.renderProgress })}
        {...(props.renderInspectorSections === undefined
          ? {}
          : { renderInspectorSections: props.renderInspectorSections })}
        renderCollection={(collection) => (
          <GraphCollection
            key={state.queryKey ?? "pending"}
            props={props}
            collection={collection}
            state={state}
          />
        )}
      />
      {state.composer !== null && state.composerOpen && (
        <RelationComposer
          draft={state.composer}
          currentCaptureId={state.pages[0]?.id ?? null}
          currentContext={props.context}
          close={props.controller.closeComposer}
          hide={props.controller.hideComposer}
          edit={props.controller.editComposer}
          review={() => {
            const draft = state.composer;
            if (draft === null) return;
            const action = relationAction(draft);
            const id = props.actions.open(action.context, action.method, action.target);
            if (id === null) return;
            for (const [field, input] of action.edits) props.actions.edit(id, field, input);
            props.controller.closeComposer();
          }}
        />
      )}
    </>
  );
}
