import { jsonField, type JsonValue } from "../../../../core/json";
import * as d from "../../../../core/protocol/decoders";
import type { FormDraft } from "./types";
export type Path = readonly (string | number)[];
export const pathKey = (path: Path) =>
  (path.length === 0 ? "" : "/") +
  path.map((token) => String(token).replace(/~/gu, "~0").replace(/\//gu, "~1")).join("/");
export function at(value: JsonValue, path: Path): JsonValue | undefined {
  let selected: JsonValue | undefined = value;
  for (const token of path)
    selected =
      typeof token === "number"
        ? selected?.kind === "array"
          ? selected.items[token]
          : undefined
        : selected?.kind === "object"
          ? jsonField(selected, token)
          : undefined;
  return selected;
}
export const textAt = (draft: FormDraft, path: Path): string => {
  const key = pathKey(path);
  if (Object.hasOwn(draft.text, key)) return draft.text[key] ?? "";
  const value = at(draft.candidate, path);
  return value?.kind === "string" ? value.value : value?.kind === "number" ? value.lexeme : "";
};
/** Structural path copy. Unowned fields (including __proto__) are never enumerated into JS objects. */
function replace(value: JsonValue | undefined, path: Path, next: JsonValue | undefined): JsonValue {
  const [head, ...tail] = path;
  if (head === undefined) return next ?? d.jsonNull();
  if (typeof head === "number") {
    const items = value?.kind === "array" ? [...value.items] : [];
    if (head < 0 || head >= items.length) throw new RangeError("No form array item at this path");
    if (tail.length === 0 && next === undefined) items.splice(head, 1);
    else items[head] = replace(items[head], tail, next);
    return d.jsonArray(items);
  }
  const fields = value?.kind === "object" ? value.fields : [];
  const existing = fields.find((field) => field.name === head)?.value;
  const updated = tail.length === 0 ? next : replace(existing, tail, next);
  return d.jsonObject([
    ...fields
      .filter((field) => field.name !== head)
      .map((field) => [field.name, field.value] as const),
    ...(updated === undefined ? [] : [[head, updated] as const]),
  ]);
}
export function change(draft: FormDraft, path: Path, value: JsonValue | undefined): FormDraft {
  const key = pathKey(path),
    under = (entry: string) => entry === key || entry.startsWith(key + "/");
  return {
    candidate: replace(draft.candidate, path, value),
    text: Object.fromEntries(Object.entries(draft.text).filter(([entry]) => !under(entry))),
    errors: draft.errors.filter((issue) => !under(pathKey(issue.path))),
  };
}
export function numberText(draft: FormDraft, path: Path, text: string): FormDraft {
  const key = pathKey(path),
    valid = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?(?![\s\S])/u.test(text);
  const next = valid ? change(draft, path, d.jsonNumber(text)) : draft;
  return {
    ...next,
    text: { ...next.text, [key]: text },
    errors: [
      ...next.errors.filter((issue) => pathKey(issue.path) !== key),
      ...(valid
        ? []
        : [
            {
              path: path.map(String),
              message: "Complete this JSON number; the previous candidate value is unchanged.",
            },
          ]),
    ],
  };
}
/** Reordering/removing an array moves every incomplete text/error path with its owning row. */
export function arrayEdit(
  draft: FormDraft,
  path: Path,
  order: readonly number[],
  append: readonly JsonValue[] = [],
): FormDraft {
  const old = at(draft.candidate, path),
    items = old?.kind === "array" ? old.items : [];
  const key = pathKey(path) + "/";
  const remap = (entry: string): string | null => {
    if (!entry.startsWith(key)) return entry;
    const suffix = entry.slice(key.length),
      match = /^(0|[1-9][0-9]*)(\/.*)?$/u.exec(suffix);
    if (match === null) return entry;
    const next = order.indexOf(Number(match[1]));
    return next < 0 ? null : key + String(next) + (match[2] ?? "");
  };
  const updated = change(
    draft,
    path,
    d.jsonArray([...order.flatMap((i) => (items[i] === undefined ? [] : [items[i]])), ...append]),
  );
  return {
    ...updated,
    text: Object.fromEntries(
      Object.entries(draft.text).flatMap(([entry, text]) => {
        const moved = remap(entry);
        return moved === null ? [] : [[moved, text]];
      }),
    ),
    errors: draft.errors.flatMap((issue) => {
      const moved = remap(pathKey(issue.path));
      return moved === null
        ? []
        : [
            {
              ...issue,
              path: moved
                .slice(1)
                .split("/")
                .map((s) => s.replace(/~1/gu, "/").replace(/~0/gu, "~")),
            },
          ];
    }),
  };
}
/** Change a known union without discarding future, unknown keys. */
export function variant(
  draft: FormDraft,
  path: Path,
  owned: readonly string[],
  fields: readonly (readonly [string, JsonValue])[],
): FormDraft {
  const old = at(draft.candidate, path);
  return change(
    draft,
    path,
    d.jsonObject([
      ...(old?.kind === "object"
        ? old.fields
            .filter((field) => !owned.includes(field.name))
            .map((field) => [field.name, field.value] as const)
        : []),
      ...fields,
    ]),
  );
}
