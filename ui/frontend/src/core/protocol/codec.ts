import { jsonField, type JsonValue } from "../json";

export interface DecodeIssue {
  readonly path: readonly string[];
  readonly expected: string;
}
export type DecodeResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issue: DecodeIssue };
export interface Codec<T> {
  /** Only this exact descriptor opts into full worker operation validation. */
  readonly worker?: { readonly kind: "operation"; readonly validated: Codec<T> };
  readonly decode: (value: JsonValue | undefined, path?: readonly string[]) => DecodeResult<T>;
}

export function mismatch<T>(path: readonly string[], expected: string): DecodeResult<T> {
  return { ok: false, issue: { path, expected } };
}
export const text: Codec<string> = {
  decode: (value, path = []) =>
    value?.kind === "string" ? { ok: true, value: value.value } : mismatch(path, "string"),
};
export const boolean: Codec<boolean> = {
  decode: (value, path = []) =>
    value?.kind === "boolean" ? { ok: true, value: value.value } : mismatch(path, "boolean"),
};
export const raw: Codec<JsonValue> = {
  decode: (value, path = []) =>
    value === undefined ? mismatch(path, "JSON value") : { ok: true, value },
};
export const object: Codec<Extract<JsonValue, { kind: "object" }>> = {
  decode: (value, path = []) =>
    value?.kind === "object" ? { ok: true, value } : mismatch(path, "JSON object"),
};
export function optional<T>(codec: Codec<T>): Codec<T | undefined> {
  return {
    decode: (value, path = []) =>
      value === undefined ? { ok: true, value: undefined } : codec.decode(value, path),
  };
}
export function nullable<T>(codec: Codec<T>): Codec<T | null> {
  return {
    decode: (value, path = []) =>
      value?.kind === "null" ? { ok: true, value: null } : codec.decode(value, path),
  };
}
export function literal<const T extends string | boolean>(expected: T): Codec<T> {
  return {
    decode: (value, path = []) =>
      (value?.kind === "string" || value?.kind === "boolean") && value.value === expected
        ? { ok: true, value: expected }
        : mismatch(path, `literal ${String(expected)}`),
  };
}
export function refine<T>(
  codec: Codec<T>,
  check: (value: T) => boolean,
  expected: string,
): Codec<T> {
  return {
    decode: (value, path = []) => {
      const result = codec.decode(value, path);
      if (!result.ok) return result;
      return check(result.value) ? result : mismatch(path, expected);
    },
  };
}
export function array<T>(codec: Codec<T>, maximum: number): Codec<readonly T[]> {
  return {
    decode: (value, path = []) => {
      if (value?.kind !== "array" || value.items.length > maximum)
        return mismatch(path, `array of at most ${maximum} items`);
      const items: T[] = [];
      for (const [index, item] of value.items.entries()) {
        const result = codec.decode(item, [...path, String(index)]);
        if (!result.ok) return result;
        items.push(result.value);
      }
      return { ok: true, value: Object.freeze(items) };
    },
  };
}

type Shape = Readonly<Record<string, Codec<unknown>>>;
type Decoded<C extends Shape> = {
  readonly [K in keyof C]: C[K] extends Codec<infer T> ? T : never;
};

/** Closed companion DTOs only. Arbitrary daemon JSON uses raw/object instead. */
export function record<C extends Shape>(shape: C): Codec<Decoded<C>> {
  const entries = Object.entries(shape);
  const names = new Set(entries.map(([name]) => name));
  return {
    decode: (value, path = []) => {
      if (value?.kind !== "object") return mismatch(path, "object");
      for (const field of value.fields) {
        if (!names.has(field.name)) return mismatch([...path, field.name], "no unknown DTO field");
      }
      const fields: [string, unknown][] = [];
      for (const [name, codec] of entries) {
        const result = codec.decode(jsonField(value, name), [...path, name]);
        if (!result.ok) return result;
        fields.push([name, result.value]);
      }
      // Each entry passed its corresponding codec. TS cannot retain that key/value
      // correlation through Object.entries; this is the single construction cast.
      return { ok: true, value: Object.freeze(Object.fromEntries(fields)) as Decoded<C> };
    },
  };
}

/** Only explicit recognized discriminator values select a variant. */
export function tagged<T>(tag: string, choices: Readonly<Record<string, Codec<T>>>): Codec<T> {
  return {
    decode: (value, path = []) => {
      if (value?.kind !== "object") return mismatch(path, "tagged object");
      const found = text.decode(jsonField(value, tag), [...path, tag]);
      if (!found.ok) return found;
      const codec = Object.hasOwn(choices, found.value) ? choices[found.value] : undefined;
      return codec === undefined
        ? mismatch([...path, tag], "recognized discriminator")
        : codec.decode(value, path);
    },
  };
}
