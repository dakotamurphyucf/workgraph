import { describe, expect, it } from "vitest";
import type { Operation } from "../../../src/core/protocol/types";
import type { ManagedOperation } from "../../../src/core/state/operations";
import * as d from "../../../src/core/protocol/decoders";
import { parseRoute, routeHref, changeView } from "../../../src/app/navigation";
import { committedWorkWrite, capturePredatesWrite } from "../../../src/features/work/freshness";
import { workbenchRoute, matchesWorkbench } from "../../../src/features/work/destinations";
import { context, decode, response, target } from "../actions-fixtures";
import { createTestProcessor } from "../../core/processing-harness";
import type { HttpClient } from "../../../src/core/protocol/http";

function fixture() {
  const processing = createTestProcessor();
  const client: HttpClient = {
    processing,
    request: () => {
      throw new Error("No I/O in pure model");
    },
  };
  const ctx = context(client),
    selection = target(client);
  return { ctx, selection, dispose: () => processing.dispose() };
}
function operation(
  state: Operation["state"],
  scope: ReturnType<typeof target>["scope"],
  revision = "2",
): ManagedOperation {
  const params = d.jsonObject([
    ["workspace_id", d.jsonString(scope.workspaceId)],
    ["ticket_id", d.jsonString("target")],
  ]);
  const preparation = {
    intention_id: decode(d.identifier, "intent"),
    context: {
      workspace_id: scope.workspaceId,
      project_id: null,
      writer: { actor_id: decode(d.identifier, "writer"), run_id: null },
    },
    method: "ticket.start",
    params,
  };
  return {
    preparation: {
      ...preparation,
      connection_id: scope.connection.id,
      generation: scope.connection.generation,
    },
    phase: { kind: "observed" },
    operation: {
      format: "workgraph-ui-operation-1",
      operation_id: decode(d.identifier, "op"),
      preparation: { ...preparation, connection: scope.connection },
      connection: scope.connection,
      preparation_input_hash: decode(d.digest, "a".repeat(64)),
      request: params,
      journal_path: "/tmp/synthetic.json",
      revision: decode(d.decimal, revision),
      state,
      diagnostic: null,
      receipt_lookup_supported: true,
    },
  };
}
function committed(revision: string): Operation["state"] {
  return {
    kind: "committed",
    response: {
      data: d.jsonObject([]),
      meta: d.jsonObject([
        ["durable", d.jsonBoolean(true)],
        ["workspace_revision", d.jsonString(revision)],
      ]),
    },
  };
}

