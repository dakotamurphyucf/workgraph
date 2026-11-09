import { DEFAULT_JSON_LIMITS } from "../json";
import { certifyJson, isCapturedJson } from "../json/capture";
import { canonicalJson, jsonField, type JsonValue } from "../json";
import * as c from "./codec";
import type {
  ConnectionProfile,
  DraftContext,
  Preparation,
  Decimal,
  Digest,
  Identifier,
  Operation,
  OperationState,
  PreparationSnapshot,
  Problem,
  PublicResponse,
  ReadResponse,
} from "./types";

function branded<T extends string>(
  check: (value: string) => boolean,
  expected: string,
): c.Codec<T> {
  const codec = c.refine(c.text, check, expected);
  return {
    decode: (value, path = []) => {
      const result = codec.decode(value, path);
      // The only brand construction follows the corresponding runtime predicate.
      return result.ok ? { ok: true, value: result.value as T } : result;
    },
  };
}
const canonicalDecimal = /^(?:0|[1-9][0-9]*)(?![\s\S])/u;
const maximumCounter = "4611686018427387903";
export const decimal = branded<Decimal>(
  (value) =>
    canonicalDecimal.test(value) &&
    (value.length < maximumCounter.length ||
      (value.length === maximumCounter.length && value <= maximumCounter)),
  "canonical decimal string in the daemon counter range",
);
export const positiveDecimal = c.refine(
  decimal,
  (value) => value !== "0",
  "positive decimal string",
);
export const identifier = branded<Identifier>(
  (value) => /^[A-Za-z0-9_-]{1,96}(?![\s\S])/u.test(value),
  "ASCII identifier",
);
export const digest = branded<Digest>(
  (value) => /^[a-f0-9]{64}(?![\s\S])/u.test(value),
  "lowercase SHA-256 digest",
);
const absolutePath = c.refine(
  c.text,
  (value) => value.startsWith("/") && !value.includes("\0"),
  "absolute Unix path without NUL",
);
export const problem: c.Codec<Problem> = c.record({
  kind: c.text,
  message: c.text,
  details: c.optional(c.raw),
});
export const connectionProfile: c.Codec<ConnectionProfile> = c.record({
  id: identifier,
  generation: positiveDecimal,
  label: c.text,
  socket: absolutePath,
});
export const publicResponse: c.Codec<PublicResponse> = c.record({ data: c.raw, meta: c.object });
export const draftContext: c.Codec<DraftContext> = c.record({
  workspace_id: c.nullable(identifier),
  project_id: c.nullable(identifier),
  writer: c.record({ actor_id: identifier, run_id: c.nullable(identifier) }),
});
export const preparation: c.Codec<Preparation> = c.record({
  intention_id: identifier,
  context: draftContext,
  connection_id: identifier,
  generation: positiveDecimal,
  method: c.text,
  params: c.object,
});
export const preparationSnapshot: c.Codec<PreparationSnapshot> = c.record({
  intention_id: identifier,
  context: draftContext,
  connection: connectionProfile,
  method: c.text,
  params: c.object,
});
export const operationState: c.Codec<OperationState> = c.tagged<OperationState>("kind", {
  prepared_unsent: c.record({ kind: c.literal("prepared_unsent") }),
  sending: c.record({ kind: c.literal("sending") }),
  committed: c.record({ kind: c.literal("committed"), response: publicResponse }),
  observed: c.record({ kind: c.literal("observed"), response: publicResponse }),
  rejected: c.record({ kind: c.literal("rejected"), problem }),
  outcome_unknown: c.record({ kind: c.literal("outcome_unknown"), problem }),
});
const operationShape: c.Codec<Operation> = c.record({
  format: c.literal("workgraph-ui-operation-1"),
  operation_id: identifier,
  preparation: preparationSnapshot,
  preparation_input_hash: digest,
  connection: connectionProfile,
  request: c.object,
  journal_path: c.nullable(absolutePath),
  revision: positiveDecimal,
  state: operationState,
  diagnostic: c.nullable(problem),
  receipt_lookup_supported: c.boolean,
});
const bytes = new TextEncoder();
const boundedText = (maximum: number) =>
  c.refine(
    c.text,
    (value) => value.length > 0 && bytes.encode(value).byteLength <= maximum,
    `nonempty string of at most ${maximum} UTF-8 bytes`,
  );
