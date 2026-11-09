/** Private bounded data transport for the six compiled processing jobs; never an RPC/plugin API. */
import { capturedJsonWeight, certifyJson, isCapturedJson } from "../../json/capture";
import type { JsonValue } from "../../json";

export const WIRE_LIMITS = Object.freeze({
  packetBytes: 32 * 1024,
  packetRecords: 1024,
  graphNodes: 2_000_000,
  graphRecords: 8_000_000,
  graphBytes: 256 * 1024 * 1024,
  stringUnits: 64 * 1024 * 1024,
  bufferBytes: 32 * 1024 * 1024,
  properties: 32,
  depth: 512,
});
export type GraphPart =
  | { readonly kind: "records"; readonly bytes: ArrayBuffer }
  | { readonly kind: "buffer"; readonly index: number; readonly bytes: ArrayBuffer }
  | { readonly kind: "end"; readonly root: number };
type Frame =
  | readonly ["null" | "undefined", number]
  | readonly ["boolean", number, boolean]
  | readonly ["number", number, number]
  | readonly ["string", number, number]
  | readonly ["text", number, string]
  | readonly ["string-end", number]
  | readonly ["array", number]
  | readonly ["push", number, readonly number[]]
  | readonly ["array-end", number]
  | readonly ["object", number, readonly (readonly [string, number])[]]
  | readonly ["bytes", number, number];
type Emit =
  | { readonly kind: "frame"; readonly frame: Frame }
  | { readonly kind: "buffer"; readonly index: number; readonly bytes: ArrayBuffer };