describe("original workbench destination", () => {
  it("roundtrips exact socket bytes and generation, and clears only on deliberate view change", () => {
    const f = fixture();
    try {
      const c = { ...f.ctx.connection, socket: "/tmp/exact 雪 & original.sock" };
      const route = workbenchRoute(
        c,
        f.selection.scope.workspaceId,
        decode(d.identifier, "created"),
      );
      expect(parseRoute(routeHref(route))).toEqual({ ok: true, route });
      expect(changeView(route, "facts").workbench).toBeUndefined();
      expect(matchesWorkbench({ ...f.ctx, route, connection: c }, c)).toBe(true);
      expect(
        matchesWorkbench(
          { ...f.ctx, route, connection: { ...c, generation: decode(d.positiveDecimal, "2") } },
          c,
        ),
      ).toBe(false);
      expect(
        matchesWorkbench(
          { ...f.ctx, route, connection: { ...c, socket: "/tmp/replacement.sock" } },
          { ...c, socket: "/tmp/replacement.sock" },
        ),
      ).toBe(false);
    } finally {
      f.dispose();
    }
  });
  it("rejects incomplete, malformed, oversized and mixed destinations", () => {
    for (const query of [
      "work_generation=1",
      "work_socket=%2Ftmp%2Fs",
      "work_generation=0&work_socket=%2Ftmp%2Fs",
      "work_generation=1&work_socket=relative",
      "work_generation=1&work_socket=%2Ftmp%2F%00",
      "work_generation=1&work_socket=%2F" + "x".repeat(4096),
      "work_generation=1&work_socket=%2Ftmp%2Fs&planning_kind=ticket&planning_generation=1",
    ])
      expect(parseRoute("#/work?connection=local&workspace=demo&entity=target&" + query).ok).toBe(
        false,
      );
    expect(
      parseRoute("#/facts?connection=local&workspace=demo&work_generation=1&work_socket=%2Ftmp%2Fs")
        .ok,
    ).toBe(false);
  });
});
describe("committed write freshness", () => {
  it("uses the saved actual workspace rather than selected context or unsaved params", () => {
    const f = fixture();
    try {
      const selected = f.selection.scope;
      const actual = { ...selected, workspaceId: decode(d.identifier, "actual-workspace") };
      for (const [navigation, destination] of [
        [selected, actual],
        [actual, selected],
      ] as const) {
        const entry = operation(committed("9"), navigation);
        if (entry.operation === null) throw new Error("fixture");
        const saved = {
          ...entry,
          operation: {
            ...entry.operation,
            preparation: {
              ...entry.operation.preparation,
              params: d.jsonObject([["workspace_id", d.jsonString(destination.workspaceId)]]),
            },
          },
        };
        expect.soft(committedWorkWrite(destination, [saved])?.workspaceRevision).toBe("9");
        expect.soft(committedWorkWrite(navigation, [saved])).toBeNull();
        for (const connection of [
          { ...destination.connection, id: decode(d.identifier, "other-connection") },
          { ...destination.connection, generation: decode(d.positiveDecimal, "2") },
          { ...destination.connection, socket: "/tmp/another-root.sock" },
        ])
          expect(committedWorkWrite({ ...destination, connection }, [saved])).toBeNull();
      }
    } finally {
      f.dispose();
    }
  });
  it("never falls back to context for absent, null or invalid saved workspace params", () => {
    const f = fixture();
    try {
      const entry = operation(committed("9"), f.selection.scope);
      if (entry.operation === null) throw new Error("fixture");
      for (const params of [
        d.jsonObject([]),
        ...[
          d.jsonNull(),
          d.jsonString(""),
          d.jsonString("bad id"),
          d.jsonNumber("1"),
          d.jsonObject([]),
        ].map((value) => d.jsonObject([["workspace_id", value]])),
      ])
        expect
          .soft(
            committedWorkWrite(f.selection.scope, [
              {
                ...entry,
                operation: {
                  ...entry.operation,
                  preparation: { ...entry.operation.preparation, params },
                },
              },
            ]),
          )
          .toBeNull();
    } finally {
      f.dispose();
    }
  });
  it("keeps huge planning revisions exact and matches full original endpoint independently of list project", () => {
    const f = fixture();
    try {
      const entry = operation(committed("9007199254740994"), f.selection.scope);
      const write = committedWorkWrite(f.selection.scope, [entry]);
      expect(write?.workspaceRevision).toBe("9007199254740994");
      expect(
        capturePredatesWrite(
          { ...f.selection.ticket, revision: decode(d.decimal, "9007199254740993") },
          write,
        ),
      ).toBe(true);
      expect(
        capturePredatesWrite(
          { ...f.selection.ticket, revision: decode(d.decimal, "9007199254740994") },
          write,
        ),
      ).toBe(false);
      for (const connection of [
        { ...f.selection.scope.connection, generation: decode(d.positiveDecimal, "2") },
        { ...f.selection.scope.connection, socket: "/tmp/replacement.sock" },
      ])
        expect(committedWorkWrite({ ...f.selection.scope, connection }, [entry])).toBeNull();
      expect(
        committedWorkWrite({ ...f.selection.scope, workspaceId: decode(d.identifier, "other") }, [
          entry,
        ]),
      ).toBeNull();
    } finally {
      f.dispose();
    }
  });
  it("never calls observed, unknown, rejected, malformed or communication responses a durable planning write", () => {
    const f = fixture();
    try {
      const responseValue = response({}, "9").response;
      for (const state of [
        { kind: "observed", response: responseValue },
        {
          kind: "outcome_unknown",
          problem: { kind: "Transport", message: "lost", details: undefined },
        },
        {
          kind: "rejected",
          problem: { kind: "Conflict", message: "rejected", details: undefined },
        },
        { kind: "committed", response: responseValue },
        {
          kind: "committed",
          response: {
            data: d.jsonObject([]),
            meta: d.jsonObject([
              ["durable", d.jsonBoolean(true)],
              ["workspace_revision", d.jsonString("01")],
            ]),
          },
        },
      ] satisfies Operation["state"][])
        expect(
          committedWorkWrite(f.selection.scope, [operation(state, f.selection.scope)]),
        ).toBeNull();
      const entry = operation(committed("9"), f.selection.scope);
      if (entry.operation === null) throw new Error("fixture");
      expect(
        committedWorkWrite(f.selection.scope, [
          {
            ...entry,
            operation: {
              ...entry.operation,
              preparation: { ...entry.operation.preparation, method: "request.resolve" },
            },
          },
        ]),
      ).toBeNull();
    } finally {
      f.dispose();
    }
  });
});