const savedRequest = c.record({
  jsonrpc: c.literal("2.0"),
  workgraph_api: c.literal("0.7"),
  id: boundedText(256),
  method: boundedText(128),
  params: c.object,
});
export const operation: c.Codec<Operation> = {
  worker: { kind: "operation", validated: operationShape },
  decode: (value, path = []) => {
    const result = operationShape.decode(value, path);
    if (!result.ok) return result;
    const { connection, preparation, request, state } = result.value;
    const original = preparation.connection;
    if (
      connection.id !== original.id ||
      connection.generation !== original.generation ||
      connection.label !== original.label ||
      connection.socket !== original.socket
    ) {
      return c.mismatch([...path, "connection"], "same immutable profile as preparation");
    }
    const frame = savedRequest.decode(request, [...path, "request"]);
    if (!frame.ok) return frame;
    if (frame.value.method !== preparation.method)
      return c.mismatch([...path, "request", "method"], "prepared method");
    const params = frame.value.params;
    let comparable = params;
    if (jsonField(preparation.params, "mutation_id") === undefined) {
      const generated = jsonField(params, "mutation_id");
      if (generated !== undefined) {
        const identity = identifier.decode(generated, [
          ...path,
          "request",
          "params",
          "mutation_id",
        ]);
        if (!identity.ok) return identity;
        comparable = {
          kind: "object",
          fields: params.fields.filter((field) => field.name !== "mutation_id"),
        };
      }
    }
    const expected = canonicalJson(preparation.params, { ...DEFAULT_JSON_LIMITS, maxDepth: 96 });
    const actual = canonicalJson(comparable, { ...DEFAULT_JSON_LIMITS, maxDepth: 96 });
    if (!expected.ok || !actual.ok || expected.value !== actual.value)
      return c.mismatch(
        [...path, "request", "params"],
        "exact prepared parameters with only an optional generated mutation_id",
      );
    for (const [name, expected] of [
      ["actor_id", preparation.context.writer.actor_id],
      ["run_id", preparation.context.writer.run_id],
    ] as const) {
      const field = jsonField(params, name);
      if (field !== undefined && (field.kind !== "string" || field.value !== expected))
        return c.mismatch([...path, "request", "params", name], "captured effective writer");
    }
    if (state.kind === "rejected" && state.problem.kind === "Outcome_unknown") {
      return c.mismatch([...path, "state"], "unknown outcome cannot be a definite rejection");
    }
    return result;
  },
};
export const readResponse: c.Codec<ReadResponse> = c.record({
  response: publicResponse,
  pagination: c.nullable(c.object),
});

export type Envelope<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: Problem };
export function envelope<T>(payload: c.Codec<T>): c.Codec<Envelope<T>> {
  return {
    decode: (value, path = []) => {
      if (value?.kind !== "object") return c.mismatch(path, "response envelope");
      const tag = c.boolean.decode(jsonField(value, "ok"), [...path, "ok"]);
      if (!tag.ok) return tag;
      return tag.value
        ? c.record({ ok: c.literal(true), data: payload }).decode(value, path)
        : c.record({ ok: c.literal(false), error: problem }).decode(value, path);
    },
  };
}

/** Explicit immutable JSON builders for our closed DTOs; never convert arbitrary data to JS numbers. */
export const jsonString = (value: string): JsonValue => {
  if (typeof value !== "string") throw new TypeError("JSON string builder requires a string.");
  return certifyJson(Object.freeze({ kind: "string", value }));
};
export const jsonObject = (
  fields: readonly (readonly [string, JsonValue])[],
): Extract<JsonValue, { kind: "object" }> => {
  const value = Object.freeze({
    kind: "object" as const,
    fields: Object.freeze(fields.map(([name, value]) => Object.freeze({ name, value }))),
  });
  return fields.every(([name, value]) => typeof name === "string" && isCapturedJson(value))
    ? certifyJson(value)
    : value;
};
export const jsonNull = (): JsonValue => certifyJson(Object.freeze({ kind: "null" }));
export const jsonBoolean = (value: boolean): JsonValue => {
  if (typeof value !== "boolean") throw new TypeError("JSON boolean builder requires a boolean.");
  return certifyJson(Object.freeze({ kind: "boolean", value }));
};
/** Exact lexeme; semantic validity and full limits remain a worker validation responsibility. */
export const jsonNumber = (lexeme: string): JsonValue => {
  if (typeof lexeme !== "string")
    throw new TypeError("JSON number builder requires a lexeme string.");
  return certifyJson(Object.freeze({ kind: "number", lexeme }));
};
export const jsonArray = (items: readonly JsonValue[]): Extract<JsonValue, { kind: "array" }> => {
  const value = Object.freeze({ kind: "array" as const, items: Object.freeze([...items]) });
  return items.every(isCapturedJson) ? certifyJson(value) : value;
};
