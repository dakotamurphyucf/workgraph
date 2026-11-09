import { describe, expect, it } from "vitest";
import * as d from "../../../src/core/protocol/decoders";
import { jsonField } from "../../../src/core/json";
import { decode, json } from "../../work/actions-fixtures";
import {
  decodePlan,
  materializeStage,
  planJson,
  pointer,
  preflightCodec,
  stageParams,
  templateCodec,
  validateExposure,
} from "../../../src/features/workflow/plans/model";
import type { DurableStageReceipt, PlanCapture } from "../../../src/features/workflow/plans/types";

const create = { method: "ticket.create", params: { title: "Captured" }, alias: "work" };
const hold = {
  method: "ticket.hold",
  params: {
    ticket_id: "$work",
    expected_revision: "1",
    reason: "Deferred prerequisites and gates",
  },
  alias: null,
};
const stage = (id: string, operations: unknown[] = [create, hold], bindings: unknown[] = []) => ({
  id,
  title: id,
  operations,
  bindings,
  exposure: "Independent commit; held work remains protected.",
  exposures: operations.flatMap((op, index) => {
    const method = (op as { method: string }).method;
    return method === "ticket.create" || method === "template.instantiate"
      ? [
          {
            operation: index,
            disposition: "held",
            deferred: "Later obligations",
            templateDigest: method === "template.instantiate" ? "a".repeat(64) : null,
          },
        ]
      : [];
  }),
});
const document = (stages: unknown[]) => ({
  format: "workgraph-ui-plan-1",
  title: "Synthetic plan",
  stages,
});
const capture: PlanCapture = {
  connection: decode(d.connectionProfile, {
    id: "local",
    generation: "9007199254740993",
    label: "Synthetic",
    socket: "/tmp/synthetic-plans.sock",
  }),
  context: {
    workspace_id: decode(d.identifier, "workspace"),
    project_id: decode(d.identifier, "project"),
    writer: {
      actor_id: decode(d.identifier, "original"),
      run_id: decode(d.identifier, "original-run"),
    },
  },
};
function receipt(
  state: "committed" | "outcome_unknown" = "committed",
  durable = true,
): DurableStageReceipt {
  const rawParams = {
    workspace_id: "workspace",
    actor_id: "original",
    run_id: "original-run",
    operations: [],
  };
  const op = {
    format: "workgraph-ui-operation-1",
    operation_id: "saved-operation",
    preparation: {
      intention_id: "saved-intention",
      context: capture.context,
      connection: capture.connection,
      method: "transaction.apply",
      params: rawParams,
    },
    preparation_input_hash: "a".repeat(64),
    connection: capture.connection,
    request: {
      jsonrpc: "2.0",
      workgraph_api: "0.7",
      id: "exact",
      method: "transaction.apply",
      params: { ...rawParams, mutation_id: "saved" },
    },
    journal_path: "/tmp/synthetic-plans-journal.json",
    revision: "4",
    diagnostic: null,
    receipt_lookup_supported: true,
    state:
      state === "committed"
        ? {
            kind: state,
            response: {
              data: {
                results: [
                  {
                    method: "ticket.create",
                    data: { ticket_id: "actual-native-id", revision: "9007199254740993" },
                  },
                ],
              },
              meta: { durable, workspace_revision: "9007199254740994" },
            },
          }
        : { kind: state, problem: { kind: "Outcome_unknown", message: "Lost reply" } },
  };
  return {
    stage: {
      stageId: "one",
      sourceRevision: 1,
      stageIndex: 0,
      sourceStage: d.jsonObject([]),
      hash: decode(d.digest, "b".repeat(64)),
      reviewHash: decode(d.digest, "c".repeat(64)),
      params: stageParams(capture, []),
      preview: {
        baseRevision: decode(d.decimal, "1"),
        proposedRevision: decode(d.decimal, "2"),
        expandedOperationCount: decode(d.decimal, "2"),
        generatedIds: [],
        stagedBlobCount: decode(d.decimal, "0"),
        stagedBlobBytes: decode(d.decimal, "0"),
        raw: d.jsonObject([]),
      },
      intentionId: decode(d.identifier, "saved-intention"),
      prepared: true,
      captured: true,
      operationId: decode(d.identifier, "saved-operation"),
      requestHash: null,
      preparationHash: null,
    },
    operation: decode(d.operation, op),
  };
}
describe("frozen plan document and explicit staging", () => {
  it("round-trips ordered native operations and distinct stage metadata losslessly", () => {
    const parsed = decodePlan(json(document([stage("one")])));
    expect(decodePlan(planJson(parsed))).toEqual(parsed);
    expect(parsed.stages[0]?.operations.map((o) => o.method)).toEqual([
      "ticket.create",
      "ticket.hold",
    ]);
  });
  it("requires explicit boundaries instead of silently splitting129operations", () => {
    const tooMany = stage(
      "one",
      Array.from({ length: 129 }, () => ({ ...create, alias: null })),
    );
    expect(() => decodePlan(json(document([tooMany])))).toThrow(/128/);
    expect(decodePlan(json(document([stage("one"), stage("two")]))).stages).toHaveLength(2);
  });
  it("keeps atomic template.instantiate as one native operation and leaves expanded count to native", () => {
    const plan = decodePlan(
      json(
        document([
          stage("one", [
            {
              method: "template.instantiate",
              params: {
                template_id: "template",
                template_revision: "4",
                instance_id: "stable",
                parameters: {},
              },
              alias: null,
            },
          ]),
        ]),
      ),
    );
    expect(plan.stages[0]?.operations[0]?.method).toBe("template.instantiate");
    expect(() =>
      decode(preflightCodec, {
        validation: "domain_preparation",
        workspace_revision: "9",
        proposed_revision: "10",
        operation_count: "129",
        generated_ids: [],
        staged_blob_count: "0",
        staged_blob_bytes: "0",
      }),
    ).toThrow();
  });
  it("requires same-batch nonempty holds for nonfinal created tickets", () => {
    const check = (operations: unknown[]) => {
      const plan = decodePlan(json(document([stage("one", operations), stage("two")])));
      const first = plan.stages[0]!;
      validateExposure(first, first.operations, new Map());
    };
    expect(() => check([create])).toThrow(/final nonempty hold/);
    expect(() => check([create, { ...hold, params: { ...hold.params, reason: null } }])).toThrow(
      /final nonempty hold/,
    );
    expect(decodePlan(json(document([stage("one"), stage("two")]))).stages).toHaveLength(2);
  });
  it("requires partial-commit exposure review and unique local stage/creation names", () => {
    expect(() =>
      decodePlan(json(document([{ ...stage("one"), exposure: "" }, stage("two")]))),
    ).toThrow(/exposure/);
    expect(() => decodePlan(json(document([stage("one"), stage("one")])))).toThrow(/unique ID/);
    expect(() => decodePlan(json(document([stage("one", [create, create])])))).toThrow(/aliases/);
  });
  it("rejects operation attribution, nested transaction and unknown document fields", () => {
    expect(() =>
      decodePlan(
        json(
          document([
            stage("one", [{ ...create, params: { ...create.params, actor_id: "other" } }]),
          ]),
        ),
      ),
    ).toThrow(/attribution/);
    expect(() =>
      decodePlan(json(document([stage("one", [{ ...create, method: "transaction.apply" }])]))),
    ).toThrow(/non-nested/);
    expect(() => decodePlan(json({ ...document([stage("one")]), global_apply_cas: "9" }))).toThrow(
      /unknown/,
    );
  });
  it("binds actual durable receipt IDs/guards; never provisional IDs or current writer", () => {
    const second = stage(
      "two",
      [
        {
          method: "ticket.hold",
          params: { ticket_id: "placeholder", expected_revision: "0", reason: null },
          alias: null,
        },
      ],
      [
        {
          operation: 0,
          path: ["ticket_id"],
          stage: "one",
          receiptPath: ["results", "0", "data", "ticket_id"],
        },
        {
          operation: 0,
          path: ["expected_revision"],
          stage: "one",
          receiptPath: ["results", "0", "data", "revision"],
        },
      ],
    );
    const plan = decodePlan(json(document([stage("one"), second])));
    const resolved = materializeStage(plan, "two", [receipt()]);
    expect(pointer(resolved[0]!.params, ["ticket_id"])).toEqual(d.jsonString("actual-native-id"));
    expect(pointer(resolved[0]!.params, ["expected_revision"])).toEqual(
      d.jsonString("9007199254740993"),
    );
    expect(jsonField(stageParams(capture, resolved), "actor_id")).toEqual(d.jsonString("original"));
    expect(
      pointer(planJson(plan), ["stages", "1", "operations", "0", "params", "ticket_id"]),
    ).toEqual(d.jsonString("placeholder"));
  });
  it("fences all later stages on lost reply, absent receipt or non-durable response", () => {
    const plan = decodePlan(json(document([stage("one"), stage("two")])));
    for (const receipts of [[], [receipt("outcome_unknown")], [receipt("committed", false)]])
      expect(() => materializeStage(plan, "two", receipts)).toThrow(/durable committed/);
    expect(materializeStage(plan, "two", [receipt()])).toHaveLength(2);
  });
  it("rejects future-stage bindings, absent paths and duplicate destinations", () => {
    const b = {
      operation: 0,
      path: ["title"],
      stage: "two",
      receiptPath: ["results", "0", "data", "ticket_id"],
    };
    expect(() =>
      decodePlan(json(document([stage("one", [create, hold], [b]), stage("two")]))),
    ).toThrow(/preceding/);
    const known = { ...b, stage: "one" };
    expect(() =>
      decodePlan(
        json(document([stage("one"), stage("two", [create], [{ ...known, path: ["absent"] }])])),
      ),
    ).toThrow(/pointer/);
    expect(() =>
      decodePlan(json(document([stage("one"), stage("two", [create], [known, known])]))),
    ).toThrow(/same field/);
  });
  it("uses passive field lookup even for prototype names and rejects bad pointers", () => {
    expect(
      pointer(json(JSON.parse('{"__proto__":{"constructor":"literal"}}')), [
        "__proto__",
        "constructor",
      ]),
    ).toEqual(d.jsonString("literal"));
    expect(() => pointer(json({ rows: [] }), ["rows", "999999999999999999999999999"])).toThrow(
      /pointer/,
    );
  });
  it("keeps template public version distinct from metadata and requires exact public shape", () => {
    expect(
      decode(templateCodec, {
        template_id: "template",
        template_revision: "9007199254740993",
        digest: "a".repeat(64),
        spec: {},
      }).version,
    ).toBe("9007199254740993");
    expect(() =>
      decode(templateCodec, {
        resource: "template",
        resource_revision: "4",
        digest: "a".repeat(64),
        spec: {},
      }),
    ).toThrow();
  });
  it("checks final hold effect rather than a token hold occurrence", () => {
    const plan = decodePlan(
      json(
        document([
          stage("one", [create, hold, { ...hold, params: { ...hold.params, reason: null } }]),
          stage("two"),
        ]),
      ),
    );
    const first = plan.stages[0]!;
    expect(() => validateExposure(first, first.operations, new Map())).toThrow(/later clear/);
  });
  it("validates held exposure after receipt bindings can redirect the hold", () => {
    const second = stage(
      "two",
      [create, hold],
      [
        {
          operation: 1,
          path: ["ticket_id"],
          stage: "one",
          receiptPath: ["results", "0", "data", "ticket_id"],
        },
      ],
    );
    const plan = decodePlan(json(document([stage("one"), second, stage("three")])));
    const resolved = materializeStage(plan, "two", [receipt()]);
    expect(() => validateExposure(plan.stages[1]!, resolved, new Map())).toThrow(
      /redirected binding/,
    );
  });
  it("allows reviewed runnable intent with no deferred obligations without inventing readiness", () => {
    const first = {
      ...stage("one", [create]),
      exposures: [{ operation: 0, disposition: "runnable", deferred: "", templateDigest: null }],
    };
    const plan = decodePlan(json(document([first, stage("two")])));
    expect(() =>
      validateExposure(plan.stages[0]!, plan.stages[0]!.operations, new Map()),
    ).not.toThrow();
    expect(() =>
      decodePlan(
        json(
          document([
            { ...first, exposures: [{ ...first.exposures[0], deferred: "Gate in later batch" }] },
            stage("two"),
          ]),
        ),
      ),
    ).toThrow(/Deferred links or gates/);
  });
  it("requires final holds for every native instance-created ID and rejects stale preview input", () => {
    const instantiate = {
      method: "template.instantiate",
      params: {
        template_id: "template",
        template_revision: "4",
        instance_id: "stable",
        parameters: {},
      },
      alias: null,
    };
    const held = (ticket: string) => ({ ...hold, params: { ...hold.params, ticket_id: ticket } });
    const plan = decodePlan(
      json(
        document([stage("one", [instantiate, held("native-a"), held("native-b")]), stage("two")]),
      ),
    );
    const first = plan.stages[0]!,
      op = first.operations[0]!;
    const preview = {
      input: op.params,
      mode: "literal" as const,
      tickets: [decode(d.identifier, "native-a"), decode(d.identifier, "native-b")],
    };
    expect(() => validateExposure(first, first.operations, new Map())).toThrow(
      /different materialized inputs/,
    );
    expect(() =>
      validateExposure(
        first,
        first.operations,
        new Map([
          [
            0,
            {
              ...preview,
              input: d.jsonObject([...op.params.fields.map((f) => [f.name, f.value] as const)]),
            },
          ],
        ]),
      ),
    ).toThrow(/different materialized inputs/);
    expect(() =>
      validateExposure(first, first.operations.slice(0, 2), new Map([[0, preview]])),
    ).toThrow(/every created ticket/);
    expect(() => validateExposure(first, first.operations, new Map([[0, preview]]))).not.toThrow();
    expect(() =>
      validateExposure(
        first,
        first.operations,
        new Map([[0, { ...preview, mode: "native-alias" }]]),
      ),
    ).toThrow(/earlier explicit stage/);
  });
  it("matches a creation alias and its explicit literal ID consistently", () => {
    const first = stage("one", [
      { ...create, params: { ...create.params, ticket_id: "explicit" } },
      { ...hold, params: { ...hold.params, ticket_id: "explicit" } },
    ]);
    const plan = decodePlan(json(document([first, stage("two")])));
    expect(() =>
      validateExposure(plan.stages[0]!, plan.stages[0]!.operations, new Map()),
    ).not.toThrow();
  });
});
