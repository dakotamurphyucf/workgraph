import { jsonField, type JsonValue } from "../json";
import * as c from "../protocol/codec";
import * as d from "../protocol/decoders";
import { createCompanion } from "../protocol/client";
import type { HttpClient, HttpResult } from "../protocol/http";
import type { LiveChangePage, LiveChangeReader } from "./live-types";

const page = c.record({
  source: c.refine(c.text, (value) => value === "planning" || value === "history", "feed source"),
  through: d.decimal,
  items: c.array(c.raw, 100),
  cursor: c.refine(c.text, (value) => value.length > 0 && value.length <= 2048, "feed cursor"),
  has_more: c.boolean,
  needs_larger_budget: c.boolean,
});
/** Workspace-wide invalidation is deliberate: project-only filters miss global
 * facts, resources and communication that contribute to a project projection. */
export function createLiveChangeReader(http: HttpClient): LiveChangeReader {
  const companion = createCompanion(http);
  return {
    async read(scope, source, cursor, wait, signal) {
      if (scope.workspaceId === null)
        return {
          ok: false,
          failure: { kind: "input", message: "Live feed requires a workspace." },
        };
      const request = async (
        position: readonly (readonly [string, JsonValue])[],
        waiting: boolean,
      ): Promise<HttpResult<LiveChangePage>> => {
        const response = await companion.read(
          {
            connection_id: scope.connection.id,
            generation: scope.connection.generation,
            method: waiting ? "changes.wait" : "changes.read",
            lane: waiting ? "wait" : "visible",
            params: d.jsonObject([
              ["workspace_id", d.jsonString(scope.workspaceId!)],
              ["source", d.jsonString(source)],
              ["limit", d.jsonString(cursor === null ? "1" : "100")],
              ["max_bytes", d.jsonString("65536")],
              ...position,
              ...(waiting ? [["timeout_ms", d.jsonString("25000")] as const] : []),
            ]),
          },
          signal,
        );
        if (!response.ok) return response;
        const result = page.decode(
          d.jsonObject(
            ["source", "through", "items", "cursor", "has_more", "needs_larger_budget"].flatMap(
              (name) => {
                const value = jsonField(response.data.response.data, name);
                return value === undefined ? [] : [[name, value] as const];
              },
            ),
          ),
        );
        const workspace = jsonField(response.data.response.data, "workspace_id");
        if (
          !result.ok ||
          result.value.source !== source ||
          (workspace !== undefined &&
            (workspace.kind !== "string" || workspace.value !== scope.workspaceId))
        )
          return {
            ok: false,
            failure: {
              kind: "protocol",
              message: "Invalid live change feed scope or page.",
              issue: result.ok ? undefined : result.issue,
            },
          };
        return {
          ok: true,
          httpStatus: response.httpStatus,
          data: {
            source,
            through: result.value.through,
            cursor: result.value.cursor,
            hasMore: result.value.has_more,
            needsLargerBudget: result.value.needs_larger_budget,
            changed: result.value.items.length > 0,
          },
        };
      };
      if (cursor !== null) return request([["cursor", d.jsonString(cursor)]], wait);
      // Obtain the head in a one-item bounded read, then establish a real native
      // cursor at that head BEFORE refreshing projections. No fabricated cursor
      // and no unbounded replay of the existing journal.
      const head = await request([], false);
      if (!head.ok || signal.aborted) return head;
      return request([["after", d.jsonString(head.data.through)]], false);
    },
  };
}
