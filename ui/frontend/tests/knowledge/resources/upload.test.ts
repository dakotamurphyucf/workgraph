import { afterEach, describe, expect, it } from "vitest";
import * as d from "../../../src/core/protocol/decoders";
import { jsonField } from "../../../src/core/json";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import type { Digest } from "../../../src/core/protocol/types";
import {
  createResourceUploadController,
  uploadPreparation,
} from "../../../src/features/knowledge/resources/upload-controller";
import {
  stageCodec,
  uploadJobCodec,
  stagePageCodec,
  jobPageCodec,
} from "../../../src/features/knowledge/resources/upload-codecs";
import { context, decode, json } from "../../work/actions-fixtures";
const sha = "a".repeat(64),
  cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
});
function fixture(hash: () => Promise<Digest> = () => Promise.resolve(decode(d.digest, sha))) {
  const calls: HttpRequest<unknown>[] = [],
    http: HttpClient = {
      processing: {} as HttpClient["processing"],
      request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
        calls.push(request);
        const body = request.body,
          field = (name: string) => {
            const value = body === undefined ? undefined : jsonField(body, name);
            return value?.kind === "string" ? value.value : "";
          };
        const stageId = request.path.split("/")[2] ?? field("stage_id");
        const bytes = field("data_base64"),
          received = bytes
            ? String(Number(field("offset")) + atob(bytes).length)
            : request.path.endsWith("/seal")
              ? "3"
              : "0";
        const value = {
          stage_id: request.path === "/resource-stages/prepare" ? field("stage_id") : stageId,
          digest: sha,
          size_bytes: "3",
          received,
          status: request.path.endsWith("/seal") ? "sealed" : "incoming",
          source_retained: true,
          intention_id: null,
          diagnostic: null,
        };
        const result = request.codec.decode(json(value));
        return Promise.resolve(
          result.ok
            ? { ok: true, data: result.value, httpStatus: 200 }
            : {
                ok: false,
                failure: { kind: "protocol", message: result.issue.expected, issue: result.issue },
              },
        );
      },
    };
  const original = context(http),
    ctx = { ...original, writer: { ...original.writer } },
    scope = { connection: ctx.connection, workspaceId: decode(d.identifier, "demo") };
  const controller = createResourceUploadController(http, { hash });
  cleanups.push(controller.dispose);
  controller.open(ctx, scope);
  return { controller, calls, ctx, scope, http };
}
function fill(f: ReturnType<typeof fixture>) {
  const draft = f.controller.get().drafts[0]!;
  f.controller.edit(
    draft.id,
    {
      ...draft.input,
      resourceId: "artifact",
      title: "Artifact",
      filename: "a.bin",
      mimeType: "application/octet-stream",
    },
    new File([new Uint8Array([0, 255, 17])], "a.bin"),
  );
  return f.controller.get().drafts[0]!;
}
describe("independent native upload browser owner", () => {
  it("keeps repairable missing input editable and sends no staging request", async () => {
    const f = fixture(),
      draft = f.controller.get().drafts[0]!;
    await f.controller.stage(draft.id);
    expect(f.calls).toHaveLength(0);
    expect(f.controller.get().drafts[0]?.phase).toBe("editing");
    expect(f.controller.get().drafts[0]?.issue).toContain("source file");
  });
  it("hashes/stages one exact immutable source before native preparation", async () => {
    const f = fixture(),
      draft = fill(f);
    await f.controller.stage(draft.id);
    expect(f.controller.get().drafts[0]?.phase).toBe("sealed");
    expect(f.calls.map((c) => c.path)).toEqual([
      "/resource-stages/prepare",
      `/resource-stages/${draft.stageId}/chunks`,
      `/resource-stages/${draft.stageId}/seal`,
    ]);
    expect(jsonField(f.calls[1]!.body!, "data_base64")).toEqual(d.jsonString("AP8R"));
    expect(f.calls.some((c) => c.path.startsWith("/resource-uploads"))).toBe(false);
  });
  it("freezes actor/file/guard before asynchronous hashing, rejects edits/close during staging", async () => {
    let release!: (sha: Digest) => void;
    const f = fixture(
        () =>
          new Promise((r) => {
            release = r;
          }),
      ),
      draft = fill(f);
    const pending = f.controller.stage(draft.id);
    f.controller.edit(draft.id, { ...draft.input, title: "Changed" }, new File(["new"], "new.txt"));
    f.controller.close(draft.id);
    f.ctx.writer.actorId = "other";
    expect(f.controller.get().drafts).toHaveLength(1);
    release(decode(d.digest, sha));
    await pending;
    const frozen = f.controller.get().drafts[0]!;
    expect(frozen.input.title).toBe("Artifact");
    expect(uploadPreparation(frozen).context.writer.actor_id).toBe("author");
  });
  it("cancels pre-admission observation without deleting uncertain private inputs or sending a mutation", async () => {
    let release!: (sha: Digest) => void;
    const f = fixture(
        () =>
          new Promise((r) => {
            release = r;
          }),
      ),
      draft = fill(f);
    const pending = f.controller.stage(draft.id);
    f.controller.cancelStaging(draft.id);
    release(decode(d.digest, sha));
    await pending;
    expect(f.calls).toHaveLength(0);
    expect(f.controller.get().drafts[0]?.phase).toBe("interrupted");
    expect(f.controller.get().drafts[0]?.issue).toContain("Inspect retained input");
  });
  it("preserves unexpected hashing failures for an owned error boundary", async () => {
    const error = new Error("worker failure"),
      f = fixture(() => Promise.reject(error)),
      draft = fill(f);
    await f.controller.stage(draft.id);
    expect(f.controller.get().drafts[0]?.unexpected?.error).toBe(error);
    expect(f.calls).toHaveLength(0);
  });
  it("does not overwrite native input identity on acknowledgement mismatch", async () => {
    const f = fixture(() => Promise.resolve(decode(d.digest, "b".repeat(64)))),
      draft = fill(f);
    await f.controller.stage(draft.id);
    expect(f.calls).toHaveLength(1);
    expect(f.controller.get().drafts[0]?.phase).toBe("interrupted");
    expect(f.controller.get().drafts[0]?.issue).toContain("identity");
  });
});
describe("native resource transfer observation validation", () => {
  it("decodes the exact native stage inventory envelope once including capacity", () => {
    const page = {
      items: [
        {
          stage_id: "source",
          digest: sha,
          size_bytes: "3",
          received: "3",
          status: "sealed",
          source_retained: true,
          intention_id: null,
          diagnostic: null,
        },
      ],
      offset: "0",
      next_offset: null,
      remaining: "0",
      retained_bytes: "3",
      maximum_retained_bytes: "134217728",
      incoming_count: "1",
    };
    expect(stagePageCodec.decode(json(page)).ok).toBe(true);
    expect(stagePageCodec.decode(json({ ...page, unknown: true })).ok).toBe(false);
    expect(
      stagePageCodec.decode(json({ ...page, items: [], remaining: "1", next_offset: "0" })).ok,
    ).toBe(false);
    expect(
      jobPageCodec.decode(json({ items: [], offset: "0", remaining: "1", next_offset: "0" })).ok,
    ).toBe(false);
  });
  it("rejects malformed sealed offsets and impossible cleaned unprepared input", () => {
    const stage = {
      stage_id: "source",
      digest: sha,
      size_bytes: "3",
      received: "2",
      status: "sealed",
      source_retained: true,
      intention_id: null,
      diagnostic: null,
    };
    expect(stageCodec.decode(json(stage)).ok).toBe(false);
    expect(stageCodec.decode(json({ ...stage, received: "3", source_retained: false })).ok).toBe(
      false,
    );
  });
  it("requires a durable publication rather than trusting phase name", () => {
    const native = {
      workspace_id: "demo",
      actor_id: "author",
      resource_id: "artifact",
      expected_revision: "0",
      title: "Artifact",
      filename: "a.bin",
      mime_type: "application/octet-stream",
      digest: sha,
      size_bytes: "3",
    };
    const job = {
      format: "workgraph-ui-resource-upload-job-1",
      intention_id: "upload",
      plan: {
        format: "workgraph-ui-resource-upload-plan-1",
        intention_id: "upload",
        connection: {
          id: "local",
          generation: "1",
          label: "Synthetic",
          socket: "/tmp/synthetic.sock",
        },
        context: {
          workspace_id: "demo",
          project_id: null,
          writer: { actor_id: "author", run_id: null },
        },
        stage_id: "source",
        params: native,
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
      diagnostic: null,
      phase: {
        kind: "published",
        publication: {
          data: {
            resource_id: "artifact",
            revision: "1",
            version: {
              revision: "1",
              digest: sha,
              size_bytes: "3",
              actor_id: "author",
              timestamp: "synthetic",
              filename: "a.bin",
              mime_type: "application/octet-stream",
            },
          },
          meta: { durable: false, workspace_revision: "99" },
        },
        link: { kind: "not_requested" },
      },
    };
    expect(uploadJobCodec.decode(json(job)).ok).toBe(false);
    expect(
      uploadJobCodec.decode(
        json({
          ...job,
          phase: {
            ...job.phase,
            publication: {
              ...job.phase.publication,
              meta: { durable: true, workspace_revision: "99" },
            },
          },
        }),
      ).ok,
    ).toBe(true);
  });
});
