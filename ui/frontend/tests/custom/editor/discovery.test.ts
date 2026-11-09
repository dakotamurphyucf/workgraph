import { afterEach, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initialQuery } from "../../../src/features/custom/config";
import { jsonField } from "../../../src/core/json";
import { RowsPresentation } from "../../../src/features/custom/editor/presentation/RowsPresentation";
import {
  personalTitle,
  validatedPersonalTitle,
} from "../../../src/features/custom/editor/personal-labels";
import {
  defaultRenderer,
  defaultView,
  id,
  counter,
} from "../../../src/features/custom/editor/model";
import { createTestProcessor } from "../../core/processing-harness";
import { view } from "../config/fixtures";
import { target } from "./fixtures";
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()));

it("explains workspace-linked resources even when captured empty or partial, preserving native query", () => {
  const processing = createTestProcessor();
  cleanup.push(processing.dispose);
  const config = view("resources");
  expect(jsonField(initialQuery(config, target.workspaceId).params, "target")).toEqual({
    kind: "object",
    fields: [{ name: "kind", value: { kind: "string", value: "workspace" } }],
  });
  for (const complete of [true, false]) {
    const html = renderToStaticMarkup(
      createElement(RowsPresentation, {
        identity: "capture",
        view: config,
        rows: [],
        processing,
        coverage: {
          complete,
          partial: false,
          capture: [],
          stop: complete ? "complete" : "page_limit",
        },
      }),
    );
    expect(html).toContain("Resources linked to this workspace.");
    expect(html).toContain("Unlinked resources can still appear in the Resources directory");
    expect(html).toContain(complete ? "All collection pages loaded" : "More records may remain");
    expect(html.includes("This does not prove the collection is empty.")).toBe(!complete);
  }
});

it("only projects validated matching view/renderer titles, retaining unsupported and malformed source", async () => {
  const processing = createTestProcessor();
  cleanup.push(processing.dispose);
  const documentId = id("saved"),
    signal = new AbortController().signal;
  const valid = [defaultView(documentId, { kind: "workspace" }), defaultRenderer(documentId)];
  for (const config of valid) {
    const document = { id: documentId, source: JSON.stringify(config) };
    expect(await validatedPersonalTitle(processing, document, signal)).toBe(config.title);
  }
  const sources = [
    '{"config_version":99,"kind":"view","title":"Untrusted future title"}',
    '{"config_version":1,"kind":"view","title":"Invalid shape"}',
    '{"title":"unfinished',
    '{"config_version":1,"config_version":1,"title":"duplicate"}',
    JSON.stringify(defaultView(id("another"), { kind: "workspace" })),
    JSON.stringify({ ...valid[0], future: true }),
    "x".repeat(65537),
  ];
  for (const source of sources) {
    const document = { id: documentId, source };
    expect(await validatedPersonalTitle(processing, document, signal)).toBeNull();
    expect(document.source).toBe(source);
  }
});

it("never borrows a title across target, revision, ID or exact source", () => {
  const document = { id: id("saved"), source: "exact source" };
  const settings = { target, revision: counter("3"), documents: [document], selectedId: null };
  const labels = {
    settings,
    status: "complete" as const,
    documents: [{ ...document, title: "Named" }],
  };
  expect(personalTitle(settings, document, labels)).toBe("Named");
  expect(personalTitle({ ...settings, revision: counter("4") }, document, labels)).toBeNull();
  expect(
    personalTitle(
      { ...settings, target: { ...target, workspaceId: id("other") } },
      document,
      labels,
    ),
  ).toBeNull();
  expect(personalTitle(settings, { ...document, id: id("other") }, labels)).toBeNull();
  expect(personalTitle(settings, { ...document, source: "changed" }, labels)).toBeNull();
});
