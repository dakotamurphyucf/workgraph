import { describe, expect, it, vi } from "vitest";
import { evidenceData, harness, ok, response } from "./fixtures";

describe("evidence read error ownership", () => {
  it.each(["evidence.context", "review.gate"])(
    "a superseded %s rejection does not poison the refreshed view",
    async (method) => {
      let reject: (reason: unknown) => void = () => {
        throw new Error("not pending");
      };
      let started = false;
      const pending = new Promise<never>((_, fail) => {
        reject = fail;
      });
      const { controller, context } = harness({
        read: (name) => {
          if (name === method && !started) {
            started = true;
            return pending;
          }
          return Promise.resolve(
            ok(
              response(
                name === "evidence.context" ? evidenceData : { allowed: true, problem: null },
              ),
            ),
          );
        },
      });
      const selected = controller.select(context, "target");
      await vi.waitFor(() => expect(started).toBe(true));
      await controller.refresh();
      expect(controller.get().evidence.kind).toBe("ready");
      expect(controller.get().gate.kind).toBe("ready");
      reject(new TypeError("obsolete evidence defect"));
      await selected;
      expect(controller.get().unexpected).toBeNull();
      expect(controller.get().evidence.kind).toBe("ready");
      expect(controller.get().gate.kind).toBe("ready");
    },
  );
  it("a current read defect remains observable in its slot", async () => {
    const defect = new TypeError("current evidence defect");
    const { controller, context } = harness({
      read: (method) =>
        method === "evidence.context"
          ? Promise.reject(defect)
          : Promise.resolve(ok(response({ allowed: true, problem: null }))),
    });
    await controller.select(context, "target");
    expect(controller.get().evidence).toMatchObject({ kind: "unexpected_error", error: defect });
  });
});
