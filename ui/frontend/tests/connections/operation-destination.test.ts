import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseJsonText, stringifyJson } from "../../src/core/json";
import * as d from "../../src/core/protocol/decoders";
import type { JsonObject, Operation, Preparation } from "../../src/core/protocol/types";
import {
  destinationText,
  operationDestination,
} from "../../src/features/connections/operation-destination";
import { DestinationSummary } from "../../src/features/connections/shared";
function object(source: string): JsonObject {
  const parsed = parseJsonText(source);
  if (!parsed.ok || parsed.value.value.kind !== "object") throw new Error("Invalid fixture");
  return parsed.value.value;
}
function preparation(method: string, params: string): Preparation {
  const decoded = d.preparation.decode(
    d.jsonObject([
      ["intention_id", d.jsonString("destination-test")],
      ["connection_id", d.jsonString("original")],
      ["generation", d.jsonString("1")],
      ["method", d.jsonString(method)],
      [
        "context",
        object(
          '{"workspace_id":"selected","project_id":"unrelated-project","writer":{"actor_id":"author","run_id":null}}',
        ),
      ],
      ["params", object(params)],
    ]),
  );
  if (!decoded.ok) throw new Error(decoded.issue.expected);
  return decoded.value;
}
function saved(prep: Preparation): Operation {
  const connection = object(
    '{"id":"original","generation":"1","label":"Original daemon","socket":"/tmp/original.sock"}',
  );
  const snapshot = d.jsonObject([
    ["intention_id", d.jsonString(prep.intention_id)],
    [
      "context",
      object(
        '{"workspace_id":"selected","project_id":"unrelated-project","writer":{"actor_id":"author","run_id":null}}',
      ),
    ],
    ["connection", connection],
    ["method", d.jsonString(prep.method)],
    ["params", prep.params],
  ]);
  const decoded = d.operation.decode(
    d.jsonObject([
      ["format", d.jsonString("workgraph-ui-operation-1")],
      ["operation_id", d.jsonString("saved")],
      ["preparation", snapshot],
      ["preparation_input_hash", d.jsonString("a".repeat(64))],
      ["connection", connection],
      [
        "request",
        d.jsonObject([
          ["jsonrpc", d.jsonString("2.0")],
          ["workgraph_api", d.jsonString("0.7")],
          ["id", d.jsonString("saved")],
          ["method", d.jsonString(prep.method)],
          ["params", prep.params],
        ]),
      ],
      ["journal_path", d.jsonString("/tmp/saved.json")],
      ["revision", d.jsonString("1")],
      ["state", object('{"kind":"prepared_unsent"}')],
      ["diagnostic", { kind: "null" }],
      ["receipt_lookup_supported", { kind: "boolean", value: true }],
    ]),
  );
  if (!decoded.ok) throw new Error(`${decoded.issue.path.join("/")}: ${decoded.issue.expected}`);
  return decoded.value;
}
describe("actual immutable operation destination", () => {
  it.each([
    "workspace.close",
    "workspace.open",
    "workspace.unregister",
    "workspace.update",
    "workspace.archive",
  ])("%s targets parameters while preserving navigation context", (method) => {
    const prep = preparation(method, '{"workspace_id":"other-workspace","actor_id":"author"}');
    const before = stringifyJson(prep.params);
    const target = operationDestination(prep, null);
    expect(destinationText(target)).toBe("Workspace other-workspace.");
    expect(prep.context.workspace_id).toBe("selected");
    expect(prep.context.project_id).toBe("unrelated-project");
    expect(stringifyJson(prep.params)).toEqual(before);
    expect(target.source).toBe("captured_parameters");
  });
  it("saved request confirmation presents actual destination and original endpoint", () => {
    const prep = preparation(
      "workspace.update",
      '{"workspace_id":"other-workspace","actor_id":"author","expected_revision":"0","name":"Exact name"}',
    );
    const operation = saved(prep);
    expect(operationDestination(prep, operation).source).toBe("saved_request");
    const markup = renderToStaticMarkup(
      createElement(DestinationSummary, { preparation: prep, operation }),
    );
    expect(markup).toContain("Destination: Workspace other-workspace.");
    expect(markup).toContain("Original daemon");
    expect(markup).not.toContain("unrelated-project");
    expect(markup).not.toContain("selected");
    expect(operation.preparation.context.workspace_id).toBe("selected");
  });
  it("does not invent project ancestry for an explicit ticket", () => {
    const prep = preparation(
      "ticket.update",
      '{"workspace_id":"other-workspace","ticket_id":"ticket-b"}',
    );
    expect(destinationText(operationDestination(prep, null))).toBe(
      "Workspace other-workspace · ticket reference ticket-b.",
    );
  });
  it("labels explicit references without implying captured-project ancestry", () => {
    const prep = preparation(
      "ticket.create",
      '{"workspace_id":"other-workspace","project_id":"explicit-project","milestone_id":"explicit-milestone","ticket_id":"new-ticket"}',
    );
    expect(destinationText(operationDestination(prep, null))).toBe(
      "Workspace other-workspace · project reference explicit-project · milestone reference explicit-milestone · ticket reference new-ticket.",
    );
  });
  it("daemon invocation never inherits a workspace", () => {
    expect(destinationText(operationDestination(preparation("daemon.shutdown", "{}"), null))).toBe(
      "Daemon endpoint (no workspace target).",
    );
  });
  it("generated and root-owned workspace IDs remain honest", () => {
    expect(
      destinationText(
        operationDestination(preparation("workspace.create", '{"root":"/tmp/new"}'), null),
      ),
    ).toBe("New workspace (ID assigned by the daemon) · root /tmp/new.");
    expect(
      destinationText(
        operationDestination(preparation("workspace.register", '{"root":"/tmp/existing"}'), null),
      ),
    ).toBe("Workspace registry (ID read from the captured root) · root /tmp/existing.");
  });
  it("batch describes multiple operations instead of one guessed project", () => {
    const prep = preparation(
      "transaction.apply",
      '{"workspace_id":"other-workspace","operations":[{"method":"ticket.create","params":{"project_id":"one"}},{"method":"ticket.create","params":{"project_id":"two"}}]}',
    );
    expect(operationDestination(prep, null).target).toEqual({
      kind: "batch",
      workspaceId: "other-workspace",
      operationCount: 2,
    });
    expect(destinationText(operationDestination(prep, null))).not.toContain("unrelated-project");
  });
  it("unknown or missing targets keep an exact-request fallback", () => {
    expect(destinationText(operationDestination(preparation("toString", "{}"), null))).toBe(
      "Target not summarized; inspect the exact request.",
    );
    expect(
      destinationText(
        operationDestination(preparation("custom.action", '{"resource_id":"explicit"}'), null),
      ),
    ).toBe("Target not summarized · resource reference explicit; inspect the exact request.");
  });
});
