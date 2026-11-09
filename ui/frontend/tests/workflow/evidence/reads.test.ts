import { describe, expect, it } from "vitest";
import { jsonField } from "../../../src/core/json";
import { initialReadInputs, readParams } from "../../../src/features/workflow/evidence/reads";
import { read } from "./fixtures";
describe("readable exact evidence selectors", () => {
  it("does not send a ticket selector to workspace-wide contract collections", () => {
    expect(
      jsonField(readParams("contract.list", "demo", "target", initialReadInputs), "ticket_id"),
    ).toBeUndefined();
  });
  it("uses selected ticket and explicit policy scope without current-project inference", () => {
    const params = readParams("acceptance.policy.get", "demo", "target", initialReadInputs);
    expect(read(jsonField(params, "scope"), "ticket_id")).toBe("target");
    expect(() =>
      readParams("acceptance.policy.get", "demo", "target", {
        ...initialReadInputs,
        scopeKind: "project",
      }),
    ).toThrow();
  });
  it("keeps resource/object revisions as exact source strings", () => {
    expect(
      read(
        readParams("contract.get", "demo", "target", {
          ...initialReadInputs,
          objectId: "contract",
          version: "9007199254740993",
        }),
        "version",
      ),
    ).toBe("9007199254740993");
  });
  it.each([
    { maxBytes: "0" },
    { maxBytes: "1048577" },
    { limit: "101" },
    { offset: "1" },
    { version: "0" },
  ])("rejects invalid bounded read %j", (change) => {
    expect(() =>
      readParams(
        Object.hasOwn(change, "version") ? "contract.get" : "contract.list",
        "demo",
        "target",
        { ...initialReadInputs, objectId: "contract", ...change },
      ),
    ).toThrow();
  });
  it("uses the runs namespace guard for conditions and evidence revision for reviews", () => {
    expect(
      read(
        readParams("condition.signals", "demo", "target", {
          ...initialReadInputs,
          objectId: "condition",
          offset: "2",
          revision: "9",
        }),
        "expected_revision",
      ),
    ).toBe("9");
    expect(
      read(
        readParams("review.list", "demo", "target", {
          ...initialReadInputs,
          offset: "2",
          revision: "9",
        }),
        "revision",
      ),
    ).toBe("9");
  });
});
