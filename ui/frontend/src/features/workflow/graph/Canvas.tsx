import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from "react";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { STATUS_LABEL } from "../../work/views/labels";
import { Button } from "../../../components/Primitives";
import type { Identifier } from "../../../core/protocol/types";
import {
  focusedNodes,
  layoutGraph,
  nodeHeight,
  visibleGraphNodes,
  graphPositionBounds,
  clampGraphPosition,
} from "./model";
import type { GraphController, GraphRelation, GraphState, GraphPosition } from "./types";

const PORT_TYPE = "application/x-workgraph-prerequisite";
const POSITION_TYPE = "application/x-workgraph-local-position";
export function GraphCanvas({
  state,
  controller,
  selected,
  select,
  openTicket,
  connect,
  interactionKey,
  inspectRelation,
}: {
  readonly state: GraphState;
  readonly controller: GraphController;
  readonly selected: Identifier | null;
  readonly select: (id: Identifier | null) => void;
  readonly openTicket: (id: Identifier) => void;
  readonly connect: (from: Identifier, to: Identifier) => void;
  readonly interactionKey: string;
  readonly inspectRelation: (edge: GraphRelation) => void;
}) {
  const markerId = useId().replaceAll(":", ""),
    layout = useMemo(
      () => layoutGraph(state.projection, state.grouping),
      [state.projection, state.grouping],
    ),
    focus = useMemo(
      () => focusedNodes(state.projection, selected, state.focus),
      [state.projection, selected, state.focus],
    ),
    [connecting, setConnecting] = useState<{
      readonly id: Identifier;
      readonly key: string;
    } | null>(null),
    scroll = useRef<HTMLDivElement>(null),
    lastFocus = useRef<{ selected: Identifier; query: string | null } | null>(null);
  const positions = useMemo(() => {
    const result = new Map(layout.positions);
    for (const [id, position] of state.positions) result.set(id, position);
    return result;
  }, [layout.positions, state.positions]);
  const visible = visibleGraphNodes(state.projection, selected, focus),
    visibleIds = new Set(visible.map((n) => n.id));
  const drawnEdges = state.projection.relations.filter(
    (edge) => state.layers[edge.kind] && visibleIds.has(edge.from) && visibleIds.has(edge.to),
  );
  const edges = drawnEdges.slice(0, 1000);
  const inQuery = new Set(
    state.projection.nodes.filter((node) => node.inQuery).map((node) => node.id),
  );
  const width = Math.max(layout.width, ...[...positions.values()].map((p) => p.x + 316)),
    height = Math.max(
      layout.height,
      ...visible.map((n) => (positions.get(n.id)?.y ?? 0) + nodeHeight(n) + 30),
    );
  const moveBounds = useMemo(() => graphPositionBounds(state.projection), [state.projection]);
  function move(id: Identifier, candidate: GraphPosition) {
    const position = clampGraphPosition(candidate, moveBounds);
    if (position !== null) controller.move(id, position);
  }
  function start(event: DragEvent, type: string, id: Identifier) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(type, JSON.stringify([interactionKey, id]));
  }
  function draggedId(event: DragEvent, type: string): Identifier | null {
    const source = event.dataTransfer.getData(type);
    if (source.length > 2048) return null;
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error: unknown) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
    return Array.isArray(value) && value.length === 2 && value[0] === interactionKey
      ? (state.projection.nodes.find((n) => n.id === value[1])?.id ?? null)
      : null;
  }
  const activeConnection = connecting?.key === interactionKey ? connecting.id : null;
  useEffect(() => {
    if (selected === null) {
      lastFocus.current = null;
      return;
    }
    if (scroll.current === null) return;
    // A passive native refresh rebuilds the projection. Keep the reader's pan
    // unless they change selection or query; do not recenter on each read.
    const previous = lastFocus.current;
    if (previous?.selected === selected && previous.query === state.queryKey) return;
    const position = positions.get(selected);
    if (position === undefined) return;
    lastFocus.current = { selected, query: state.queryKey };
    scroll.current.scrollTo({
      left: Math.max(
        0,
        position.x * state.zoom - scroll.current.clientWidth / 2 + 140 * state.zoom,
      ),
      top: Math.max(0, position.y * state.zoom - 90),
    });
  }, [selected, positions, state.zoom, state.queryKey]);
  return (
    <section className="graph-canvas-section" aria-label="Workflow graph canvas">
      {connecting !== null && (
        <div className="graph-connect-status" role="status">
          {activeConnection === null ? (
            "Connection gesture belongs to an earlier capture or acting identity. Choose a new source."
          ) : (
            <>
              Choose “Waits for” on a dependent ticket. Source: <code>{activeConnection}</code>
            </>
          )}
          <Button onClick={() => setConnecting(null)}>Cancel connection</Button>
        </div>
      )}
      {state.projection.nodes.length > visible.length && (
        <p className="graph-notice">
          Canvas shows {visible.length} of {state.projection.nodes.length} captured references,
          prioritizing the selected trace. The Relationships table retains the loaded relations;
          narrow the query to lay out other tickets.
        </p>
      )}
      {drawnEdges.length > edges.length && (
        <p className="graph-notice">
          Canvas draws {edges.length} of {drawnEdges.length} visible-layer relationships. The paged
          Relationships table retains the projected source relationships.
        </p>
      )}
      <div className="graph-canvas-controls">
        <div className="graph-zoom" role="group" aria-label="Graph zoom">
          <Button
            aria-label="Zoom out"
            disabled={state.zoom <= 0.25}
            onClick={() => controller.present({ zoom: Math.max(0.25, state.zoom - 0.15) })}
          >
            −
          </Button>
          <input
            aria-label="Graph zoom percent"
            type="range"
            min="25"
            max="200"
            step="5"
            value={Math.round(state.zoom * 100)}
            onChange={(e) => controller.present({ zoom: e.currentTarget.valueAsNumber / 100 })}
          />
          <Button
            aria-label="Zoom in"
            disabled={state.zoom >= 2}
            onClick={() => controller.present({ zoom: Math.min(2, state.zoom + 0.15) })}
          >
            +
          </Button>
          <Button
            aria-label="Reset zoom to 100 percent"
            onClick={() => controller.present({ zoom: 1 })}
          >
            {Math.round(state.zoom * 100)}%
          </Button>
        </div>
        <Button
          onClick={() => {
            const target = scroll.current;
            if (target === null) return;
            const maxX = Math.max(
                320,
                ...visible.map((node) => (positions.get(node.id)?.x ?? 0) + 316),
              ),
              maxY = Math.max(
                240,
                ...visible.map((node) => (positions.get(node.id)?.y ?? 0) + nodeHeight(node) + 24),
              );
            controller.present({
              zoom: Math.max(
                0.25,
                Math.min(1, target.clientWidth / maxX, target.clientHeight / maxY),
              ),
            });
            target.scrollTo(0, 0);
          }}
        >
          Fit graph
        </Button>
        <Button
          disabled={selected === null}
          onClick={() => {
            if (selected === null || scroll.current === null) return;
            controller.present({ zoom: 1 });
            const position = positions.get(selected);
            if (position)
              scroll.current.scrollTo({
                left: Math.max(0, position.x - scroll.current.clientWidth / 2 + 140),
                top: Math.max(0, position.y - 90),
              });
          }}
        >
          Center selected ticket
        </Button>
        {selected !== null && <Button onClick={() => select(null)}>Clear trace</Button>}
        <details className="graph-keyboard-help">
          <summary>Canvas help</summary>{" "}
          <p className="wg-hint graph-canvas-help">
            Click a ticket to highlight its connected tree. Choose Open ticket on the card to read
            its conversation. Closing the sidebar keeps the trace. Scroll to pan; use the zoom
            slider or Fit graph to see more. Alt + arrow keys move a focused node locally. Use the
            Relationships table for every edit without dragging.
          </p>
        </details>
      </div>
      <div className="graph-legend">
        <span>
          <i className="graph-relation-swatch" />
          Prerequisite → dependent
        </span>
        <span>
          <i className="graph-relation-swatch graph-relation-swatch--hierarchy" />
          Parent / child
        </span>
        <span>
          <i className="graph-relation-swatch graph-relation-swatch--related" />
          Related
        </span>
        <span>
          {selected === null
            ? "Select a ticket to trace its connections"
            : `${focus.size} tickets highlighted · ${state.focus === "connected" ? "connected tree" : state.focus}`}
        </span>
      </div>
      <div
        className="graph-scroll"
        ref={scroll}
        tabIndex={0}
        aria-label="Scrollable dependency canvas"
        onKeyDown={(event) => {
          if (event.key === "Escape") setConnecting(null);
        }}
      >
        <div
          className="graph-scaled-space"
          style={{ width: width * state.zoom, height: height * state.zoom }}
        >
          <div
            className="graph-scene"
            style={{ width, height, transform: `scale(${state.zoom})` }}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes(POSITION_TYPE)) event.preventDefault();
            }}
            onDrop={(event) => {
              const id = draggedId(event, POSITION_TYPE);
              if (id === null) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              move(id, {
                x: Math.max(0, (event.clientX - rect.left) / state.zoom - 140),
                y: Math.max(0, (event.clientY - rect.top) / state.zoom - 40),
              });
            }}
          >
            {layout.lanes.map((lane) => (
              <div
                key={lane.label}
                className="graph-lane"
                style={{ top: lane.y, height: lane.height, width }}
              >
                <span>{lane.label}</span>
              </div>
            ))}
            <svg
              width={width}
              height={height}
              className="graph-edges"
              role="group"
              aria-label="Drawn relationship paths"
            >
              <defs>
                <marker
                  id={markerId}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                </marker>
              </defs>
              {edges.map((edge) => {
                const from = positions.get(edge.from),
                  to = positions.get(edge.to);
                if (from === undefined || to === undefined) return null;
                const x1 = from.x + 280,
                  y1 = from.y + 52,
                  x2 = to.x,
                  y2 = to.y + 52,
                  bend = Math.max(42, Math.abs(x2 - x1) / 2);
                return (
                  <path
                    key={edge.id}
                    className={`graph-edge graph-edge--${edge.kind} ${edge.waiver === null ? "" : "graph-edge--waived"} ${selected !== null && focus.has(edge.from) && focus.has(edge.to) ? "graph-edge--focused" : ""}`}
                    d={`M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Inspect ${edge.kind} from ${edge.from} to ${edge.to}${edge.waiver === null ? "" : ", waived at source"}`}
                    onClick={() => inspectRelation(edge)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        inspectRelation(edge);
                      }
                    }}
                    markerEnd={
                      edge.kind === "prerequisite" || edge.kind === "inherited"
                        ? `url(#${markerId})`
                        : undefined
                    }
                  />
                );
              })}
            </svg>
            {visible.map((node) => {
              const position = positions.get(node.id);
              if (position === undefined) return null;
              const ticket = node.record?.ticket,
                prerequisites = ticket?.prerequisite_ticket_ids ?? [],
                outside = prerequisites.filter((id) => !inQuery.has(id)).length;
              return (
                <article
                  key={node.id}
                  className={`graph-node ${selected === node.id ? "graph-node--selected" : ""} ${focus.has(node.id) ? "" : "graph-node--dim"} ${ticket === undefined ? "graph-node--boundary" : ""}`}
                  data-status={ticket?.status ?? "unknown"}
                  style={{ left: position.x, top: position.y, height: nodeHeight(node) }}
                >
                  <button
                    type="button"
                    className="graph-node-main"
                    title={ticket?.title ?? node.id}
                    draggable
                    onDragStart={(event) => start(event, POSITION_TYPE, node.id)}
                    aria-label={`Select ${ticket?.display_key ?? node.id}: ${ticket?.title ?? "outside captured view"}`}
                    aria-pressed={selected === node.id}
                    onClick={() => select(node.id)}
                    onKeyDown={(event) => {
                      if (
                        !event.altKey ||
                        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
                      )
                        return;
                      event.preventDefault();
                      move(node.id, {
                        x: Math.max(
                          0,
                          position.x +
                            (event.key === "ArrowRight" ? 24 : event.key === "ArrowLeft" ? -24 : 0),
                        ),
                        y: Math.max(
                          0,
                          position.y +
                            (event.key === "ArrowDown" ? 24 : event.key === "ArrowUp" ? -24 : 0),
                        ),
                      });
                    }}
                  >
                    <span className="graph-node-key">
                      {ticket?.display_key ?? node.id}
                      <span className={`graph-status graph-status--${ticket?.status ?? "unknown"}`}>
                        {ticket ? STATUS_LABEL[ticket.status] : "Reference"}
                      </span>
                    </span>
                    <strong>{ticket?.title ?? "Outside this captured view"}</strong>
                    <span className="graph-node-meta">
                      {ticket && (
                        <ActorAvatar actor={ticket.claim?.actor_id ?? ticket.assignee_id} />
                      )}
                      <span>
                        {ticket?.hold
                          ? "On hold"
                          : outside > 0
                            ? `${outside} prerequisites outside view`
                            : ticket?.claim
                              ? "Claimed"
                              : prerequisites.length > 0
                                ? `${prerequisites.length} prerequisites`
                                : "No prerequisites"}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="graph-node-open"
                    aria-label={`Open ticket ${ticket?.display_key ?? node.id}`}
                    title="Open ticket conversation"
                    onClick={() => openTicket(node.id)}
                  >
                    Open ↗
                  </button>
                  {ticket && (
                    <div className="graph-node-ports" data-connecting={activeConnection !== null}>
                      <Button
                        tone="quiet"
                        draggable
                        onDragStart={(event) => {
                          event.stopPropagation();
                          start(event, PORT_TYPE, node.id);
                        }}
                        onClick={() => setConnecting({ id: node.id, key: interactionKey })}
                        aria-label={`Connect from ${ticket.display_key}`}
                      >
                        From ↗
                      </Button>
                      <Button
                        tone="quiet"
                        aria-label={`Waits for source: ${ticket.display_key}`}
                        onClick={() => {
                          if (activeConnection !== null && activeConnection !== node.id) {
                            connect(activeConnection, node.id);
                            setConnecting(null);
                          }
                        }}
                        onDragOver={(event) => {
                          if (event.dataTransfer.types.includes(PORT_TYPE)) event.preventDefault();
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const from = draggedId(event, PORT_TYPE);
                          if (from !== null && from !== node.id) connect(from, node.id);
                        }}
                      >
                        ↙ Waits for
                      </Button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
