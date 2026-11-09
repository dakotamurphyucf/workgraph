import { afterEach, describe, expect, it } from "vitest";
import * as d from "../../../src/core/protocol/decoders";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import { jsonField } from "../../../src/core/json";
import { createResourceUploadController } from "../../../src/features/knowledge/resources/upload-controller";
import { context, decode, json } from "../../work/actions-fixtures";
const size = 2 * 262144 + 17,
  sha = "a".repeat(64),
  close: (() => void)[] = [];
afterEach(() => close.splice(0).forEach((f) => f()));
function fixture(mode: "third-before-apply" | "second-lost-ack" | "sealed-lost-ack") {
  let received = 0,
    sealed = false,
    failed = false,
    stageId = "";
  const offsets: number[] = [],
    beginIds: string[] = [];
  const http: HttpClient = {
    processing: {} as HttpClient["processing"],
    request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
      const body = request.body!;
      const text = (name: string) => {
        const field = jsonField(body, name);
        return field?.kind === "string" ? field.value : "";
      };
      if (request.path === "/resource-stages/prepare") {
        stageId = text("stage_id");
        beginIds.push(stageId);
      }
      if (request.path.endsWith("/chunks")) {
        const offset = Number(text("offset")),
          bytes = atob(text("data_base64"));
        offsets.push(offset);
        if (!failed && mode === "third-before-apply" && offset === 524288) {
          failed = true;
          return Promise.resolve({
            ok: false,
            failure: { kind: "network", message: "Synthetic interrupted range" },
          });
        }
        received = Math.max(received, offset + bytes.length);
        if (!failed && mode === "second-lost-ack" && offset === 262144) {
          failed = true;
          return Promise.resolve({
            ok: false,
            failure: { kind: "network", message: "Synthetic lost chunk acknowledgement" },
          });
        }
      }
      if (request.path.endsWith("/seal")) {
        sealed = true;
        if (!failed && mode === "sealed-lost-ack") {
          failed = true;
          return Promise.resolve({
            ok: false,
            failure: { kind: "network", message: "Synthetic lost seal acknowledgement" },
          });
        }
      }
      const result = request.codec.decode(
        json({
          stage_id: stageId,
          digest: sha,
          size_bytes: String(size),
          received: String(received),
          status: sealed ? "sealed" : "incoming",
          source_retained: true,
          intention_id: null,
          diagnostic: null,
        }),
      );
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
  const ctx = context(http),
    controller = createResourceUploadController(http, {
      hash: () => Promise.resolve(decode(d.digest, sha)),
    });
  close.push(controller.dispose);
  controller.open(ctx, { connection: ctx.connection, workspaceId: decode(d.identifier, "demo") });
  const initial = controller.get().drafts[0]!;
  controller.edit(
    initial.id,
    { ...initial.input, resourceId: "artifact", title: "Artifact" },
    new File([new Uint8Array(size)], "artifact.bin"),
  );
  return { controller, id: initial.id, stageId: initial.stageId, offsets, beginIds };
}
describe("exact interrupted Resource staging continuation", () => {
  it.each(["third-before-apply", "second-lost-ack", "sealed-lost-ack"] as const)(
    "resumes %s from native retained boundary with same full source/intention",
    async (mode) => {
      const f = fixture(mode);
      await f.controller.stage(f.id);
      expect(f.controller.get().drafts[0]?.phase).toBe("interrupted");
      const before = f.offsets.length;
      await f.controller.stage(f.id);
      expect(f.controller.get().drafts[0]?.phase).toBe("sealed");
      expect(f.controller.get().drafts[0]?.received).toBe(size);
      expect(f.beginIds).toEqual([f.stageId, f.stageId]);
      expect(f.controller.get().drafts[0]?.id).toBe(f.id);
      expect(f.offsets.slice(before)).toEqual(mode === "sealed-lost-ack" ? [] : [524288]);
    },
  );
});
