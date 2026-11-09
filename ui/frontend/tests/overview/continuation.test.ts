import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { jsonField, parseJsonText } from "../../src/core/json";
import * as c from "../../src/core/protocol/codec";
import { choice } from "../../src/features/discussions/threads/codecs";
import * as d from "../../src/core/protocol/decoders";
import type { OverviewScope } from "../../src/features/overview/types";
import { continued, decodeObservation, nextInvocation } from "../../src/features/overview/client";
import { activityDigest, coordinationPage } from "../../src/features/overview/codecs";
const input = JSON.parse(
  readFileSync(new URL("./fixtures/continuations.json", import.meta.url), "utf8"),
) as { reads: { request: unknown; raw: string }[] };
function decode<T>(codec: import("../../src/core/protocol/codec").Codec<T>, source: string): T {
  const parsed = parseJsonText(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const v = codec.decode(parsed.value.value);
  if (!v.ok) throw new Error(v.issue.expected);
  return v.value;
}
function id(value: string) {
  return decode(d.identifier, JSON.stringify(value));
}
function counter(value: string) {
  return decode(d.decimal, JSON.stringify(value));
}
const scope: OverviewScope = {
  connection: {
    id: id("local"),
    generation: counter("1"),
    label: "probe",
    socket: "/tmp/fixture.sock",
  },
  workspaceId: id("demo"),
  projectId: id("release"),
  actorId: null,
  runId: null,
};
it("decodes and replays all six actual companion pages without rebuilding native cursors", () => {
  let previousCoord:
    | import("../../src/features/overview/types").Observation<
        import("../../src/features/overview/types").CoordinationPage
      >
    | undefined;
  let previousDigest:
    | import("../../src/features/overview/types").Observation<
        import("../../src/features/overview/types").ActivityDigest
      >
    | undefined;
  let count = 0;
  for (const row of input.reads) {
    const request = decode(
      c.record({
        connection_id: d.identifier,
        generation: d.positiveDecimal,
        method: c.text,
        params: c.object,
        lane: choice(["visible", "history"]),
      }),
      JSON.stringify(row.request),
    );
    const parsed = parseJsonText(row.raw);
    if (!parsed.ok) throw new Error("native JSON");
    const data = jsonField(parsed.value.value, "data");
    const response = d.readResponse.decode(data);
    if (!response.ok) throw new Error(response.issue.expected);
    if (request.method === "coordinator.overview") {
      const result = decodeObservation(
        scope,
        request,
        response.value,
        coordinationPage,
        (v) => v.omitted !== "0",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      if (previousCoord !== undefined) {
        expect(continued(previousCoord, result).ok).toBe(true);
        expect(nextInvocation(previousCoord)).toMatchObject({
          ok: true,
          data: { params: request.params },
        });
      }
      previousCoord = result.data;
    } else {
      const result = decodeObservation(
        scope,
        request,
        response.value,
        activityDigest,
        (v) => v.hasMore,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      if (previousDigest !== undefined) {
        expect(continued(previousDigest, result).ok).toBe(true);
        expect(nextInvocation(previousDigest)).toMatchObject({
          ok: true,
          data: { params: request.params },
        });
      }
      previousDigest = result.data;
    }
    count++;
  }
  expect(count).toBe(6);
  expect(previousCoord?.value.cursor).toBe(null);
  expect(previousDigest?.value.hasMore).toBe(false);
});
