/** Expand only local schema references for comparing compact Api_method.describe with
 * Cli_reference's original schema. This is metadata comparison, never validation. */
export function expandedSchema(root) {
  let visited = 0;
  const walk = (value, active = new Set(), depth = 0) => {
    if (++visited > 1000000 || depth > 256)
      throw new Error("Schema comparison exceeds explicit bounds");
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => walk(item, active, depth + 1));
    const { $defs: _definitions, $ref: reference, ...rest } = value;
    if (reference !== undefined) {
      if (typeof reference !== "string" || !reference.startsWith("#/") || active.has(reference))
        throw new Error("Unsupported external or recursive schema reference");
      let target = root;
      for (const encoded of reference.slice(2).split("/")) {
        const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
        if (target === null || typeof target !== "object" || !Object.hasOwn(target, key))
          throw new Error("Missing schema reference");
        target = target[key];
      }
      const next = new Set(active);
      next.add(reference);
      const resolved = walk(target, next, depth + 1);
      if (Object.keys(rest).length === 0) return resolved;
      // Preserve sibling constraints; do not overwrite conflicts or pretend equivalence.
      return { allOf: [resolved, walk(rest, active, depth + 1)] };
    }
    return Object.fromEntries(
      Object.entries(rest).map(([key, item]) => [key, walk(item, active, depth + 1)]),
    );
  };
  return walk(root);
}
