import type { JsonValue } from "../../core/json";

/** Readable, passive review of exact captured values; no JSON viewer worker or disclosure. */
export function CapturedValues({ value }: { readonly value: JsonValue }) {
  switch (value.kind) {
    case "null":
      return <span className="wg-hint">Not set</span>;
    case "boolean":
      return <span>{value.value ? "Yes" : "No"}</span>;
    case "number":
      return <span>{value.lexeme}</span>;
    case "string":
      return <span className="wg-captured-text">{value.value || "Empty"}</span>;
    case "array":
      return value.items.length === 0 ? (
        <span>None</span>
      ) : (
        <ol className="wg-captured-list">
          {value.items.map((item, index) => (
            <li key={index}>
              <CapturedValues value={item} />
            </li>
          ))}
        </ol>
      );
    case "object":
      return (
        <dl className="wg-captured-values">
          {value.fields.map((field) => (
            <div key={field.name}>
              <dt>{field.name.replaceAll("_", " ")}</dt>
              <dd>
                <CapturedValues value={field.value} />
              </dd>
            </div>
          ))}
        </dl>
      );
  }
}
