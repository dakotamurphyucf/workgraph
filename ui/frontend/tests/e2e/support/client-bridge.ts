/** Test-only entry bundled separately; never imported by main or embedded assets. */
import { createElement, useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Application, createApplicationServices } from "../../../src/application";
import { createHttpClient } from "../../../src/core/protocol/http";
import { type ManagedResult } from "../../../src/core/state/operations";
import { parseJsonText, stringifyJson } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import { object, type Codec } from "../../../src/core/protocol/codec";
import type { ReadInvocation } from "../../../src/core/protocol/types";

export interface IntegrationBridge {
  read(
    invocation: Omit<ReadInvocation, "params" | "connection_id" | "generation"> & {
      readonly connection_id: string;
      readonly generation: string;
    } & { readonly params: string },
  ): Promise<string>;
  register(preparation: string): Promise<string>;
  act(intention: string, action: "prepare" | "execute" | "inspect" | "recover"): Promise<string>;
  snapshot(intention: string): string;
  exactRequest(intention: string): string;
  mountApplication(): void;
  composition(): { readonly featureMounts: number; readonly sameServices: boolean };
}
declare global {
  interface Window {
    workgraphIntegration: IntegrationBridge;
  }
}
function decode<T>(codec: Codec<T>, source: string): T {
  const parsed = parseJsonText(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const result = codec.decode(parsed.value.value);
  if (!result.ok) throw new Error(`Invalid integration input: ${result.issue.expected}`);
  return result.value;
}
const capability = document
  .querySelector('meta[name="workgraph-capability"]')
  ?.getAttribute("content");
if (!capability) throw new Error("Integration page has no launch capability");
// Same launch factory as main; exactly one owner retained while App navigates.
const services = createApplicationServices(
  createHttpClient({ origin: window.location.origin, capability }),
);
const { companion, operations } = services;
let featureMounts = 0;
let sameServices = true;
function CapturedFeature() {
  useEffect(() => {
    featureMounts += 1;
  }, []);
  const state = useSyncExternalStore(operations.subscribe, () =>
    operations
      .list()
      .map((entry) => `${entry.preparation.intention_id}:${entry.phase.kind}`)
      .join(","),
  );
  return createElement("output", { "data-testid": "composition-operations" }, state || "No draft");
}
function summary(result: ManagedResult): string {
  if (!result.ok) throw new Error(`Operation failure: ${result.failure.kind}`);
  const entry = result.entry;
  return JSON.stringify({
    phase: entry.phase.kind,
    actor: entry.preparation.context.writer.actor_id,
    workspace: entry.preparation.context.workspace_id,
    project: entry.preparation.context.project_id,
    operationId: entry.operation?.operation_id,
    state: entry.operation?.state.kind,
    revision: entry.operation?.revision,
    request: entry.operation === null ? null : serialize(entry.operation.request),
  });
}
function serialize(value: Parameters<typeof stringifyJson>[0]): string {
  const result = stringifyJson(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
window.workgraphIntegration = Object.freeze<IntegrationBridge>({
  mountApplication: () => {
    if (document.getElementById("integration-application"))
      throw new Error("Composition already mounted");
    const container = document.createElement("div");
    container.id = "integration-application";
    document.body.append(container);
    createRoot(container).render(
      createElement(Application, {
        services,
        renderFeature: (_context, supplied) => {
          sameServices &&= supplied === services && supplied.operations === operations;
          return createElement(CapturedFeature);
        },
      }),
    );
  },
  composition: () => ({ featureMounts, sameServices }),
  read: async (invocation) => {
    const params = decode(object, invocation.params);
    const response = await companion.read({
      ...invocation,
      params,
      connection_id: decode(d.identifier, JSON.stringify(invocation.connection_id)),
      generation: decode(d.decimal, JSON.stringify(invocation.generation)),
    });
    if (!response.ok) throw new Error(`Read failed: ${response.failure.kind}`);
    return serialize(response.data.response.data);
  },
  register: async (source) => summary(await operations.register(decode(d.preparation, source))),
  act: async (id, action) =>
    summary(await operations.act(decode(d.identifier, JSON.stringify(id)), action)),
  exactRequest: (id) => {
    const operation = operations.get(decode(d.identifier, JSON.stringify(id)))?.operation;
    if (!operation) throw new Error("Missing prepared operation");
    return serialize(operation.request);
  },
  snapshot: (id) => {
    const entry = operations.get(decode(d.identifier, JSON.stringify(id)));
    if (!entry) throw new Error("Missing integration intention");
    return summary({ ok: true, entry });
  },
});
