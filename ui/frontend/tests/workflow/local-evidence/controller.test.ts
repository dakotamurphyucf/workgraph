import { afterEach, describe, expect, it } from "vitest";
import { createLocalEvidenceController } from "../../../src/features/workflow/local-evidence/controller";
import type {
  ExecutionClient,
  PublicationPlan,
} from "../../../src/features/workflow/local-evidence/types";
import type { HttpResult } from "../../../src/core/protocol/http";
import type {
  TransferResult,
  VerifiedTransfer,
} from "../../../src/features/history/transcript/transfer.types";
import { harness } from "../../participants/runs/harness";
import { decimal, digest, decode, deferred, job, ok, output, stage } from "./fixtures";
import { transferRequest } from "../../../src/features/history/transcript/transfer-wire";
import * as d from "../../../src/core/protocol/decoders";
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((f) => f()),
);
function setup(overrides: Partial<ExecutionClient> = {}, transfer?: VerifiedTransfer) {
  const h = harness(),
    prepared: PublicationPlan[] = [];
  const api: ExecutionClient = {
    inspectStage: (target) => Promise.resolve(ok({ ...stage, directory: target.directory })),
    inspectOutput: (target, stream, selection) =>
      Promise.resolve(
        ok({ ...output, directory: target.directory, stream, selection: selection.kind }),
      ),
    inspectIntent: (target) =>
      Promise.resolve(
        ok({
          directory: target.directory,
          intent_digest: decode(d.digest, digest),
          saved_request: `${target.directory}/publication.json`,
          request: d.jsonObject([]),
          original_endpoint_recorded: false,
        }),
      ),
    prepare: (input) => {
      prepared.push(input);
      return Promise.resolve(
        ok(
          job(
            input,
            input.kind === "operator_bound_external" ? "outcome_unknown" : "prepared_unsent",
          ),
        ),
      );
    },
    start: () => Promise.reject(new Error("unexpected start")),
    retryExact: () => Promise.reject(new Error("unexpected retry")),
    recover: () => Promise.reject(new Error("unexpected receipt recovery")),
    inspect: () => Promise.reject(new Error("unexpected inspection")),
    list: () => Promise.resolve(ok({ items: [], next_offset: null, total: decimal("0") })),
    cleanup: (target) => Promise.resolve(ok({ directory: target.directory, cleaned: true })),
    ...overrides,
  };
  const controller = createLocalEvidenceController({
    http: h.http,
    operations: h.operations,
    client: api,
    identity: () => "intention",
    ...(transfer === undefined ? {} : { transfer }),
  });
  cleanup.push(controller.dispose);
  return { ...h, controller, prepared };
}
async function inspect(h: ReturnType<typeof setup>, directory = "/tmp/stage") {
  h.controller.setDirectory(directory);
  await h.controller.inspectStage();
}
describe("Local evidence captured ownership and source isolation", () => {
  it("freezes original target/writer before review and never invokes a command or operation controller", async () => {
    const h = setup(),
      writer = { actorId: "author", runId: "run" },
      connection = { ...h.context.connection };
    await inspect(h);
    h.controller.newPublication({ ...h.context, writer, connection });
    h.controller.edit({ resourceId: "artifact", title: "Capture" });
    writer.actorId = "changed-writer";
    connection.socket = "/tmp/changed.sock";
    await h.controller.review();
    expect(h.prepared).toHaveLength(1);
    const plan = h.prepared[0];
    expect(plan?.kind).toBe("ui_prepared");
    if (plan?.kind !== "ui_prepared") throw new Error("plan");
    expect(plan.params.actor_id).toBe("author");
    expect(plan.params.run_id).toBe("run");
    expect(plan.connection.socket).toBe(h.context.connection.socket);
    expect(plan.params.mutation_id).toBe(plan.intention_id);
    expect(h.sent).toHaveLength(0);
  });
  it("retains exact locally uncertain preparation for explicit same-plan saving", async () => {
    const inputs: PublicationPlan[] = [];
    const h = setup({
      prepare: (plan) => {
        inputs.push(plan);
        return Promise.resolve({
          ok: false,
          failure: { kind: "network", message: "Lost local preparation reply" },
        });
      },
    });
    await inspect(h);
    h.controller.newPublication(h.context);
    h.controller.edit({ resourceId: "artifact" });
    await h.controller.review();
    expect(h.controller.get().draft?.kind).toBe("captured");
    expect(h.controller.get().busy).toBe(false);
    h.controller.edit({ title: "cannot change captured input" });
    await h.controller.finishSaving();
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toEqual(inputs[0]);
    expect(h.controller.get().notice?.kind).toBe("request_failure");
  });
  it("ignores obsolete inspection failures after selecting another directory", async () => {
    const pending =
      deferred<
        HttpResult<import("../../../src/features/workflow/local-evidence/types").StageSnapshot>
      >();
    let first = true;
    const h = setup({
      inspectStage: (target) => {
        if (first) {
          first = false;
          return pending.promise;
        }
        return Promise.resolve(ok({ ...stage, directory: target.directory }));
      },
    });
    h.controller.setDirectory("/tmp/a");
    const a = h.controller.inspectStage();
    await inspect(h, "/tmp/b");
    pending.reject(new TypeError("obsolete stage read"));
    await a;
    expect(h.controller.get().unexpected).toBeNull();
    const state = h.controller.get().stage;
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") expect(state.value.directory).toBe("/tmp/b");
  });
  it("supplies a closed exact BlobRef to the reused transfer worker boundary", async () => {
    let valid = false;
    const transfer: VerifiedTransfer = {
      download: async (_source, supplier) => {
        const chunk = await supplier.read("0", new AbortController().signal);
        if (chunk.ok) valid = transferRequest({ kind: "chunk", chunk: chunk.data }) !== null;
        return { ok: true, blob: new Blob(["binary"]), digest };
      },
      dispose: () => undefined,
    };
    const h = setup({}, transfer);
    await inspect(h);
    await h.controller.download();
    expect(valid).toBe(true);
  });
  it("cancels and detaches in-flight A download before B stage and ignores late progress/completion", async () => {
    const pending = deferred<TransferResult>();
    let signal: AbortSignal | undefined;
    let progress: ((received: number, total: number) => void) | undefined;
    const transfer: VerifiedTransfer = {
      download: (_source, _supplier, changed, abort) => {
        signal = abort;
        progress = changed;
        return pending.promise;
      },
      dispose: () => undefined,
    };
    const h = setup({}, transfer);
    await inspect(h, "/tmp/a");
    const work = h.controller.download();
    expect(h.controller.get().download.kind).toBe("running");
    await inspect(h, "/tmp/b");
    expect(signal?.aborted).toBe(true);
    progress?.(4, 4);
    pending.resolve({ ok: true, blob: new Blob(["old bytes"]), digest });
    await work;
    expect(h.controller.get().download.kind).toBe("idle");
  });
  it("suppresses obsolete download exceptions but preserves a current unexpected failure", async () => {
    const pending = deferred<TransferResult>();
    const transfer: VerifiedTransfer = {
      download: () => pending.promise,
      dispose: () => undefined,
    };
    const h = setup({}, transfer);
    await inspect(h, "/tmp/a");
    const work = h.controller.download();
    await inspect(h, "/tmp/b");
    pending.reject(new TypeError("obsolete transfer"));
    await work;
    expect(h.controller.get().unexpected).toBeNull();
    const current = setup(
      {},
      {
        download: () => Promise.reject(new TypeError("current transfer")),
        dispose: () => undefined,
      },
    );
    await inspect(current);
    await current.controller.download();
    expect(current.controller.get().unexpected?.error).toBeInstanceOf(TypeError);
  });
  it("clears ready A blob on stream change and on explicit same-stage refresh", async () => {
    const transfer: VerifiedTransfer = {
      download: () => Promise.resolve({ ok: true, blob: new Blob(["binary"]), digest }),
      dispose: () => undefined,
    };
    const h = setup({}, transfer);
    await inspect(h);
    await h.controller.download();
    expect(h.controller.get().download.kind).toBe("ready");
    await h.controller.inspectOutput("stderr", { kind: "retained_tail", length: decimal("4") });
    expect(h.controller.get().download.kind).toBe("idle");
    await h.controller.download();
    expect(h.controller.get().download.kind).toBe("ready");
    await h.controller.inspectStage();
    expect(h.controller.get().download.kind).toBe("idle");
  });
  it("external association never calls start and preserves unknown outcome", async () => {
    let starts = 0;
    const h = setup({
      start: () => {
        starts++;
        return Promise.reject(new Error("must not send"));
      },
    });
    await inspect(h);
    await h.controller.inspectIntent();
    await h.controller.associate(h.context.connection);
    expect(starts).toBe(0);
    expect(h.prepared[0]?.kind).toBe("operator_bound_external");
    expect(h.controller.get().jobs[0]?.state.kind).toBe("outcome_unknown");
  });
});
