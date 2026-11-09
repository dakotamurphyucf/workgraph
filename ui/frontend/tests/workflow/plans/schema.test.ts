import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import native from "./native-fields.fixture.json";
import { json } from "../../work/actions-fixtures";
import { jsonField } from "../../../src/core/json";
import * as d from "../../../src/core/protocol/decoders";
import { SchemaForm } from "../../../src/features/workflow/plans/SchemaForm";
import {
  defaultValue,
  expandSchema,
  matchesShape,
  schemaChoices,
  schemaField,
} from "../../../src/features/workflow/plans/schema";

describe("native structured schema presentation", () => {
  it("preserves free and bounded multiline Unicode text including trailing LF", () => {
    for (const schema of [
      json({ type: "string" }),
      json({ type: "string", "x-maxUtf8Bytes": 65536 }),
    ]) {
      const value = d.jsonString("First 💖\nSecond\n");
      const form = renderToStaticMarkup(
        createElement(SchemaForm, {
          schema,
          value,
          name: "Content",
          onChange: () => {
            throw new Error("Rendering cannot rewrite text");
          },
        }),
      );
      expect(form).toContain("<textarea");
      expect(form).toContain('rows="4"');
      expect(form).toContain("First 💖\nSecond\n</textarea>");
      expect(value).toEqual(d.jsonString("First 💖\nSecond\n"));
    }
  });
  it("keeps native bounded identifiers compact without inferring domains from field names", () => {
    const schema = native["request.ask"].fields.find((field) => field.name === "actor_id")!.schema;
    const form = renderToStaticMarkup(
      createElement(SchemaForm, {
        schema: json(schema),
        value: d.jsonString("actual-actor"),
        name: "Unrelated label",
        onChange: () => undefined,
      }),
    );
    expect(form).toContain("<textarea");
    expect(form).toContain('rows="1"');
    expect(form).toContain("actual-actor</textarea>");
  });
  it("uses the actual native decimal pattern for a compact revision without changing exact text", () => {
    const schema = native["template.instantiate"].fields.find(
      (field) => field.name === "template_revision",
    )!.schema;
    for (const [source, rows] of [
      ["1", 1],
      ["1\n", 4],
    ] as const) {
      const value = d.jsonString(source);
      const form = renderToStaticMarkup(
        createElement(SchemaForm, {
          schema: json(schema),
          value,
          name: "Unrelated label",
          onChange: () => {
            throw new Error("Rendering cannot edit a value");
          },
        }),
      );
      expect(form).toContain(`rows="${rows}"`);
      expect(form).toContain(`${source}</textarea>`);
      expect(value).toEqual(d.jsonString(source));
    }
  });
  it("retains CR and CRLF in exact source rather than exposing a normalizing textarea", () => {
    for (const text of ["First\rSecond", "First\r\nSecond\r\n"]) {
      const value = d.jsonString(text);
      const form = renderToStaticMarkup(
        createElement(SchemaForm, {
          schema: json({ type: "string" }),
          value,
          name: "Content",
          onChange: () => {
            throw new Error("No normalization");
          },
        }),
      );
      expect(form).toContain("carriage returns");
      expect(form).toContain("Exact plan source");
      expect(form).not.toContain("<textarea");
      expect(value).toEqual(d.jsonString(text));
    }
  });
  it("merges actual request.ask allOf properties/required across attribution and method groups", () => {
    const schema = json(native["request.ask"].validation_schema),
      properties = schemaField(schema, "properties"),
      required = schemaField(schema, "required");
    expect(properties?.kind).toBe("object");
    expect(jsonField(properties!, "workspace_id")).toBeDefined();
    expect(jsonField(properties!, "body")).toBeDefined();
    expect(
      required?.kind === "array"
        ? required.items.map((item) => (item.kind === "string" ? item.value : ""))
        : [],
    ).toEqual(expect.arrayContaining(["workspace_id", "actor_id", "body"]));
  });
  it("renders actual named/role reviewers, null actor eligibility and template gates without choosing another variant", () => {
    const spec = native["template.register"].fields.find((field) => field.name === "spec")!;
    const expanded = expandSchema(json(spec.schema));
    if (expanded === null) throw new Error("Native template schema unexpectedly unsupported");
    const props = schemaField(expanded, "properties"),
      nodes = props === undefined ? undefined : jsonField(props, "nodes"),
      item = nodes === undefined ? undefined : schemaField(nodes, "items");
    if (item === undefined) throw new Error("Missing native node schema");
    const form = renderToStaticMarkup(
      createElement(SchemaForm, {
        schema: item,
        name: "Node",
        value: json({
          alias: "work",
          title: "Work",
          description: "",
          parent: null,
          depends_on: [],
          capabilities: ["review"],
          allowed_actor_ids: null,
          reviewers: [{ kind: "role", name: "reviewers", member_ids: ["reviewer"] }],
          separate_actor: true,
        }),
        onChange: () => undefined,
      }),
    );
    const nodeFields = schemaField(item, "properties"),
      reviewers = nodeFields === undefined ? undefined : jsonField(nodeFields, "reviewers"),
      reviewer = reviewers === undefined ? undefined : schemaField(reviewers, "items");
    if (reviewer === undefined) throw new Error("Missing native reviewer schema");
    const reviewerForm = renderToStaticMarkup(
      createElement(SchemaForm, {
        schema: reviewer,
        name: "Reviewer",
        value: json({ kind: "role", name: "reviewers", member_ids: ["reviewer"] }),
        onChange: () => undefined,
      }),
    );
    expect(reviewerForm).toContain("Member ids");
    expect(form).toContain("Separate actor");
    expect(form).toContain("explicit null");
  });
  it("recognizes enum singleton discriminants and resolves local definitions", () => {
    const schema = json({
        $defs: {
          actor: {
            type: "object",
            properties: { kind: { enum: ["actor"], type: "string" }, actor_id: { type: "string" } },
            required: ["kind", "actor_id"],
          },
          role: {
            type: "object",
            properties: {
              kind: { enum: ["role"], type: "string" },
              name: { type: "string" },
              member_ids: { type: "array", items: { type: "string" } },
            },
            required: ["kind", "name", "member_ids"],
          },
        },
        oneOf: [{ $ref: "#/$defs/actor" }, { $ref: "#/$defs/role" }],
      }),
      expanded = expandSchema(schema);
    if (expanded === null) throw new Error("Local refs unexpectedly unsupported");
    const branches = schemaChoices(expanded),
      value = json({ kind: "role", name: "reviewers", member_ids: ["reviewer"] });
    expect(branches.map((branch) => matchesShape(branch, value))).toEqual([false, true]);
    const form = renderToStaticMarkup(
      createElement(SchemaForm, { schema, value, name: "Reviewer", onChange: () => undefined }),
    );
    expect(form).toContain("Member ids");
    expect(form).not.toContain('value="actor" selected');
  });
  it("offers explicit required-field repair without mutating incomplete source or unknown values", () => {
    const schema = json({
        type: "object",
        properties: {
          title: { type: "string" },
          optional: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["title"],
      }),
      value = json({ unknown: "preserved", optional: null });
    const form = renderToStaticMarkup(
      createElement(SchemaForm, {
        schema,
        value,
        name: "Work",
        onChange: () => {
          throw new Error("Rendering must never change source");
        },
      }),
    );
    expect(form).toContain("Add required Title");
    expect(form).toContain("preserved");
    expect(form).toContain("explicit null");
    expect(jsonField(value, "title")).toBeUndefined();
  });
  it("gives unsupported/cyclic references a passive exact-source fallback", () => {
    for (const schema of [
      json({ $ref: "https://example.invalid/schema" }),
      json({ $defs: { loop: { $ref: "#/$defs/loop" } }, $ref: "#/$defs/loop" }),
    ]) {
      const form = renderToStaticMarkup(
        createElement(SchemaForm, {
          schema,
          value: d.jsonObject([["retained", d.jsonString("literal")]]),
          name: "Gate",
          onChange: () => {
            throw new Error("No silent reset");
          },
        }),
      );
      expect(form).toContain("Exact values are retained");
    }
  });
  it("shows invalid stored enum values without visually selecting the first valid option", () => {
    const form = renderToStaticMarkup(
      createElement(SchemaForm, {
        schema: json({ type: "string", enum: ["open", "closed"] }),
        value: d.jsonString("legacy-unknown"),
        name: "State",
        onChange: () => {
          throw new Error("No reset on read");
        },
      }),
    );
    expect(form).toContain("Invalid stored value");
    expect(form).toContain('value="-1" disabled="" selected=""');
    expect(form).not.toContain('value="0" selected');
  });
  it("creates typed defaults only after explicit user choice", () => {
    const schema = json({
      type: "object",
      properties: { kind: { const: "actor", type: "string" }, actor_id: { type: "string" } },
      required: ["kind", "actor_id"],
    });
    expect(defaultValue(schema)).toEqual(json({ kind: "actor", actor_id: "" }));
  });
});
