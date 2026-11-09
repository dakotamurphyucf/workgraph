import { describe, expect, it } from "vitest";
import * as d from "../../../src/core/protocol/decoders";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import { jsonField } from "../../../src/core/json";
import { createResourceUploadController } from "../../../src/features/knowledge/resources/upload-controller";
import { context, decode, json } from "../../work/actions-fixtures";
const sha = "a".repeat(64);
function job(id: string, stage: string, phase = "prepared_unsent") {
  const params = {
      workspace_id: "demo",
      actor_id: "author",
      run_id: "run-one",
      resource_id: "artifact",
      expected_revision: "0",
      title: "Artifact",
      filename: "artifact.bin",
      mime_type: "application/octet-stream",
    },
    native = {
      ...params,
      digest: sha,
      size_bytes: "3",
      mutation_id: "synthetic-fixed",
      transfer_version: "2",
      upload_id: "synthetic-upload",
      file: "/tmp/synthetic/source",
    };
  return {
    format: "workgraph-ui-resource-upload-job-1",
    intention_id: id,
    plan: {
      format: "workgraph-ui-resource-upload-plan-1",
      intention_id: id,
      connection: {
        id: "local",
        generation: "1",
        label: "Synthetic",
        socket: "/tmp/synthetic.sock",
      },
      context: {
        workspace_id: "demo",
        project_id: "list-project",
        writer: { actor_id: "author", run_id: "run-one" },
      },
      stage_id: stage,
      params,
    },
    native_plan: native,
    saved_request: {
      id: "upload",
      jsonrpc: "2.0",
      workgraph_api: "0.7",
      method: "resource.upload",
      params: native,
    },
    journal_path: "/tmp/synthetic/request",
    input_hash: sha,
    revision: "1",
    phase: { kind: phase },
    diagnostic: null,
  };
}
function decoded<T>(request: HttpRequest<T>, value: unknown): HttpResult<T> {
  const parsed = request.codec.decode(json(value));
  if (!parsed.ok) throw new Error(`${parsed.issue.path.join(".")}: ${parsed.issue.expected}`);
  return { ok: true, data: parsed.value, httpStatus: 200 };
}
describe("native upload shelf selection ownership and saved-plan recovery", () => {
  it("observes with GET only and ignores cancelled or superseded observations", async () => {
    const calls: HttpRequest<unknown>[] = [];
    let release: (() => void) | undefined;
    const http: HttpClient = {
      processing: {} as HttpClient["processing"],
      request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        calls.push(request);
        const id = request.path.split("/").at(-1)!;
        if (request.signal)
          return new Promise((resolve) => {
            release = () => resolve(decoded(request, { ...job(id, "source"), revision: "2" }));
          });
        return Promise.resolve(decoded(request, job(id, "source")));
      },
    };
    const controller = createResourceUploadController(http);
    const a = decode(d.identifier, "job-a"),
      b = decode(d.identifier, "job-b");
    try {
      await controller.inspect(a);
      const abort = new AbortController();
      const cancelled = controller.observe(a, abort.signal);
      abort.abort();
      release!();
      await cancelled;
      expect(controller.get().selectedJob?.revision).toBe("1");
      expect(controller.get().issue).toBeNull();
      const stale = controller.observe(a, new AbortController().signal);
      await controller.inspect(b);
      release!();
      await stale;
      expect(controller.get().selectedJob?.intention_id).toBe(b);
      const fresh = controller.observe(b, new AbortController().signal);
      release!();
      await fresh;
      expect(controller.get().selectedJob?.revision).toBe("2");
      expect(calls.every((request) => request.method === "GET")).toBe(true);
    } finally {
      controller.dispose();
    }
  });
  it("retains prepared A while a later explicit inspection B owns shelf selection", async () => {
    let stageId = "",
      release: () => void = () => {
        throw new Error("No pending preparation");
      };
    const http: HttpClient = {
      processing: {} as HttpClient["processing"],
      request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        if (request.path === "/resource-uploads/prepare")
          return new Promise((resolve) => {
            const raw = jsonField(request.body!, "preparation")!,
              id = jsonField(raw, "intention_id");
            if (id?.kind !== "string") throw new Error("No identity");
            release = () => resolve(decoded(request, job(id.value, stageId)));
          });
        if (request.path === "/resource-uploads/job-b")
          return Promise.resolve(decoded(request, job("job-b", "source-b")));
        if (request.path === "/resource-stages/prepare") {
          const value = jsonField(request.body!, "stage_id");
          if (value?.kind !== "string") throw new Error("No stage");
          stageId = value.value;
        }
        return Promise.resolve(
          decoded(request, {
            stage_id: stageId,
            digest: sha,
            size_bytes: "3",
            received:
              request.path.endsWith("/chunks") || request.path.endsWith("/seal") ? "3" : "0",
            status: request.path.endsWith("/seal") ? "sealed" : "incoming",
            source_retained: true,
            intention_id: null,
            diagnostic: null,
          }),
        );
      },
    };
    const ctx = context(http),
      controller = createResourceUploadController(http, {
        hash: () => Promise.resolve(decode(d.digest, sha)),
      });
    try {
      controller.open(ctx, {
        connection: ctx.connection,
        workspaceId: decode(d.identifier, "demo"),
      });
      const draft = controller.get().drafts[0]!;
      controller.edit(
        draft.id,
        { ...draft.input, resourceId: "artifact", title: "Artifact" },
        new File(["abc"], "artifact.bin"),
      );
      await controller.stage(draft.id);
      const pending = controller.prepare(draft.id);
      await controller.inspect(decode(d.identifier, "job-b"));
      expect(controller.get().selectedJob?.intention_id).toBe("job-b");
      release();
      await pending;
      expect(controller.get().selectedJob?.intention_id).toBe("job-b");
      expect(controller.get().drafts[0]?.phase).toBe("prepared");
    } finally {
      controller.dispose();
    }
  });
  it("finishes exact local journal save from durable inventory without any source draft/hash call", async () => {
    const calls: HttpRequest<unknown>[] = [],
      retained = job("saved-upload", "saved-source", "local_save_incomplete");
    const http: HttpClient = {
      processing: {} as HttpClient["processing"],
      request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        calls.push(request);
        return Promise.resolve(
          decoded(
            request,
            request.path.startsWith("/resource-stages?")
              ? {
                  items: [],
                  offset: "0",
                  remaining: "0",
                  next_offset: null,
                  retained_bytes: "3",
                  maximum_retained_bytes: "134217728",
                  incoming_count: "0",
                }
              : request.path.startsWith("/resource-uploads?")
                ? { items: [retained], offset: "0", remaining: "0", next_offset: null }
                : job("saved-upload", "saved-source"),
          ),
        );
      },
    };
    const controller = createResourceUploadController(http, {
      hash: () => Promise.reject(new Error("Recovery must not hash/reupload source")),
    });
    try {
      await controller.inventory();
      expect(controller.get().drafts).toHaveLength(0);
      await controller.finishSaving(decode(d.identifier, "saved-upload"));
      expect(controller.get().issue).toBeNull();
      expect(controller.get().selectedJob?.phase.kind).toBe("prepared_unsent");
      expect(calls.map((c) => c.method + ":" + c.path)).toEqual([
        "GET:/resource-uploads?offset=0&limit=100",
        "GET:/resource-stages?offset=0&limit=100",
        "POST:/resource-uploads/prepare",
      ]);
      const body = calls[2]!.body!,
        preparation = jsonField(body, "preparation")!;
      expect(jsonField(body, "stage_id")).toEqual(d.jsonString("saved-source"));
      expect(jsonField(preparation, "intention_id")).toEqual(d.jsonString("saved-upload"));
      expect(jsonField(preparation, "params")).toEqual(json(retained.plan.params));
    } finally {
      controller.dispose();
    }
  });
});