export class WireError extends Error {}
const invalid = (): never => {
  throw new WireError("Invalid or over-budget processing worker data.");
};
const scalar = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
};
const integer = (value: unknown, maximum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const encoder = new TextEncoder();

/** Iteration itself is bounded per yielded packet; no whole-tree structured clone or synchronous prewalk. */
export function* writeGraph(value: unknown): Generator<GraphPart> {
  const seen = new WeakMap<object, number>();
  const ancestors = new WeakSet<object>();
  const shortStrings = new Map<string, number>();
  let nextId = 0;
  let bufferIndex = 0;
  let strings = 0;
  let buffers = 0;
  let records = 0;
  let wireBytes = 0;
  function* visit(value: unknown, depth: number): Generator<Emit, number> {
    if (depth > WIRE_LIMITS.depth) return invalid();
    if (typeof value === "object" && value !== null) {
      if (ancestors.has(value)) return invalid();
      const prior = seen.get(value);
      if (prior !== undefined) return prior;
    } else if (typeof value === "string" && value.length <= 64) {
      const prior = shortStrings.get(value);
      if (prior !== undefined) return prior;
    }
    const id = ++nextId;
    if (id > WIRE_LIMITS.graphNodes) return invalid();
    const frame = function* (frame: Frame): Generator<Emit> {
      yield { kind: "frame", frame };
    };
    if (value === null) yield* frame(["null", id]);
    else if (value === undefined) yield* frame(["undefined", id]);
    else if (typeof value === "boolean") yield* frame(["boolean", id, value]);
    else if (typeof value === "number") {
      if (!Number.isFinite(value)) return invalid();
      yield* frame(["number", id, value]);
    } else if (typeof value === "string") {
      strings += value.length;
      if (strings > WIRE_LIMITS.stringUnits) return invalid();
      yield* frame(["string", id, value.length]);
      let start = 0;
      while (start < value.length) {
        let end = Math.min(start + 1024, value.length);
        const last = value.charCodeAt(end - 1);
        if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
        const part = value.slice(start, end);
        yield* frame(["text", id, part]);
        start = end;
      }
      yield* frame(["string-end", id]);
      if (value.length <= 64 && shortStrings.size < 1024) shortStrings.set(value, id);
    } else if (value instanceof Uint8Array) {
      buffers += value.byteLength;
      if (buffers > WIRE_LIMITS.bufferBytes) return invalid();
      // A caller's source is never detached. Only this owned copy is transferred.
      const bytes = new Uint8Array(value).buffer;
      const index = bufferIndex++;
      yield { kind: "buffer", index, bytes };
      yield* frame(["bytes", id, index]);
      seen.set(value, id);
    } else if (typeof value === "object") {
      if (value === null) return invalid();
      const prototype: unknown = Object.getPrototypeOf(value);
      if (Array.isArray(value)) {
        if (prototype !== Array.prototype || value.length > WIRE_LIMITS.graphNodes)
          return invalid();
        ancestors.add(value);
        seen.set(value, id);
        yield* frame(["array", id]);
        let refs: number[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const property = Object.getOwnPropertyDescriptor(value, String(index));
          if (property === undefined || !("value" in property)) return invalid();
          refs.push(yield* visit(property.value as unknown, depth + 1));
          if (refs.length === 128) {
            yield* frame(["push", id, refs]);
            refs = [];
          }
        }
        if (refs.length) yield* frame(["push", id, refs]);
        yield* frame(["array-end", id]);
        ancestors.delete(value);
      } else {
        if (prototype !== Object.prototype && prototype !== null) return invalid();
        const keys = Reflect.ownKeys(value);
        if (keys.length > WIRE_LIMITS.properties) return invalid();
        ancestors.add(value);
        seen.set(value, id);
        const fields: [string, number][] = [];
        for (const key of keys) {
          if (typeof key !== "string" || key.length > 128 || !scalar(key)) return invalid();
          const property = Object.getOwnPropertyDescriptor(value, key);
          if (property === undefined || !("value" in property)) return invalid();
          fields.push([key, yield* visit(property.value as unknown, depth + 1)]);
        }
        yield* frame(["object", id, fields]);
        ancestors.delete(value);
      }
    } else return invalid();
    return id;
  }
  const frames = visit(value, 0);
  let pieces: Uint8Array[] = [];
  let length = 2;
  let root: number | undefined;
  const flush = (): GraphPart => {
    const bytes = new Uint8Array(length);
    bytes[0] = 91;
    let offset = 1;
    for (const [index, piece] of pieces.entries()) {
      if (index > 0) bytes[offset++] = 44;
      bytes.set(piece, offset);
      offset += piece.byteLength;
    }
    bytes[offset] = 93;
    pieces = [];
    length = 2;
    return { kind: "records", bytes: bytes.buffer };
  };
  for (;;) {
    const next = frames.next();
    if (next.done) {
      root = next.value;
      break;
    }
    if (next.value.kind === "buffer") {
      if (pieces.length) yield flush();
      yield next.value;
      continue;
    }
    if (++records > WIRE_LIMITS.graphRecords) return invalid();
    // Closed framing metadata only. Arbitrary JSON numeric values stay lexeme strings inside AST nodes.
    const bytes = encoder.encode(JSON.stringify(next.value.frame));
    if (bytes.byteLength + 2 > WIRE_LIMITS.packetBytes) return invalid();
    if (
      pieces.length &&
      (pieces.length === WIRE_LIMITS.packetRecords ||
        length + bytes.byteLength + 1 > WIRE_LIMITS.packetBytes)
    )
      yield flush();
    pieces.push(bytes);
    length += bytes.byteLength + (pieces.length > 1 ? 1 : 0);
    wireBytes += bytes.byteLength + 1;
    if (wireBytes > WIRE_LIMITS.graphBytes) return invalid();
  }
  if (pieces.length) yield flush();
  if (root === undefined) return invalid();
  yield { kind: "end", root };
}
interface TextParts {
  readonly length: number;
  readonly pieces: string[];
  used: number;
}
interface ArrayParts {
  readonly value: unknown[];
  allJson: boolean;
  allFields: boolean;
  weight: number;
}
export interface GraphReader {
  readonly accept: (part: GraphPart) => void;
  readonly finish: () => unknown;
  readonly clear: () => void;
}

export function createGraphReader(): GraphReader {
  const nodes = new Map<number, unknown>();
  const strings = new Map<number, TextParts>();
  const arrays = new Map<number, ArrayParts>();
  const buffers = new Map<number, Uint8Array>();
  const identities = new Set<number>();
  const bufferIdentities = new Set<number>();
  const jsonArrays = new WeakMap<object, number>();
  const fieldArrays = new WeakMap<object, number>();
  const jsonFields = new WeakMap<object, number>();
  let stringUnits = 0,
    bufferBytes = 0,
    wireBytes = 0,
    recordCount = 0;
  let root: number | undefined;
  const id = (value: unknown): number =>
    integer(value, WIRE_LIMITS.graphNodes) && value > 0 ? value : invalid();
  const allocate = (value: unknown): number => {
    const key = id(value);
    if (identities.has(key) || identities.size >= WIRE_LIMITS.graphNodes) return invalid();
    identities.add(key);
    return key;
  };
  const node = (value: unknown): unknown => {
    const key = id(value);
    if (!nodes.has(key)) return invalid();
    return nodes.get(key);
  };
  function certify(value: Record<string, unknown>, fields: readonly (readonly [string, number])[]) {
    const names = fields.map(([name]) => name);
    const exact = (...keys: string[]) =>
      names.length === keys.length && keys.every((key) => names.includes(key));
    if (
      exact("name", "value") &&
      typeof value.name === "string" &&
      typeof value.value === "object" &&
      value.value !== null &&
      isCapturedJson(value.value)
    )
      jsonFields.set(
        value,
        Math.min(16 * 1024 * 1024, 4 + value.name.length * 6 + capturedJsonWeight(value.value)),
      );
    if (
      (exact("kind") && value.kind === "null") ||
      (exact("kind", "value") &&
        ((value.kind === "boolean" && typeof value.value === "boolean") ||
          (value.kind === "string" && typeof value.value === "string"))) ||
      (exact("kind", "lexeme") && value.kind === "number" && typeof value.lexeme === "string") ||
      (exact("kind", "items") &&
        value.kind === "array" &&
        typeof value.items === "object" &&
        value.items !== null &&
        jsonArrays.has(value.items)) ||
      (exact("kind", "fields") &&
        value.kind === "object" &&
        typeof value.fields === "object" &&
        value.fields !== null &&
        fieldArrays.has(value.fields))
    )
      certifyJson(
        value as unknown as JsonValue,
        value.kind === "array"
          ? jsonArrays.get(value.items as object)
          : value.kind === "object"
            ? fieldArrays.get(value.fields as object)
            : value.kind === "string"
              ? Math.min(16 * 1024 * 1024, 2 + (value.value as string).length * 6)
              : value.kind === "number"
                ? (value.lexeme as string).length
                : value.kind === "null"
                  ? 4
                  : 5,
      );
  }
  function record(input: unknown) {
    if (
      !Array.isArray(input) ||
      input.length < 2 ||
      input.length > 3 ||
      typeof input[0] !== "string"
    )
      return invalid();
    const tag: string = input[0];
    const exact = (length: number) => {
      if (input.length !== length) return invalid();
    };
    const key = id(input[1]);
    switch (tag) {
      case "null":
      case "undefined":
        exact(2);
        allocate(key);
        nodes.set(key, tag === "null" ? null : undefined);
        return;
      case "boolean":
        exact(3);
        if (typeof input[2] !== "boolean") return invalid();
        allocate(key);
        nodes.set(key, input[2]);
        return;
      case "number":
        exact(3);
        if (typeof input[2] !== "number" || !Number.isFinite(input[2])) return invalid();
        allocate(key);
        nodes.set(key, input[2]);
        return;
      case "string": {
        exact(3);
        if (!integer(input[2], WIRE_LIMITS.stringUnits)) return invalid();
        stringUnits += input[2];
        if (stringUnits > WIRE_LIMITS.stringUnits) return invalid();
        allocate(key);
        strings.set(key, { length: input[2], used: 0, pieces: [] });
        return;
      }
      case "text": {
        exact(3);
        const text: unknown = input[2],
          target = strings.get(key);
        if (
          target === undefined ||
          typeof text !== "string" ||
          text.length === 0 ||
          text.length > 1024
        )
          return invalid();
        target.used += text.length;
        if (target.used > target.length) return invalid();
        target.pieces.push(text);
        return;
      }
      case "string-end": {
        exact(2);
        const text = strings.get(key);
        if (text === undefined || text.used !== text.length) return invalid();
        strings.delete(key);
        nodes.set(key, text.pieces.join(""));
        return;
      }
      case "array":
        exact(2);
        allocate(key);
        arrays.set(key, { value: [], allJson: true, allFields: true, weight: 2 });
        return;
      case "push": {
        exact(3);
        const target = arrays.get(key),
          refs: unknown = input[2];
        if (
          target === undefined ||
          !Array.isArray(refs) ||
          refs.length === 0 ||
          refs.length > 128 ||
          target.value.length + refs.length > WIRE_LIMITS.graphNodes
        )
          return invalid();
        for (const ref of refs) {
          const value = node(ref);
          target.value.push(value);
          if (isCapturedJson(value))
            target.weight = Math.min(
              16 * 1024 * 1024,
              target.weight + 1 + capturedJsonWeight(value),
            );
          else if (typeof value === "object" && value !== null && jsonFields.has(value))
            target.weight = Math.min(16 * 1024 * 1024, target.weight + 1 + jsonFields.get(value)!);
          target.allJson &&= typeof value === "object" && value !== null && isCapturedJson(value);
          target.allFields &&= typeof value === "object" && value !== null && jsonFields.has(value);
        }
        return;
      }
      case "array-end": {
        exact(2);
        const array = arrays.get(key);
        if (array === undefined) return invalid();
        arrays.delete(key);
        Object.freeze(array.value);
        if (array.allJson) jsonArrays.set(array.value, array.weight);
        if (array.allFields) fieldArrays.set(array.value, array.weight);
        nodes.set(key, array.value);
        return;
      }
      case "object": {
        exact(3);
        const fields: unknown = input[2];
        if (!Array.isArray(fields) || fields.length > WIRE_LIMITS.properties) return invalid();
        allocate(key);
        const value = Object.create(null) as Record<string, unknown>;
        const checked: [string, number][] = [];
        for (const field of fields) {
          if (
            !Array.isArray(field) ||
            field.length !== 2 ||
            typeof field[0] !== "string" ||
            field[0].length > 128 ||
            !scalar(field[0]) ||
            Object.hasOwn(value, field[0])
          )
            return invalid();
          const ref = id(field[1]);
          Object.defineProperty(value, field[0], { value: node(ref), enumerable: true });
          checked.push([field[0], ref]);
        }
        Object.freeze(value);
        certify(value, checked);
        nodes.set(key, value);
        return;
      }
      case "bytes": {
        exact(3);
        if (!integer(input[2], WIRE_LIMITS.graphNodes) || !buffers.has(input[2])) return invalid();
        allocate(key);
        nodes.set(key, buffers.get(input[2]));
        buffers.delete(input[2]);
        return;
      }
      default:
        return invalid();
    }
  }
  const clear = () => {
    nodes.clear();
    strings.clear();
    arrays.clear();
    buffers.clear();
    identities.clear();
    bufferIdentities.clear();
  };
  return {
    accept(part) {
      if (root !== undefined) return invalid();
      if (part.kind === "buffer") {
        if (
          !integer(part.index, WIRE_LIMITS.graphNodes) ||
          bufferIdentities.has(part.index) ||
          !(part.bytes instanceof ArrayBuffer)
        )
          return invalid();
        bufferBytes += part.bytes.byteLength;
        if (bufferBytes > WIRE_LIMITS.bufferBytes) return invalid();
        bufferIdentities.add(part.index);
        buffers.set(part.index, new Uint8Array(part.bytes));
      } else if (part.kind === "records") {
        if (
          !(part.bytes instanceof ArrayBuffer) ||
          part.bytes.byteLength === 0 ||
          part.bytes.byteLength > WIRE_LIMITS.packetBytes
        )
          return invalid();
        wireBytes += part.bytes.byteLength;
        if (wireBytes > WIRE_LIMITS.graphBytes) return invalid();
        const source = new TextDecoder("utf-8", { fatal: true }).decode(part.bytes);
        // Closed framing, bounded numeric IDs/counts only; JSON value numbers remain exact lexeme strings.
        const records: unknown = JSON.parse(source);
        if (
          !Array.isArray(records) ||
          records.length === 0 ||
          records.length > WIRE_LIMITS.packetRecords
        )
          return invalid();
        recordCount += records.length;
        if (recordCount > WIRE_LIMITS.graphRecords) return invalid();
        for (const frame of records) record(frame);
      } else {
        if (strings.size || arrays.size || buffers.size || !nodes.has(id(part.root)))
          return invalid();
        root = part.root;
      }
    },
    finish() {
      if (root === undefined) return invalid();
      const result = node(root);
      clear();
      return result;
    },
    clear,
  };
}
