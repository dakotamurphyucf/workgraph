import { strict as assert } from "node:assert";
import { test } from "node:test";
import { expandedSchema } from "./schema.mjs";
test("compact local definitions compare with actual inline descriptors", () => {
  assert.deepEqual(
    expandedSchema({
      $defs: { id: { type: "string", minLength: 1 } },
      properties: { id: { $ref: "#/$defs/id" } },
    }),
    { properties: { id: { type: "string", minLength: 1 } } },
  );
});
test("missing, external and cyclic refs cannot silently compare as equal", () => {
  for (const source of [
    { $ref: "https://example.invalid/schema" },
    { $ref: "#/$defs/absent" },
    { $defs: { a: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" },
  ])
    assert.throws(() => expandedSchema(source));
});
test("ref siblings preserve constraints and unequal inline values stay unequal", () => {
  const actual = expandedSchema({
    $defs: { id: { type: "string" } },
    $ref: "#/$defs/id",
    minLength: 4,
  });
  assert.deepEqual(actual, { allOf: [{ type: "string" }, { minLength: 4 }] });
  assert.notDeepEqual(actual, expandedSchema({ type: "string" }));
});
