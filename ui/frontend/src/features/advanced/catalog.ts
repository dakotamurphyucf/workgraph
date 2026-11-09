import * as c from "../../core/protocol/codec";
import type { Codec } from "../../core/protocol/codec";
import type { Catalog, MethodContract } from "./types";
const choice = <T extends string>(values: readonly T[]): Codec<T> => ({
  decode(value, path = []) {
    const found = c.text.decode(value, path);
    if (!found.ok) return found;
    return values.includes(found.value as T)
      ? { ok: true, value: found.value as T }
      : c.mismatch(path, values.join(" | "));
  },
});
const method = {
  name: c.text,
  mode: choice(["read", "write", "mutation"] as const),
  tier: choice(["core", "advanced"] as const),
  summary: c.text,
};
const strings = c.array(c.text, 1024);
const entry = (kind: "helper" | "workflow") =>
  c.record({
    name: c.text,
    kind: c.literal(kind),
    summary: c.text,
    use_when: c.text,
    capability: c.text,
    effect: c.nullable(c.text),
    next: c.text,
    reference: c.text,
    tier: c.nullable(c.text),
    related: strings,
    search_terms: strings,
    steps: strings,
  });
export const catalogCodec: Codec<Catalog> = c.refine(
  c.record({
    methods: c.array(c.record(method), 2048),
    helpers: c.array(entry("helper"), 512),
    workflows: c.array(entry("workflow"), 512),
    capabilities: c.array(
      c.record({ id: c.text, title: c.text, summary: c.text, groups: strings, reference: c.text }),
      128,
    ),
  }),
  (value) =>
    new Set([...value.methods, ...value.helpers, ...value.workflows].map((e) => e.name)).size ===
    value.methods.length + value.helpers.length + value.workflows.length,
  "unique catalogue entries",
);
const contract = c.record({
  method: c.record({ ...method, params: c.raw, result: c.raw }),
  help: c.text,
  fields: c.record({
    method: c.text,
    summary: c.text,
    schema_dialect: c.text,
    guidance: c.text,
    fields: c.array(
      c.record({
        name: c.text,
        requirement: choice(["required", "optional", "conditional"] as const),
        summary: c.text,
        descriptions: strings,
        schema: c.raw,
        json_argument: strings,
      }),
      512,
    ),
    validation_schema: c.raw,
  }),
});
export function methodCodec(name: string): Codec<MethodContract> {
  return c.refine(
    contract,
    (value) =>
      value.method.name === name &&
      value.fields.method === name &&
      new Set(value.fields.fields.map((f) => f.name)).size === value.fields.fields.length,
    "matching method and unique fields",
  );
}
