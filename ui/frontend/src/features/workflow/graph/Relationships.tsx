import { useState } from "react";
import { Badge, Button } from "../../../components/Primitives";
import type { Identifier } from "../../../core/protocol/types";
import type { WorkCommand } from "../../work/actions/types";
import { RELATION_LABEL } from "./labels";
import type { GraphRelation, GraphState } from "./types";

export interface RelationEdit {
  readonly method: WorkCommand;
  readonly target: Identifier;
  readonly other?: Identifier;
  readonly clearParent?: boolean;
}
export function Relationships({
  state,
  selected,
  select,
  edit,
  disabled,
}: {
  readonly state: GraphState;
  readonly selected: Identifier | null;
  readonly select: (id: Identifier) => void;
  readonly edit: (intent: RelationEdit) => void;
  readonly disabled: boolean;
}) {
  const [all, setAll] = useState(false),
    [page, setPage] = useState(0);
  const relations = state.projection.relations.filter(
      (edge) =>
        all ||
        selected === null ||
        edge.from === selected ||
        edge.to === selected ||
        edge.source === selected,
    ),
    offset = Math.min(page * 100, Math.max(0, Math.floor((relations.length - 1) / 100) * 100)),
    rows = relations.slice(offset, offset + 100);
  const nodeLabel = (id: Identifier) =>
    state.projection.nodes.find((n) => n.id === id)?.record?.ticket.display_key ?? id;
  const nodeTitle = (id: Identifier) =>
    state.projection.nodes.find((n) => n.id === id)?.record?.ticket.title ??
    "Ticket outside this view";
  function controls(edge: GraphRelation) {
    const target =
        edge.kind === "related" ? edge.from : edge.kind === "hierarchy" ? edge.to : edge.source,
      captured = state.projection.nodes.some((node) => node.id === target && node.record !== null);
    if (!captured) return <Button onClick={() => select(target)}>Capture source {target}</Button>;
    if (edge.kind === "hierarchy")
      return (
        <Button
          disabled={disabled}
          onClick={() => edit({ method: "ticket.move", target, clearParent: true })}
        >
          Remove parent
        </Button>
      );
    if (edge.kind === "related")
      return (
        <Button
          disabled={disabled}
          onClick={() => edit({ method: "related.remove", target, other: edge.to })}
        >
          Unlink tickets
        </Button>
      );
    return (
      <>
        {edge.kind === "inherited" && (
          <Button onClick={() => select(edge.source)}>Inspect declaring source</Button>
        )}
        <Button
          disabled={disabled}
          onClick={() => edit({ method: "dependency.waive", target, other: edge.from })}
        >
          {edge.waiver === null
            ? "Allow work without this prerequisite"
            : "Require this prerequisite again"}
        </Button>
        <Button
          disabled={disabled}
          onClick={() => edit({ method: "dependency.remove", target, other: edge.from })}
        >
          Remove dependency
        </Button>
      </>
    );
  }
  return (
    <section className="graph-relationships" aria-label="Keyboard relationships">
      <header>
        <div>
          <h3>Relationships</h3>
          <p className="wg-hint">
            See which tasks must finish first, which belong together and which are linked for
            context. Select a ticket to read its conversation. Each edit opens a review before
            anything changes.
          </p>
        </div>
        <label>
          <input
            type="checkbox"
            checked={all}
            onChange={(event) => {
              setAll(event.target.checked);
              setPage(0);
            }}
          />{" "}
          All loaded tickets
        </label>
      </header>
      <p className="wg-hint">
        {relations.length} loaded relationships ·{" "}
        {selected === null || all ? "all captured tickets" : `selected ${nodeLabel(selected)}`} ·
        rows {relations.length === 0 ? 0 : offset + 1}–{offset + rows.length}
      </p>
      {rows.length === 0 ? (
        <p>
          No relationships in this loaded selection. Incomplete captures may omit other
          relationships.
        </p>
      ) : (
        <div className="graph-table-scroll">
          <table>
            <thead>
              <tr>
                <th>From</th>
                <th>Relationship</th>
                <th>To</th>
                <th>Declaring source / effect</th>
                <th>Review action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((edge) => (
                <tr key={edge.id} data-relation-kind={edge.kind}>
                  <td>
                    <Button tone="quiet" onClick={() => select(edge.from)}>
                      {nodeLabel(edge.from)}
                    </Button>
                    <span>{nodeTitle(edge.from)}</span>
                  </td>
                  <td>
                    <span className={`graph-relation-swatch graph-relation-swatch--${edge.kind}`} />
                    {RELATION_LABEL[edge.kind]}
                  </td>
                  <td>
                    <Button tone="quiet" onClick={() => select(edge.to)}>
                      {nodeLabel(edge.to)}
                    </Button>
                    <span>{nodeTitle(edge.to)}</span>
                  </td>
                  <td>
                    <Button tone="quiet" onClick={() => select(edge.source)}>
                      {nodeLabel(edge.source)}
                    </Button>
                    {edge.kind === "related" ? (
                      <span>Informational · no readiness effect</span>
                    ) : edge.kind === "hierarchy" ? (
                      <span>Placement · no implicit prerequisite</span>
                    ) : edge.waiver === null ? (
                      <span>Declared edge · daemon evaluates blocking</span>
                    ) : (
                      <>
                        <Badge tone="warning">Waived at source</Badge>
                        <span>{edge.waiver.reason}</span>
                      </>
                    )}
                  </td>
                  <td>
                    <div className="graph-row-actions">{controls(edge)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="graph-table-pages">
        <Button disabled={offset === 0} onClick={() => setPage(Math.max(0, page - 1))}>
          Previous relationships
        </Button>
        <Button
          disabled={offset + rows.length >= relations.length}
          onClick={() => setPage(Math.floor(offset / 100) + 1)}
        >
          Next relationships
        </Button>
      </div>
    </section>
  );
}
