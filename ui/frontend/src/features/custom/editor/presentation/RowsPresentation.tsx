import { useState } from "react";
import { Button } from "../../../../components/Primitives";
import type { LoadedRow } from "../../config";
import { coveredCell, groupRows, timelineGroups, filteredRows } from "./model";
import { Cell } from "./Cell";
import type { RowsPresentationProps } from "./types";
import { resourceScopeDescription } from "../scope-description";
import "./presentation.css";
const PAGE = 100;
export function RowsPresentation(props: RowsPresentationProps) {
  const { view, rows, coverage, processing, identity } = props;
  const [position, setPosition] = useState({ view, rows, identity, offset: 0 });
  const offset =
    position.view === view && position.rows === rows && position.identity === identity
      ? position.offset
      : 0;
  const { matches: transformed, notEvaluated } = filteredRows(view, rows, coverage),
    visible = transformed.slice(offset, offset + PAGE);
  const board = view.presentation === "board" && view.group_by !== null,
    timeline = view.presentation === "timeline" && view.source === "sessions";
  const unsupported =
    (view.presentation === "board" && !board) || (view.presentation === "timeline" && !timeline);
  const groups = timeline ? timelineGroups(visible, view) : groupRows(visible, view.group_by);
  const statusLabels: Readonly<Record<string, string>> = {
    backlog: "Backlog",
    todo: "To do",
    in_progress: "In progress",
    done: "Done",
    canceled: "Canceled",
  };
  const groupLabel = (label: string) =>
    view.source === "tickets" && view.group_by === "status"
      ? (statusLabels[label] ?? label)
      : label;
  function rowTitle(row: LoadedRow) {
    const available = props.onOpenRow !== undefined && (props.canOpenRow?.(row) ?? true);
    return available ? (
      <Button onClick={() => props.onOpenRow?.(row)}>{row.identity}</Button>
    ) : (
      <strong>{row.identity}</strong>
    );
  }
  function valueStatus(row: LoadedRow) {
    if (!view.columns.some((column) => column.selector.kind === "pointer")) return null;
    const value = coverage.values?.find((entry) => entry.identity === row.identity);
    return (
      <div className="wg-hint">
        Value: {value?.status ?? "not acquired"}
        {value?.pin !== null && value?.pin !== undefined && (
          <Cell
            {...props}
            result={{ kind: "pin", pin: value.pin }}
            identity={`${identity}:${row.identity}:value-pin`}
            processing={processing}
          />
        )}
      </div>
    );
  }
  function cells(row: LoadedRow) {
    return view.columns.map((column) => (
      <div className="wg-custom-card-field" key={column.id}>
        <dt>{column.label}</dt>
        <dd>
          <Cell
            {...props}
            result={coveredCell(row, column, coverage)}
            identity={`${identity}:${row.identity}:${column.id}`}
            processing={processing}
          />
        </dd>
      </div>
    ));
  }
  return (
    <section className="wg-custom-presentation" aria-label={view.title}>
      <div className="wg-custom-coverage">
        <strong>{view.title}</strong>
        {resourceScopeDescription(view.source, view.scope) !== null && (
          <span>{resourceScopeDescription(view.source, view.scope)}</span>
        )}
        <span>
          {transformed.length} matching / {rows.length} loaded records
        </span>
        <span>
          {coverage.complete
            ? "All collection pages loaded"
            : "More records may remain · this is not the full collection"}
          {coverage.byteCoverage?.kind === "reported"
            ? coverage.byteCoverage.truncated
              ? " · Some returned details were truncated"
              : " · No returned details reported as truncated"
            : coverage.partial
              ? " · Some field details may be missing"
              : ""}
        </span>
        {coverage.byteCoverage?.kind === "not_reported" && (
          <span>{coverage.byteCoverage.message}</span>
        )}
        <details>
          <summary>About these results and their completeness</summary>
          <dl>
            {coverage.capture.map((entry, index) => (
              <div key={index}>
                <dt>{entry.label}</dt>
                <dd>{entry.value}</dd>
              </div>
            ))}
          </dl>
          <p>
            Result boundary: {coverage.stop}. The totals above describe the records loaded here, not
            a workspace-wide count. Loaded filters, sorting and groups apply to those records.
            Missing content can leave some matches unknown.
          </p>
        </details>
      </div>
      {unsupported && (
        <p role="status">
          This layout is not applicable to this source. Showing captured rows as a list.
        </p>
      )}
      {notEvaluated.length > 0 && (
        <div role="status" className="wg-custom-validation">
          <strong>
            {notEvaluated.length} captured {notEvaluated.length === 1 ? "row could" : "rows could"}{" "}
            not be evaluated against pointer filters.
          </strong>
          <p>
            Matching is unknown for these rows; collection traversal does not establish value
            coverage.
          </p>
          <details>
            <summary>Inspect unevaluated rows</summary>
            <ul>
              {notEvaluated.map(({ row, reason }) => (
                <li key={row.identity}>
                  {rowTitle(row)} · {reason}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
      {transformed.length === 0 && (
        <p>
          {notEvaluated.length > 0
            ? "No confirmed matching captured rows; some matches remain unknown."
            : "No loaded records match this view. Try removing a filter or choosing another scope."}{" "}
          {coverage.complete ? "" : "This does not prove the collection is empty."}
        </p>
      )}
      {view.presentation === "table" ? (
        <div className="wg-custom-table-scroll">
          <table>
            <caption>Loaded records · read-only</caption>
            <thead>
              <tr>
                <th scope="col">Record</th>
                {view.columns.map((column) => (
                  <th
                    scope="col"
                    key={column.id}
                    style={column.width === undefined ? undefined : { width: column.width }}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.key}>
                {view.group_by !== null && (
                  <tr>
                    <th scope="rowgroup" colSpan={view.columns.length + 1}>
                      {groupLabel(group.label)} ({group.rows.length} on this page)
                    </th>
                  </tr>
                )}
                {group.rows.map((row) => (
                  <tr key={row.identity}>
                    <th scope="row">
                      {rowTitle(row)}
                      {valueStatus(row)}
                    </th>
                    {view.columns.map((column) => (
                      <td key={column.id}>
                        <Cell
                          {...props}
                          result={coveredCell(row, column, coverage)}
                          identity={`${identity}:${row.identity}:${column.id}`}
                          processing={processing}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      ) : (
        <div className={board ? "wg-custom-board" : "wg-custom-groups"}>
          {groups.map((group) => (
            <section key={group.key} className="wg-custom-group" aria-label={group.label}>
              <h4
                data-status={
                  view.source === "tickets" && view.group_by === "status" ? group.label : undefined
                }
              >
                {groupLabel(group.label)} <small>({group.rows.length} on this page)</small>
              </h4>
              <ul className="wg-custom-card-list">
                {group.rows.map((row) => (
                  <li key={row.identity}>
                    <article>
                      <header>
                        {rowTitle(row)}
                        {valueStatus(row)}
                      </header>
                      {timeline && (
                        <p className="wg-hint">
                          {group.label === "Unknown time"
                            ? "No usable captured timestamp"
                            : "Captured timestamp; not inferred from ordering"}
                        </p>
                      )}
                      <dl>{cells(row)}</dl>
                    </article>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {transformed.length > PAGE && (
        <nav className="wg-toolbar" aria-label="Captured row pages">
          <Button
            disabled={offset === 0}
            onClick={() =>
              setPosition({ view, rows, identity, offset: Math.max(0, offset - PAGE) })
            }
          >
            Previous captured rows
          </Button>
          <span>
            {offset + 1}–{Math.min(offset + PAGE, transformed.length)} of {transformed.length}
          </span>
          <Button
            disabled={offset + PAGE >= transformed.length}
            onClick={() => setPosition({ view, rows, identity, offset: offset + PAGE })}
          >
            Next captured rows
          </Button>
        </nav>
      )}
    </section>
  );
}
