import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as d from "../../../src/core/protocol/decoders";
import { readPinnedResource } from "../../../src/features/workflow/evidence/pinned-resource";
import { target } from "../../../src/features/workflow/evidence/model";
import { deferred, decode, harness, ok, read, response } from "./fixtures";
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
function pin(source: string) {
  return {
    resource_id: decode(d.identifier, "artifact"),
    revision: decode(d.positiveDecimal, "9007199254740993"),
    digest: decode(d.digest, hash(source)),
  };
}
function data(source: string) {
  const ref = pin(source);
  return {
    resource_id: ref.resource_id,
    version: ref.revision,
    digest: ref.digest,
    size_bytes: String(Buffer.byteLength(source)),
    text: source,
  };
}
describe("explicit exact small text proof reader", () => {
  it("reads exact historical content, independently verifies UTF-8 bytes and never requests current", async () => {
    const source = "Verified café 👋",
      ref = pin(source);
    let called = "";
    const h = harness({
      read: (method, params) => {
        called = method;
        expect(read(params, "version")).toBe(ref.revision);
        expect(read(params, "resource_id")).toBe("artifact");
        return Promise.resolve(ok(response(data(source))));
      },
    });
    const result = await readPinnedResource(
      h.client,
      target(h.context, "target"),
      ref,
      new AbortController().signal,
    );
    expect(called).toBe("resource.read");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new TextDecoder().decode(result.data.bytes)).toBe(source);
      expect(result.data.completeness).toBe("complete");
    }
  });
  it.each([
    { version: "1" },
    { resource_id: "other" },
    { size_bytes: "1" },
    { digest: "f".repeat(64) },
  ])("rejects inconsistent pinned result %j", async (change) => {
    const h = harness({
      read: () => Promise.resolve(ok(response({ ...data("proof"), ...change }))),
    });
    const result = await readPinnedResource(
      h.client,
      target(h.context, "target"),
      pin("proof"),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
  });
  it("detects corrupt bytes even when returned metadata repeats the expected digest", async () => {
    const h = harness({
      read: () => Promise.resolve(ok(response({ ...data("proof"), text: "wrong" }))),
    });
    const result = await readPinnedResource(
      h.client,
      target(h.context, "target"),
      pin("proof"),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.failure.kind === "protocol" && result.failure.message).toContain("SHA-256");
  });
  it("captures caller-owned source scalars before a deferred native read", async () => {
    const pending = deferred<ReturnType<typeof ok<ReturnType<typeof response>>>>(),
      h = harness({ read: () => pending.promise }),
      ref = pin("proof"),
      reading = readPinnedResource(
        h.client,
        target(h.context, "target"),
        ref,
        new AbortController().signal,
      );
    ref.digest = decode(d.digest, "e".repeat(64));
    ref.revision = decode(d.positiveDecimal, "1");
    pending.resolve(ok(response(data("proof"))));
    expect((await reading).ok).toBe(true);
  });
  it("keeps missing/native failure distinct and does not silently fall back", async () => {
    const h = harness({
      read: () =>
        Promise.resolve({
          ok: false,
          failure: {
            kind: "remote",
            problem: { kind: "Not_found", message: "Pinned content absent", details: undefined },
            httpStatus: 404,
          },
        }),
    });
    const result = await readPinnedResource(
      h.client,
      target(h.context, "target"),
      pin("proof"),
      new AbortController().signal,
    );
    expect(!result.ok && result.failure.kind === "remote" && result.failure.problem.kind).toBe(
      "Not_found",
    );
  });
  it("rejects oversized complete text before exposure", async () => {
    const source = "x".repeat(65537),
      h = harness({ read: () => Promise.resolve(ok(response(data(source)))) });
    const result = await readPinnedResource(
      h.client,
      target(h.context, "target"),
      pin(source),
      new AbortController().signal,
    );
    expect(!result.ok && result.failure.kind === "protocol" && result.failure.message).toContain(
      "budget",
    );
  });
  it("preserves unexpected crypto defects rather than disguising them as corrupt data", async () => {
    const defect = new TypeError("crypto implementation defect"),
      h = harness({ read: () => Promise.resolve(ok(response(data("proof")))) });
    vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(defect);
    await expect(
      readPinnedResource(
        h.client,
        target(h.context, "target"),
        pin("proof"),
        new AbortController().signal,
      ),
    ).rejects.toBe(defect);
  });
  it("does not publish a late uncooperative read after cancellation", async () => {
    const pending = deferred<ReturnType<typeof ok<ReturnType<typeof response>>>>(),
      h = harness({ read: () => pending.promise }),
      abort = new AbortController(),
      reading = readPinnedResource(
        h.client,
        target(h.context, "target"),
        pin("proof"),
        abort.signal,
      );
    abort.abort();
    pending.resolve(ok(response(data("proof"))));
    expect(await reading).toEqual({ ok: false, failure: { kind: "aborted" } });
  });
});
