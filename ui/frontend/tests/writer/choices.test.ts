import { describe, expect, it } from "vitest";
import { harness } from "../participants/runs/harness";
import { run, response, decode } from "../participants/runs/fixtures";
import * as d from "../../src/core/protocol/decoders";
import { jsonField } from "../../src/core/json";
import { readWriterRuns } from "../../src/app/writer-choices";

describe("writer run directory", () => {
  for (const mode of ["complete", "changed", "duplicate", "incomplete"] as const) {
    it(`${mode}: retains run owner and exact continuation or rejects an unreliable directory`, async () => {
      let calls = 0;
      const h = harness({
        read: (_method, params) => {
          const second = calls++ > 0;
          if (second) {
            expect(jsonField(params, "expected_revision")).toEqual(d.jsonString("7"));
            expect(jsonField(params, "head")).toEqual(d.jsonNull());
          }
          return Promise.resolve({
            ok: true,
            httpStatus: 200,
            data: response(
              {
                items: [{ ...run, run_id: second && mode !== "duplicate" ? "second" : "first" }],
                next_offset: second ? null : "1",
                omitted: second ? "0" : "1",
              },
              {
                query_scope: "runs",
                query_revision: second && mode === "changed" ? "8" : "7",
                history_capture: { head: null },
                budget: {
                  truncated: mode === "incomplete",
                  omitted_items: "0",
                  omitted_fields: mode === "incomplete" ? "1" : "0",
                  details_complete: mode !== "incomplete",
                },
              },
            ),
          });
        },
      });
      const result = await readWriterRuns(
        h.context.client,
        {
          connection: h.context.connection,
          workspaceId: decode(d.identifier, "workspace"),
          projectId: null,
        },
        new AbortController().signal,
      );
      expect(result.ok).toBe(mode === "complete");
      if (result.ok) {
        expect(result.data.map((row) => row.run_id)).toEqual(["first", "second"]);
        expect(result.data[0]?.actor_id).toBe(run.actor_id);
      }
    });
  }
});
