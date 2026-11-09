import { canonicalJson, type JsonValue } from "../../../core/json";

/** A passive view of the decoded fact, with exact number lexemes and explicit
 * value types. Nested containers expand in place; field names carry no inferred schema. */
export function FactStructure({ value }: { readonly value: JsonValue }) {
  if (value.kind !== "object") return <Value value={value} />;
  if (value.fields.length === 0)
    return <p className="fact-structure-empty">Empty object · {"{}"}</p>;
  return (
    <dl className="fact-structure">
      {value.fields.map((field) => (
        <div className="fact-structure-row" key={field.name}>
          <dt>
            <code>{field.name === "" ? '""' : field.name}</code>
          </dt>
          <dd>
            <Value value={field.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
function Value({ value }: { readonly value: JsonValue }) {
  if (value.kind === "object" || value.kind === "array") {
    const count = value.kind === "object" ? value.fields.length : value.items.length;
    return (
      <details className="fact-nested">
        <summary>
          <span className="fact-display-type">{value.kind}</span> {count}{" "}
          {value.kind === "object" ? "fields" : "items"}
        </summary>
        {value.kind === "object" ? (
          <FactStructure value={value} />
        ) : value.items.length === 0 ? (
          <p>Empty list</p>
        ) : (
          <ol className="fact-array" start={0}>
            {value.items.map((item, index) => (
              <li key={index}>
                <Value value={item} />
              </li>
            ))}
          </ol>
        )}
      </details>
    );
  }
  const encoded = canonicalJson(value);
  if (!encoded.ok) throw new Error("Validated fact cannot be rendered as JSON.");
  return (
    <div className={`fact-display-value fact-display-value--${value.kind}`}>
      <span className="fact-display-type">{value.kind}</span>
      {value.kind === "string" ? (
        <span className="fact-string">{value.value === "" ? '""' : value.value}</span>
      ) : (
        <pre>{encoded.value}</pre>
      )}
    </div>
  );
}
