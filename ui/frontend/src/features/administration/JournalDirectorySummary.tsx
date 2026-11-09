import type { JsonObject } from "../../core/protocol/types";
import * as c from "../../core/protocol/codec";
import { field } from "./model";

/** Keep file results and invalid entries visible without exposing the raw protocol envelope. */
export function JournalDirectorySummary({ value }: { readonly value: JsonObject }) {
  const items = field(value, "items", c.array(c.object, 100));
  const groups = field(value, "groups", c.array(c.object, 100));
  return (
    <div className="wg-journal-directory">
      {items.length === 0 && <p>No saved request files on this page.</p>}
      {items.map((item) => {
        const filename = field(item, "filename", c.text);
        const entry = field(item, "entry", c.nullable(c.object));
        const problem = field(item, "problem", c.nullable(c.object));
        return (
          <article className="wg-admin-job" key={filename}>
            <strong>{filename}</strong>
            {entry !== null && (
              <p>{field(entry, "method", c.text)} · Commit status has not been checked.</p>
            )}
            {problem !== null && <p role="alert">{field(problem, "message", c.text)}</p>}
          </article>
        );
      })}
      {groups.map((group, index) => (
        <p key={index} role="status">
          {field(group, "kind", c.text) === "conflicting_request_hashes"
            ? "Conflicting saved requests"
            : "Copies of the same request"}
          : {field(group, "filenames", c.array(c.text, 100)).join(", ")}
        </p>
      ))}
    </div>
  );
}
