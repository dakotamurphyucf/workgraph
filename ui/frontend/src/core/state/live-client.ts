import * as c from "../protocol/codec";
import * as d from "../protocol/decoders";
import type { HttpClient } from "../protocol/http";
import type { LiveChangeReader } from "./live-types";

const page = c.record({
  source: c.refine(c.text, (value) => value === "planning" || value === "history", "feed source"),
  through: d.decimal,
  items: c.array(c.raw, 100),
  cursor: c.refine(c.text, (value) => value.length > 0 && value.length <= 2048, "feed cursor"),
  has_more: c.boolean,
  needs_larger_budget: c.boolean,
});
const observation = c.record({
  workspace_id: d.identifier,
  planning: page,
  history: c.nullable(page),
  runtime_signature: c.nullable(d.digest),
  runtime_changed: c.boolean,
});
/** One authenticated HTTP request per tab, including pages observing both feeds.
 * Project filters belong to projections, not workspace-wide invalidation. */
export function createLiveChangeReader(http: HttpClient): LiveChangeReader {
  return {
    async read(scope, sources, cursor, wait, signal) {
      const workspaceId = scope.workspaceId;
      if (workspaceId === null)
        return {
          ok: false,
          failure: { kind: "input", message: "Live feed requires a workspace." },
        };
      if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
      const observationId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const history = sources.includes("history");
      let cancellation: Promise<unknown> | undefined;
      const cancel = () => {
        cancellation ??= http
          .request({
            path: "/live-observations/cancel",
            method: "POST",
            codec: c.record({ cancelled: c.literal(true) }),
            body: d.jsonObject([
              ["connection_id", d.jsonString(scope.connection.id)],
              ["generation", d.jsonString(scope.connection.generation)],
              [
                "cancellation",
                d.jsonObject([
                  ["workspace_id", d.jsonString(workspaceId)],
                  ["observation_id", d.jsonString(observationId)],
                ]),
              ],
            ]),
          })
          .catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      // A silently dropped connection must not leave the observer stuck forever.
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), 45000);
      const response = await (async () => {
        try {
          return await http.request({
            path: "/live-observations",
            method: "POST",
            signal: deadline.signal,
            codec: c.raw,
            body: d.jsonObject([
              ["connection_id", d.jsonString(scope.connection.id)],
              ["generation", d.jsonString(scope.connection.generation)],
              [
                "observation",
                d.jsonObject([
                  ["workspace_id", d.jsonString(workspaceId)],
                  ["observation_id", d.jsonString(observationId)],
                  [
                    "planning_cursor",
                    cursor === null ? { kind: "null" } : d.jsonString(cursor.planning),
                  ],
                  ["history", { kind: "boolean", value: history }],
                  ["runtime", { kind: "boolean", value: sources.includes("runtime") }],
                  [
                    "runtime_signature",
                    cursor?.runtime == null ? { kind: "null" } : d.jsonString(cursor.runtime),
                  ],
                  [
                    "history_cursor",
                    cursor?.history == null ? { kind: "null" } : d.jsonString(cursor.history),
                  ],
                  ["wait", { kind: "boolean", value: wait }],
                ]),
              ],
            ]),
          });
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
        }
      })();
      if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
      if (!response.ok) {
        if (deadline.signal.aborted && !signal.aborted)
          return {
            ok: false,
            failure: { kind: "network", message: "Live observation timed out; reconnecting." },
          };
        return response;
      }
      const cancelled = c.record({ cancelled: c.literal(true) }).decode(response.data);
      if (cancelled.ok) return { ok: false, failure: { kind: "aborted" } };
      const decoded = observation.decode(response.data);
      if (!decoded.ok)
        return {
          ok: false,
          failure: {
            kind: "protocol",
            message: "Invalid live observation response.",
            issue: decoded.issue,
          },
        };
      const result = decoded.value;
      if (
        result.workspace_id !== scope.workspaceId ||
        result.planning.source !== "planning" ||
        (history ? result.history?.source !== "history" : result.history !== null) ||
        (sources.includes("runtime")
          ? result.runtime_signature === null
          : result.runtime_signature !== null || result.runtime_changed)
      )
        return {
          ok: false,
          failure: {
            kind: "protocol",
            message: "Invalid live observation scope or source.",
            issue: undefined,
          },
        };
      const pages = result.history === null ? [result.planning] : [result.planning, result.history];
      return {
        ok: true,
        httpStatus: response.httpStatus,
        data: {
          cursor: {
            planning: result.planning.cursor,
            history: result.history?.cursor ?? null,
            runtime: result.runtime_signature,
          },
          hasMore: pages.some((page) => page.has_more),
          needsLargerBudget: pages.some((page) => page.needs_larger_budget),
          changed: result.runtime_changed || pages.some((page) => page.items.length > 0),
        },
      };
    },
  };
}
