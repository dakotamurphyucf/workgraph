import { useMemo } from "react";
import { ContentViewer, type ContentSource } from "../../../../content";
import { CONTENT_LIMITS } from "../../../../content/limits";
import { JsonView } from "../../../connections/shared";
import { formatCell, selectPointer } from "../../config";
import { Cell } from "./Cell";
import type { ValuePresentationProps } from "./types";
import "./presentation.css";
export function ValuePresentation(props: ValuePresentationProps) {
  const { value, renderer, generic, processing, identity } = props,
    presentation = renderer.presentation;
  const selection =
    presentation.type === "fields"
      ? null
      : selectPointer(
          value,
          presentation.type === "table" ? presentation.rows : presentation.pointer,
        );
  const selected = selection?.kind === "found" ? selection.value : undefined;
  const source = useMemo<ContentSource | null>(() => {
    if (
      (presentation.type !== "markdown" && presentation.type !== "code") ||
      selected?.kind !== "string" ||
      selected.value.length > CONTENT_LIMITS.inputBytes
    )
      return null;
    const bytes = new TextEncoder().encode(selected.value);
    if (bytes.byteLength > CONTENT_LIMITS.inputBytes) return null;
    return {
      key: `${identity}:renderer:${renderer.id}:${presentation.type}`,
      label: renderer.title,
      bytes,
      completeness: "complete",
      hints:
        presentation.type === "markdown"
          ? { mime: "text/markdown", intent: "prose" }
          : {
              language: presentation.type === "code" ? presentation.language : "plain",
              intent: "code",
            },
    };
  }, [selected, presentation, renderer.id, renderer.title, identity]);
  const fallback = (message: string) => (
    <section className="wg-custom-renderer">
      <p role="status">{message} Generic viewer retained.</p>
      {generic}
    </section>
  );
  if (presentation.type === "markdown" || presentation.type === "code")
    return source === null ? (
      fallback(
        selected?.kind === "string"
          ? "Content exceeds the passive preview input budget."
          : "The content pointer is missing or is not text.",
      )
    ) : (
      <ContentViewer key={source.key} source={source} />
    );
  if (presentation.type === "json")
    return selected === undefined ? (
      fallback("The JSON pointer is unavailable.")
    ) : (
      <JsonView
        value={selected}
        identity={`${identity}:json:${renderer.id}`}
        label={renderer.title}
        processing={processing}
      />
    );
  if (presentation.type === "fields") {
    const cells = presentation.fields.map((field) => {
      const selected = selectPointer(value, field.pointer);
      return {
        field,
        result: formatCell(selected.kind === "found" ? selected.value : undefined, field.format),
      };
    });
    const incompatible = cells.some((entry) => entry.result.kind === "unavailable");
    return (
      <section className="wg-custom-renderer">
        <dl className="wg-custom-render-fields">
          {cells.map(({ field, result }, index) => (
            <div key={index}>
              <dt>{field.label}</dt>
              <dd>
                <Cell
                  {...props}
                  processing={processing}
                  identity={`${identity}:field:${renderer.id}:${index}`}
                  result={result}
                />
              </dd>
            </div>
          ))}
        </dl>
        {incompatible && (
          <>
            <p role="status">
              Some selected fields are unavailable or incompatible. Generic viewer retained.
            </p>
            {generic}
          </>
        )}
      </section>
    );
  }
  if (presentation.type !== "table") return fallback("Unsupported presentation.");
  if (selected?.kind !== "array") return fallback("Table rows must select a captured JSON array.");
  return (
    <section className="wg-custom-renderer">
      <div className="wg-custom-table-scroll">
        <table>
          <caption>{renderer.title}</caption>
          <thead>
            <tr>
              {presentation.columns.map((field, index) => (
                <th key={index} scope="col">
                  {field.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {selected.items.slice(0, 100).map((row, index) => (
              <tr key={index}>
                {presentation.columns.map((field, column) => {
                  const selected = selectPointer(row, field.pointer);
                  return (
                    <td key={column}>
                      <Cell
                        {...props}
                        identity={`${identity}:table:${renderer.id}:${index}:${column}`}
                        processing={processing}
                        result={formatCell(
                          selected.kind === "found" ? selected.value : undefined,
                          field.format,
                        )}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected.items.length > 100 && (
        <p role="status">
          Showing 100 of {selected.items.length} captured array items. Full value remains in the
          generic Source/Raw viewer.
        </p>
      )}
      {generic}
    </section>
  );
}
