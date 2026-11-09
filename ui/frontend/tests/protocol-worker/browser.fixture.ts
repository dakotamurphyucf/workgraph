/** Test-only controls; real dedicated worker and HTTP/controller implementations. */
import { createHttpClient } from "../../src/core/protocol/http";
import { createCompanion } from "../../src/core/protocol/client";
import { createOperationController } from "../../src/core/state/operations";
import { createProtocolProcessor } from "../../src/core/protocol/worker";
import { OPERATION_LIMITS } from "../../src/core/protocol/worker/jobs";
import { jsonField } from "../../src/core/json";
import * as c from "../../src/core/protocol/codec";
import * as d from "../../src/core/protocol/decoders";
const capability = document
  .querySelector('meta[name="workgraph-capability"]')
  ?.getAttribute("content");
if (!capability) throw new Error("Missing native capability");
const processing = createProtocolProcessor();
const http = createHttpClient({ origin: location.origin, capability, processing });
const companion = createCompanion(http);
const operations = createOperationController(companion, processing);
const graph = JSON.stringify(Array.from({ length: 100000 }, (_, id) => ({ id })));
const preparationSource = JSON.stringify({
  workspace_id: "demo",
  actor_id: "human",
  session_id: "protocol-session",
  events: [
    {
      client_id: "event-1",
      kind: "message",
      phase: "complete",
      role: "assistant",
      correlation: null,
      provenance: {},
      attachments: [],
      resource_versions: [],
      payload: { kind: "inline", bytes_base64: "A".repeat(3 * 1024 * 1024) },
    },
  ],
});
const panel = document.createElement("section");
panel.innerHTML =
  '<h2>Protocol qualification</h2><button id="protocol-click">Respond during processing</button><input id="protocol-input" aria-label="Protocol responsiveness input"><output>Ready</output>';
document.body.prepend(panel);
let clicks = 0;
panel.querySelector("button")!.addEventListener("click", () => {
  clicks++;
});
interface Metrics {
  readonly kind: string;
  readonly duration: number;
  readonly maxGap: number;
  readonly longTasks: readonly number[];
  readonly clicks: number;
  readonly input: string;
  readonly detail: string;
}
const assert = <T>(
  value:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly failure: { readonly message: string } },
): T => {
  if (!value.ok) throw new Error(value.failure.message);
  return value.value;
};
async function run(kind: "graph" | "full" | "native"): Promise<Metrics> {
  let last = performance.now(),
    maxGap = 0;
  const longTasks: number[] = [];
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 2);
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  });
  observer.observe({ entryTypes: ["longtask"] });
  const start = performance.now();
  let detail: string;
  try {
    if (kind === "graph") {
      const parsed = assert(await processing.parse(graph, { limits: OPERATION_LIMITS }));
      if (!parsed.ok) throw new Error(parsed.error.message);
      const encoded = assert(
        await processing.encode(parsed.value.value, { canonical: true, limits: OPERATION_LIMITS }),
      );
      if (!encoded.ok || encoded.value !== graph) throw new Error("Exact graph changed");
      detail = "300001 JSON nodes retained exactly";
    } else if (kind === "full") {
      const response = await http.request({
        path: "/protocol-qualification",
        method: "GET",
        codec: c.raw,
        responseBudget: "operation",
      });
      if (!response.ok) throw new Error(response.failure.kind);
      const encoded = assert(await processing.encode(response.data, { limits: OPERATION_LIMITS }));
      if (!encoded.ok) throw new Error(encoded.error.message);
      if (encoded.value.length !== 16 * 1024 * 1024 - 19)
        throw new Error(`Wrong response size ${encoded.value.length}`);
      detail = "16MiB HTTP envelope decoded and re-encoded";
    } else {
      const parsed = assert(await processing.parse(preparationSource));
      if (!parsed.ok || parsed.value.value.kind !== "object")
        throw new Error("Invalid preparation fixture");
      const id = (s: string) => {
        const value = d.identifier.decode(d.jsonString(s));
        if (!value.ok) throw new Error("Invalid fixture identity");
        return value.value;
      };
      const generation = d.positiveDecimal.decode(d.jsonString("1"));
      if (!generation.ok) throw new Error("Invalid generation");
      const preparation = {
        intention_id: id("protocol-large"),
        connection_id: id("local"),
        generation: generation.value,
        context: {
          workspace_id: id("demo"),
          project_id: id("release"),
          writer: { actor_id: id("human"), run_id: null },
        },
        method: "session.append",
        params: parsed.value.value,
      };
      const registered = await operations.register(preparation);
      if (!registered.ok) throw new Error(registered.failure.kind);
      const prepared = await operations.act(preparation.intention_id, "prepare");
      if (!prepared.ok) throw new Error(prepared.failure.kind);
      const operation = prepared.entry.operation;
      if (!operation || operation.state.kind !== "prepared_unsent")
        throw new Error("Preparation not durable");
      const events = jsonField(operation.preparation.params, "events");
      const event = events?.kind === "array" ? events.items[0] : undefined;
      const payload = event === undefined ? undefined : jsonField(event, "payload");
      const bytes = payload === undefined ? undefined : jsonField(payload, "bytes_base64");
      if (bytes?.kind !== "string" || bytes.value.length !== 3 * 1024 * 1024)
        throw new Error("Captured bytes changed");
      detail = "3MiB params; native durable unsent journal; expanded operation validated";
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    return {
      kind,
      duration: performance.now() - start,
      maxGap,
      longTasks,
      clicks,
      input: (panel.querySelector("input") as HTMLInputElement).value,
      detail,
    };
  } finally {
    clearInterval(timer);
    observer.disconnect();
  }
}
async function small() {
  const values: number[] = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    const result = await companion.connections();
    if (!result.ok) throw new Error(result.failure.kind);
    values.push(performance.now() - start);
  }
  return values;
}
async function cancel() {
  const controller = new AbortController();
  const promise = processing.parse(graph, { limits: OPERATION_LIMITS, signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  const cancelled = await promise;
  const after = await processing.parse("9007199254740993");
  return { cancelled, after };
}
interface Probe {
  readonly run: typeof run;
  readonly small: typeof small;
  readonly cancel: typeof cancel;
  readonly dispose: () => void;
  pending?: Promise<Metrics>;
}
declare global {
  interface Window {
    protocolProbe: Probe;
  }
}
window.protocolProbe = { run, small, cancel, dispose: () => processing.dispose() };
