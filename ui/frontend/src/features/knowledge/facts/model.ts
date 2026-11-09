import { captureJson, capturedJsonWeight } from "../../../core/json/capture";
import type { FeatureContext } from "../../../app/types";
import { canonicalJson, jsonField, type JsonValue } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import type { Decimal, Identifier, Preparation } from "../../../core/protocol/types";
import type { ProtocolProcessor } from "../../../core/protocol/worker";
import {
  SOURCE_LIMITS,
  VALUE_LIMITS,
  keyCodec,
  referencesCodec,
  sameScope,
  scopeCodec,
  scopeJson,
} from "./codecs";
import type {
  FactDraft,
  FactEditInput,
  FactPredicate,
  FactQuery,
  FactScope,
  FactTarget,
  FactVersion,
} from "./types";
export class FactInputError extends Error {}
export const MAX_DRAFTS = 24,
  MAX_SOURCE_BYTES = 65536,
  MAX_DRAFT_BYTES = 128 * 1024,
  MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export function identifier(s: string): Identifier {
  const r = d.identifier.decode(d.jsonString(s));
  if (!r.ok)
    throw new FactInputError(
      "Use an actual identifier: ASCII letters, numbers, underscore or hyphen, up to 96 characters.",
    );
  return r.value;
}
export function decimal(s: string): Decimal {
  const r = d.decimal.decode(d.jsonString(s));
  if (!r.ok)
    throw new FactInputError(
      "Enter a canonical nonnegative revision within the daemon counter range.",
    );
  return r.value;
}
export function key(s: string): string {
  const r = keyCodec.decode(d.jsonString(s));
  if (!r.ok)
    throw new FactInputError(
      "Enter a nonblank key, up to 128 UTF-8 bytes, without control characters.",
    );
  return r.value;
}
export function scope(value: FactScope): FactScope {
  const r = scopeCodec.decode(scopeJson(value));
  if (!r.ok)
    throw new FactInputError("Select an explicit workspace, project, milestone or ticket scope.");
  return Object.freeze({ ...r.value });
}
export function target(context: FeatureContext): FactTarget {
  if (context.route.workspaceId === null) throw new FactInputError("Select a workspace first.");
  return Object.freeze({
    connection: Object.freeze({ ...context.connection }),
    workspaceId: identifier(context.route.workspaceId),
    scope:
      context.route.projectId === null
        ? Object.freeze({ kind: "workspace" })
        : Object.freeze({ kind: "project", id: identifier(context.route.projectId) }),
  });
}
export function targetKey(t: FactTarget): string {
  return JSON.stringify([
    t.connection.id,
    t.connection.generation,
    t.connection.socket,
    t.workspaceId,
    t.scope.kind,
    t.scope.kind === "workspace" ? null : t.scope.id,
  ]);
}
export function sameTarget(a: FactTarget, b: FactTarget): boolean {
  return (
    a.connection.id === b.connection.id &&
    a.connection.generation === b.connection.generation &&
    a.connection.socket === b.connection.socket &&
    a.workspaceId === b.workspaceId &&
    sameScope(a.scope, b.scope)
  );
}
export function copyInput(input: FactEditInput): FactEditInput {
  if (new TextEncoder().encode(input.source).byteLength > MAX_SOURCE_BYTES)
    throw new FactInputError(
      "Raw source exceeds 64 KiB. The canonical fact value may contain at most 4096 UTF-8 bytes.",
    );
  const captured = input.structured === undefined ? undefined : captureJson(input.structured);
  if (captured !== undefined && !captured.ok) throw new FactInputError(captured.message);
  const structured = captured?.ok ? captured.value : undefined;
  if (structured !== undefined && capturedJsonWeight(structured) > MAX_DRAFT_BYTES)
    throw new FactInputError("Structured fact candidate exceeds 128 KiB of retained input.");
  const candidate = structured === undefined ? {} : { structured };
  const refs = input.references;
  if (refs.kind === "preserve")
    return Object.freeze({
      source: input.source,
      ...candidate,
      references: Object.freeze({ kind: "preserve" }),
    });
  if (
    refs.items.length > 32 ||
    refs.items.some((ref) => new TextEncoder().encode(ref.id).byteLength > 128)
  )
    throw new FactInputError(
      "References allow at most 32 rows and 128 UTF-8 bytes per identifier.",
    );
  return Object.freeze({
    source: input.source,
    ...candidate,
    references: Object.freeze({
      kind: "replace",
      items: Object.freeze(refs.items.map((ref) => Object.freeze({ ...ref }))),
    }),
  });
}
export function inputBytes(input: FactEditInput): number {
  return (
    new TextEncoder().encode(input.source).byteLength +
    (input.structured === undefined ? 0 : capturedJsonWeight(input.structured)) +
    (input.references.kind === "preserve"
      ? 0
      : input.references.items.reduce((sum, r) => sum + r.id.length + r.kind.length, 0))
  );
}
export async function parseValue(
  processing: ProtocolProcessor,
  source: string,
  signal?: AbortSignal,
): Promise<JsonValue> {
  const parsed = await processing.parse(source, {
    limits: SOURCE_LIMITS,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!parsed.ok) throw new FactInputError(parsed.failure.message);
  if (!parsed.value.ok) throw new FactInputError(parsed.value.error.message);
  const encoded = await processing.encode(parsed.value.value.value, {
    canonical: true,
    limits: VALUE_LIMITS,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!encoded.ok) throw new FactInputError(encoded.failure.message);
  if (!encoded.value.ok) throw new FactInputError(encoded.value.error.message);
  return parsed.value.value.value;
}
export function validatePointer(pointer: string) {
  if (
    new TextEncoder().encode(pointer).byteLength > 512 ||
    (pointer !== "" && !pointer.startsWith("/")) ||
    (pointer !== "" && pointer.split("/").length - 1 > 16) ||
    /~(?![01])/u.test(pointer)
  )
    throw new FactInputError(
      "Use an RFC6901 pointer: empty for the root, otherwise /segments with only ~0 and ~1 escapes, at most 16 segments/512 UTF-8 bytes.",
    );
}
export function copyQuery(query: FactQuery): FactQuery {
  if (new TextEncoder().encode(query.prefix).byteLength > 128)
    throw new FactInputError("Literal prefix exceeds 128 UTF-8 bytes.");
  if (query.predicates.length > 8)
    throw new FactInputError("At most8 literal scalar predicates are supported.");
  const predicates: FactPredicate[] = query.predicates.map((p) => {
    validatePointer(p.pointer);
    if (p.equals.kind === "object" || p.equals.kind === "array")
      throw new FactInputError("Predicate equality requires a scalar; missing never equals null.");
    const checked = canonicalJson(p.equals, VALUE_LIMITS);
    if (!checked.ok) throw new FactInputError(checked.error.message);
    let equals: JsonValue;
    switch (p.equals.kind) {
      case "null":
        equals = d.jsonNull();
        break;
      case "boolean":
        equals = d.jsonBoolean(p.equals.value);
        break;
      case "string":
        equals = d.jsonString(p.equals.value);
        break;
      case "number":
        equals = d.jsonNumber(p.equals.lexeme);
        break;
    }
    return Object.freeze({ pointer: p.pointer, equals });
  });
  return Object.freeze({
    prefix: query.prefix,
    includeDeleted: query.includeDeleted,
    predicates: Object.freeze(predicates),
  });
}
export function initialSource(version: FactVersion | undefined): JsonValue {
  return version?.kind === "value" ? version.value : d.jsonNull();
}
export async function prepareDraft(
  draft: FactDraft,
  processing: ProtocolProcessor,
  signal?: AbortSignal,
): Promise<Preparation> {
  const actor = draft.writer.actorId;
  const revision = draft.base.value.kind === "missing" ? decimal("0") : draft.base.value.revision;
  if (draft.base.partial)
    throw new FactInputError(
      "An incomplete read cannot establish a fact guard. Refresh the exact key first.",
    );
  const fields: (readonly [string, JsonValue])[] = [
    ["workspace_id", d.jsonString(draft.target.workspaceId)],
    ["mutation_id", d.jsonString(draft.id)],
    ["scope", scopeJson(draft.target.scope)],
    ["key", d.jsonString(draft.key)],
    ["expected_revision", d.jsonString(revision)],
    ["actor_id", d.jsonString(identifier(actor))],
    ...(draft.writer.runId === null
      ? []
      : [["run_id", d.jsonString(identifier(draft.writer.runId))] as const]),
  ];
  if (draft.method === "fact.put") {
    let value: JsonValue;
    if (draft.input.structured === undefined)
      value = await parseValue(processing, draft.input.source, signal);
    else {
      const encoded = await processing.encode(draft.input.structured, {
        limits: VALUE_LIMITS,
        canonical: true,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!encoded.ok) throw new FactInputError(encoded.failure.message);
      if (!encoded.value.ok) throw new FactInputError(encoded.value.error.message);
      value = draft.input.structured;
    }
    fields.push(["value", value]);
    if (draft.input.references.kind === "replace") {
      const encoded = d.jsonArray(
        draft.input.references.items.map((r) =>
          d.jsonObject([
            ["kind", d.jsonString(r.kind)],
            ["id", d.jsonString(r.id)],
          ]),
        ),
      );
      const checked = referencesCodec.decode(encoded);
      if (!checked.ok)
        throw new FactInputError(
          "References require at most 32 distinct valid ticket or resource identifiers. Repair the retained reference rows.",
        );
      fields.push(["references", encoded]);
    }
  } else if (draft.base.value.kind === "missing" || draft.base.value.kind === "deleted")
    throw new FactInputError("Only an existing active fact can be deleted.");
  return Object.freeze({
    intention_id: draft.id,
    connection_id: draft.target.connection.id,
    generation: draft.target.connection.generation,
    context: Object.freeze({
      workspace_id: draft.target.workspaceId,
      project_id: draft.target.scope.kind === "project" ? draft.target.scope.id : null,
      writer: Object.freeze({
        actor_id: identifier(actor),
        run_id: draft.writer.runId === null ? null : identifier(draft.writer.runId),
      }),
    }),
    method: draft.method,
    params: d.jsonObject(fields),
  });
}
/** Guard display never conflates an absent value with a present JSON null. */
export function valueAt(value: JsonValue, pointer: string): JsonValue | undefined {
  validatePointer(pointer);
  if (pointer === "") return value;
  let current: JsonValue | undefined = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const part = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (current === undefined) return undefined;
    switch (current.kind) {
      case "object":
        current = jsonField(current, part);
        break;
      case "array":
        current =
          /^(0|[1-9][0-9]*)$/u.test(part) && BigInt(part) < BigInt(current.items.length)
            ? current.items[Number(BigInt(part))]
            : undefined;
        break;
      case "null":
      case "boolean":
      case "string":
      case "number":
        return undefined;
    }
  }
  return current;
}
