import { jsonField } from "../../../../core/json";
import * as c from "../../../../core/protocol/codec";
import * as d from "../../../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../../core/protocol/http";
import { sameEndpoint } from "../../threads/model";
import { choice } from "../../threads/codecs";
import { currentRequest } from "../codecs";
import type { RequestWaitObservation, RequestWaitPlan } from "./types";
const timeout = c.refine(
  d.decimal,
  (v) => BigInt(v) >= 1000n && BigInt(v) <= 300000n,
  "1000..300000 milliseconds",
);
const interval = c.refine(
  d.decimal,
  (v) => BigInt(v) >= 250n && BigInt(v) <= 25000n,
  "250..25000 milliseconds",
);
export const requestWaitPlan = c.record({
  connectionId: d.identifier,
  generation: d.positiveDecimal,
  workspaceId: d.identifier,
  requestId: d.identifier,
  timeoutMs: timeout,
  pollIntervalMs: interval,
});
const detail = c.record({
  path: c.refine(c.text, (v) => /^\/(?:[^~]|~[01])*$/u.test(v), "JSON pointer"),
  kind: choice(["text_bytes", "items"] as const),
  omitted: d.positiveDecimal,
});
const budget = c.refine(
  c.record({
    max_bytes: c.refine(d.decimal, (v) => v === "1048576", "native request.wait 1MiB query budget"),
    returned_bytes: d.decimal,
    truncated: c.boolean,
    omitted_fields: d.decimal,
    omitted_items: d.decimal,
    details: c.array(detail, 4),
    details_complete: c.boolean,
  }),
  (v) => {
    let fields = BigInt(v.omitted_fields),
      items = BigInt(v.omitted_items);
    if (
      BigInt(v.returned_bytes) > BigInt(v.max_bytes) ||
      v.truncated !== (fields > 0n || items > 0n)
    )
      return false;
    const paths = new Set<string>();
    for (const detail of v.details) {
      if (paths.has(detail.path)) return false;
      paths.add(detail.path);
      if (detail.kind === "text_bytes") fields--;
      else items -= BigInt(detail.omitted);
      if (fields < 0n || items < 0n) return false;
    }
    return !v.details_complete || (fields === 0n && items === 0n);
  },
  "consistent native clipping metadata",
);
const capture = c.record({
  profile: d.connectionProfile,
  workspace_id: d.identifier,
  request_id: d.identifier,
  timeout_ms: timeout,
  poll_interval_ms: interval,
});
const wait = c.record({
  stop: choice(["resolved", "cancelled", "deadline", "incomplete"] as const),
  resolved: c.boolean,
  poll_count: c.refine(d.positiveDecimal, (v) => BigInt(v) <= 1201n, "bounded native poll count"),
});
// meta.wait is the native local helper extension, not ordinary request.get metadata.
const result = c.record({
  capture,
  observation: c.record({
    data: currentRequest,
    meta: c.record({
      query_scope: c.literal("communication"),
      query_revision: d.decimal,
      budget,
      wait,
    }),
  }),
});
export const requestWaitObservation: c.Codec<RequestWaitObservation> = {
  decode(value, path = []) {
    const decoded = result.decode(value, path);
    if (!decoded.ok) return decoded;
    const {
      capture: captured,
      observation: { data, meta },
    } = decoded.value;
    const outcome = meta.wait;
    const valid =
      outcome.resolved === (outcome.stop === "resolved") &&
      (outcome.stop === "incomplete"
        ? meta.budget.truncated
        : !meta.budget.truncated &&
          (outcome.stop === "resolved"
            ? data.status.kind === "resolved"
            : outcome.stop === "cancelled"
              ? data.status.kind === "cancelled"
              : data.status.kind === "open"));
    if (!valid || data.id !== captured.request_id)
      return c.mismatch(path, "native wait stop/status/clipping and requested identity must agree");
    if (value?.kind !== "object") return c.mismatch(path, "wait result object");
    const observation = jsonField(value, "observation");
    if (observation?.kind !== "object") return c.mismatch(path, "native observation object");
    const metadata = jsonField(observation, "meta");
    if (metadata?.kind !== "object") return c.mismatch(path, "retained wait metadata");
    return {
      ok: true,
      value: Object.freeze({
        plan: Object.freeze({
          connectionId: captured.profile.id,
          generation: captured.profile.generation,
          workspaceId: captured.workspace_id,
          requestId: captured.request_id,
          timeoutMs: captured.timeout_ms,
          pollIntervalMs: captured.poll_interval_ms,
        }),
        profile: captured.profile,
        request: data,
        stop: outcome.stop,
        resolved: outcome.resolved,
        pollCount: outcome.poll_count,
        metadata,
        raw: value,
      }),
    };
  },
};
export function sameRequestWait(a: RequestWaitPlan, b: RequestWaitPlan): boolean {
  return (
    sameEndpoint(a, b) &&
    a.requestId === b.requestId &&
    a.timeoutMs === b.timeoutMs &&
    a.pollIntervalMs === b.pollIntervalMs
  );
}
export async function observeRequest(
  http: HttpClient,
  plan: RequestWaitPlan,
  signal: AbortSignal,
): Promise<HttpResult<RequestWaitObservation>> {
  const response = await http.request({
    path: "/request-waits",
    method: "POST",
    body: d.jsonObject([
      ["connection_id", d.jsonString(plan.connectionId)],
      ["generation", d.jsonString(plan.generation)],
      ["workspace_id", d.jsonString(plan.workspaceId)],
      ["request_id", d.jsonString(plan.requestId)],
      ["timeout_ms", d.jsonString(plan.timeoutMs)],
      ["poll_interval_ms", d.jsonString(plan.pollIntervalMs)],
    ]),
    codec: requestWaitObservation,
    signal,
  });
  if (response.ok && !sameRequestWait(plan, response.data.plan))
    return {
      ok: false,
      failure: {
        kind: "protocol",
        message: "Foreground wait returned a different endpoint, request or budget capture.",
        issue: undefined,
      },
    };
  return response;
}
