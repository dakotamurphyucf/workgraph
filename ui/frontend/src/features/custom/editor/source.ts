import { isCapturedJson, captureJson } from "../../../core/json/capture";
import { canonicalJson, jsonField, type JsonValue } from "../../../core/json";
import { createCompanion } from "../../../core/protocol/client";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type { JsonObject, ReadInvocation, ReadResponse } from "../../../core/protocol/types";
import {
  configJson,
  initialQuery,
  projectSessionRow,
  type LoadedRow,
  type JsonScalar,
  type ContentPin,
  type ViewConfig,
} from "../config";
import { decodeConfigValue } from "../config/decode";
import { ticketCodec } from "../../work/read-model.codec";
import { runCodec, attemptCodec, fields } from "../../participants/runs/codecs";
import { sessionRecord, historyCapture } from "../../history/transcript/codecs";
import { resourceChunkCodec, resourceRecordCodec } from "../../knowledge/resources/codecs";
import { factKeyCodec } from "../../knowledge/facts/codecs";
import { decodeCapture } from "../../knowledge/facts/client";
import { factObservationCodec, factPageCodec, sameScope } from "../../knowledge/facts/codecs";
import { adaptResourceChunk } from "../../knowledge/resources/transfer";
import { chunkBytes } from "../../history/transcript/bytes";
import { thread } from "../../discussions/threads/codecs";
import { activityDigest } from "../../overview/codecs";
import { captureTarget } from "./settings";
import type { CustomPage, CustomSourceAdapter, CustomTarget, SourceCapture } from "./types";

/** Exact optional value acquisition; collection traversal remains a separate capture. */
export interface CustomPageEnrichment {
  readonly kind: "fact_values" | "resource_json";
  readonly rows: readonly {
    readonly identity: string;
    readonly status:
      "decoded" | "missing" | "deleted" | "unsupported" | "budget" | "invalid" | "unavailable";
    readonly message: string | null;
    /** Immutable resource content identity; never the metadata revision. */
    readonly pin: ContentPin | null;
  }[];
  /** Original queries and complete lossless replies for value joins/ranges. */
  readonly reads: readonly {
    readonly invocation: ReadInvocation;
    readonly response: ReadResponse;
  }[];
  /** Null for fact values; resource JSON follows the explicit finite page policy. */
  readonly limits: {
    readonly perResourceBytes: 65536;
    readonly pageBytes: 1048576;
  } | null;
}

export type CustomSourceByteCoverage =
  | { readonly kind: "reported"; readonly truncated: boolean }
  | { readonly kind: "not_reported"; readonly message: string };
class ProjectionError extends Error {}
function read<T>(codec: c.Codec<T>, value: JsonValue | undefined): T {
  const decoded = codec.decode(value);
  if (!decoded.ok)
    throw new ProjectionError(`${decoded.issue.path.join(".")}: ${decoded.issue.expected}`);
  return decoded.value;
}
const protocol = (message: string): HttpResult<never> => ({
  ok: false,
  failure: { kind: "protocol", message, issue: undefined },
});
const optionalText = (value: string | null) =>
  value === null ? d.jsonNull() : d.jsonString(value);
const itemArray = c.array(c.object, 100);
const budget = fields({
  truncated: c.boolean,
  omitted_fields: d.decimal,
  omitted_items: d.decimal,
});
function partial(response: ReadResponse): boolean {
  const value = jsonField(response.response.meta, "budget");
  if (value === undefined) return true;
  const found = read(budget, value);
  if (found.truncated !== (found.omitted_fields !== "0" || found.omitted_items !== "0"))
    throw new ProjectionError("Contradictory native budget disclosure.");
  return found.truncated;
}
function sameJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  const options = { maxBytes: 65536, maxDepth: 64, maxNodes: 10000, maxStringBytes: 65536 };
  const a = canonicalJson(left, options),
    b = canonicalJson(right, options);
  return a.ok && b.ok && a.value === b.value;
}
function capture(target: CustomTarget, view: ViewConfig, response: ReadResponse): SourceCapture {
  const meta = response.response.meta;
  switch (view.source) {
    case "tickets":
    case "resources":
    case "facts":
      return { kind: "planning", revision: read(d.decimal, jsonField(meta, "workspace_revision")) };
    case "runs":
    case "attempts": {
      if (read(c.text, jsonField(meta, "query_scope")) !== "runs")
        throw new ProjectionError("Expected runs-domain capture.");
      const history = jsonField(meta, "history_capture");
      const found =
        history === undefined
          ? null
          : read(
              fields({
                head: c.nullable(d.digest),
                sequence: d.decimal,
                workspace_id: d.identifier,
              }),
              history,
            );
      if (found !== null && found.workspace_id !== target.workspaceId)
        throw new ProjectionError("History association changed workspace.");
      return {
        kind: "runs",
        revision: read(d.decimal, jsonField(meta, "query_revision")),
        history: found === null ? null : { head: found.head, sequence: found.sequence },
      };
    }
    case "discussions":
      if (read(c.text, jsonField(meta, "query_scope")) !== "communication")
        throw new ProjectionError("Expected communication-domain capture.");
      return {
        kind: "communication",
        revision: read(d.decimal, jsonField(meta, "query_revision")),
      };
    case "sessions": {
      const found = read(historyCapture, jsonField(meta, "history_capture"));
      if (found.workspace_id !== target.workspaceId)
        throw new ProjectionError("History capture changed workspace.");
      return { kind: "history", head: found.head, sequence: found.sequence };
    }
    case "activity": {
      const found = read(activityDigest, response.response.data).capture;
      return { kind: "activity", ...found, lineage: read(d.digest, d.jsonString(found.lineage)) };
    }
  }
}
/** Each projection names real native fields. Absent ownership/time is never fabricated. */
export function projectRows(
  target: CustomTarget,
  view: ViewConfig,
  response: ReadResponse,
  observed: SourceCapture,
): readonly LoadedRow[] {
  const data = response.response.data;
  if (view.source === "activity") {
    const value = read(activityDigest, data);
    const identities = value.entries.map((entry) => `${entry.revision}:${entry.changeIndex}`);
    if (new Set(identities).size !== identities.length)
      throw new ProjectionError("Duplicate Activity row identity.");
    return value.entries.map((entry) => {
      const actor = jsonField(entry.item.record, "actor_id");
      if (actor !== undefined && actor.kind !== "null") read(d.identifier, actor);
      return {
        identity: `${entry.revision}:${entry.changeIndex}`,
        fields: {
          kind: d.jsonString(entry.category),
          ...(actor === undefined ? {} : { actor_id: actor }),
          revision: d.jsonNumber(entry.revision),
          summary: d.jsonString(entry.item.summary),
        },
      };
    });
  }
  const items = read(itemArray, jsonField(data, "items"));
  const rows = items.map((item): LoadedRow => {
    switch (view.source) {
      case "activity":
        throw new ProjectionError("Activity rows use their capture-aware projection.");
      case "tickets": {
        const value = read(ticketCodec, item);
        return {
          identity: value.ticket_id,
          fields: {
            ticket_id: d.jsonString(value.ticket_id),
            title: d.jsonString(value.title),
            status: d.jsonString(value.status),
            priority: d.jsonNumber(value.priority),
            assignee_id: optionalText(value.assignee_id),
            project_id: optionalText(value.project_id),
            milestone_id: optionalText(value.milestone_id),
          },
        };
      }
      case "runs": {
        const value = read(runCodec, item);
        if (
          observed.kind !== "runs" ||
          observed.history === null ||
          value.session_associations.history_head !== observed.history.head
        )
          throw new ProjectionError(
            "Run associations differ from the collection's exact history head.",
          );
        return {
          identity: value.run_id,
          fields: {
            run_id: d.jsonString(value.run_id),
            actor_id: d.jsonString(value.actor_id),
            status: d.jsonString(value.status),
            objective: d.jsonString(value.objective),
            parent_run_id: optionalText(value.parent_run_id),
          },
        };
      }
      case "attempts": {
        const value = read(attemptCodec, item);
        return {
          identity: value.attempt_id,
          fields: {
            attempt_id: d.jsonString(value.attempt_id),
            ticket_id: d.jsonString(value.ticket_id),
            target_run_id: d.jsonString(value.run_id),
            state: d.jsonString(value.state),
          },
        };
      }
      case "sessions": {
        const value = read(sessionRecord, item);
        if (value.workspace_id !== target.workspaceId)
          throw new ProjectionError("Session row changed workspace.");
        return projectSessionRow(value);
      }
      case "resources": {
        const value = read(resourceRecordCodec, item);
        return {
          identity: value.resource_id,
          fields: {
            resource_id: d.jsonString(value.resource_id),
            name: d.jsonString(value.metadata.title),
            mime_type: d.jsonString(value.current_version.mime_type),
            version: d.jsonNumber(value.current_version.revision),
            size_bytes:
              value.current_version.size_bytes === null
                ? d.jsonNull()
                : d.jsonNumber(value.current_version.size_bytes),
            archived: d.jsonBoolean(value.metadata.archived),
          },
        };
      }
      case "facts": {
        const value = read(factKeyCodec, item);
        if (!sameJson(jsonField(item, "scope"), scopeJson(view)))
          throw new ProjectionError("Fact row changed exact scope.");
        return {
          identity: value.key,
          fields: { key: d.jsonString(value.key), revision: d.jsonNumber(value.revision) },
        };
      }
      case "discussions": {
        const value = read(thread, item);
        return {
          identity: value.id,
          fields: {
            thread_id: d.jsonString(value.id),
            title: d.jsonString(value.title),
            board_id: d.jsonString(value.boardId),
            state: d.jsonString(value.status),
            unresolved: d.jsonBoolean(value.status !== "resolved"),
            // Native thread.list filters exact immutable board scope (Scope.equal).
            // validateInvocation binds that selector to this retained view.
            scope: d.jsonString(view.scope.kind),
          },
        };
      }
    }
  });
  if (new Set(rows.map((row) => row.identity)).size !== rows.length)
    throw new ProjectionError("Duplicate source row identity.");
  return rows;
}
function scopeJson(view: ViewConfig) {
  return d.jsonObject([
    ["kind", d.jsonString(view.scope.kind)],
    ...(view.scope.kind === "workspace" ? [] : [["id", d.jsonString(view.scope.id)] as const]),
  ]);
}
const savedRead = c.record({
  jsonrpc: c.literal("2.0"),
  workgraph_api: c.literal("0.7"),
  id: c.text,
  method: c.text,
  params: c.object,
});
const paginationCodec = fields({
  complete: c.boolean,
  stop: c.text,
  consistency: c.text,
  capture: c.object,
  next_request: c.nullable(savedRead),
  retry_request: c.nullable(savedRead),
  required_bytes: c.nullable(d.decimal),
  returned_bytes: d.decimal,
  max_bytes: c.literal("65536"),
});
function guard(observed: SourceCapture): readonly (readonly [string, JsonValue])[] {
  switch (observed.kind) {
    case "planning":
      return [["at_revision", d.jsonString(observed.revision)]];
    case "communication":
      return [["revision", d.jsonString(observed.revision)]];
    case "runs":
      return [
        ["expected_revision", d.jsonString(observed.revision)],
        ...(observed.history === null
          ? []
          : [
              [
                "head",
                observed.history.head === null ? d.jsonNull() : d.jsonString(observed.history.head),
              ] as const,
            ]),
      ];
    case "history":
      return [["head", observed.head === null ? d.jsonNull() : d.jsonString(observed.head)]];
    case "activity":
      return [];
  }
}
function continued(
  invocation: ReadInvocation,
  response: ReadResponse,
  observed: SourceCapture,
  rows: number,
  candidate: { readonly method: string; readonly params: JsonObject } | null,
  retry: boolean,
): ReadInvocation | null {
  if (candidate === null) return null;
  if (candidate.method !== invocation.method)
    throw new ProjectionError("Continuation changed method.");
  const variable = new Set(["offset", "max_bytes", ...guard(observed).map(([name]) => name)]);
  if (observed.kind === "activity") {
    variable.add("cursor");
    variable.add("after");
  }
  const strip = (params: JsonObject) =>
    d.jsonObject(
      params.fields
        .filter((field) => !variable.has(field.name))
        .map((field) => [field.name, field.value]),
    );
  if (!sameJson(strip(invocation.params), strip(candidate.params)))
    throw new ProjectionError("Continuation changed original source selectors.");
  for (const [name, value] of guard(observed))
    if (!sameJson(jsonField(candidate.params, name), value))
      throw new ProjectionError("Continuation changed its native capture guard.");
  const beforeBudget = read(d.decimal, jsonField(invocation.params, "max_bytes")),
    afterBudget = read(d.decimal, jsonField(candidate.params, "max_bytes"));
  if (
    BigInt(afterBudget) > 1048576n ||
    (retry ? BigInt(afterBudget) <= BigInt(beforeBudget) : afterBudget !== beforeBudget)
  )
    throw new ProjectionError("Continuation budget is not bounded/advancing.");
  if (observed.kind === "activity") {
    if (
      !sameJson(
        jsonField(candidate.params, "cursor"),
        jsonField(response.response.data, "cursor"),
      ) ||
      jsonField(candidate.params, "after") !== undefined
    )
      throw new ProjectionError("Activity continuation changed exact captured cursor.");
    if (
      !retry &&
      sameJson(jsonField(invocation.params, "cursor"), jsonField(candidate.params, "cursor"))
    )
      throw new ProjectionError("Activity cursor made no progress.");
  } else {
    const before = read(d.decimal, jsonField(invocation.params, "offset") ?? d.jsonString("0")),
      after = read(d.decimal, jsonField(candidate.params, "offset"));
    if (BigInt(after) !== BigInt(before) + (retry ? 0n : BigInt(rows)) || (!retry && rows === 0))
      throw new ProjectionError("Source continuation did not advance by returned rows.");
    if (
      !retry &&
      !sameJson(
        jsonField(candidate.params, "offset"),
        jsonField(response.response.data, "next_offset"),
      )
    )
      throw new ProjectionError("Continuation differs from native next offset.");
  }
  return Object.freeze({ ...invocation, params: candidate.params });
}
function sameCapture(left: SourceCapture, right: SourceCapture): boolean {
  switch (left.kind) {
    case "planning":
    case "communication":
      return right.kind === left.kind && right.revision === left.revision;
    case "runs":
      return (
        right.kind === "runs" &&
        right.revision === left.revision &&
        (left.history === null
          ? right.history === null
          : right.history !== null &&
            left.history.head === right.history.head &&
            left.history.sequence === right.history.sequence)
      );
    case "history":
      return (
        right.kind === "history" && left.head === right.head && left.sequence === right.sequence
      );
    case "activity":
      return (
        right.kind === "activity" &&
        left.lineage === right.lineage &&
        left.through === right.through &&
        BigInt(right.after) >= BigInt(left.after)
      );
  }
}
function captureMetadata(observed: SourceCapture): JsonObject {
  switch (observed.kind) {
    case "planning":
      return d.jsonObject([["workspace_revision", d.jsonString(observed.revision)]]);
    case "communication":
      return d.jsonObject([
        ["query_revision", d.jsonString(observed.revision)],
        ["query_scope", d.jsonString("communication")],
      ]);
    case "runs":
      return d.jsonObject([
        ["query_revision", d.jsonString(observed.revision)],
        ["query_scope", d.jsonString("runs")],
        ...(observed.history === null
          ? []
          : [
              [
                "head",
                observed.history.head === null ? d.jsonNull() : d.jsonString(observed.history.head),
              ] as const,
            ]),
      ]);
    case "history":
      return d.jsonObject([
        ["head", observed.head === null ? d.jsonNull() : d.jsonString(observed.head)],
      ]);
    case "activity":
      return d.jsonObject([
        ["through", d.jsonString(observed.through)],
        ["lineage", d.jsonString(observed.lineage)],
      ]);
  }
}
/** Only small owned DTO wrappers are visited; immutable JSON trees need no traversal. */
function freezeOwned<T>(value: T): T {
  if (
    typeof value !== "object" ||
    value === null ||
    isCapturedJson(value) ||
    Object.isFrozen(value)
  )
    return value;
  for (const child of Object.values(value)) freezeOwned(child);
  return Object.freeze(value);
}
function retainedView(view: ViewConfig): ViewConfig {
  // Copy literal filter scalars separately so even the largest valid small config
  // is certified without walking a caller-owned aggregate past admission bounds.
  const scalar = (value: JsonScalar): JsonScalar => {
    const owned = captureJson(value);
    if (!owned.ok || owned.value.kind === "object" || owned.value.kind === "array")
      throw new ProjectionError("Invalid literal filter scalar.");
    return owned.value;
  };
  const snapshot = captureJson(
    configJson({
      ...view,
      filters: view.filters.map((filter) =>
        filter.op === "one_of"
          ? { ...filter, values: filter.values.map(scalar) }
          : filter.op === "equals"
            ? { ...filter, value: scalar(filter.value) }
            : { ...filter },
      ),
    }),
  );
  if (!snapshot.ok) throw new ProjectionError("View exceeds captured configuration bounds.");
  const parsed = decodeConfigValue(snapshot.value);
  if (parsed.kind !== "valid" || !("kind" in parsed.document) || parsed.document.kind !== "view")
    throw new ProjectionError("Repair the view configuration before querying.");
  return freezeOwned(parsed.document);
}
function ownInvocation(invocation: ReadInvocation): ReadInvocation {
  const owned = captureJson(invocation.params);
  if (!owned.ok || owned.value.kind !== "object")
    throw new ProjectionError("Source parameters are not bounded immutable JSON.");
  return Object.freeze({ ...invocation, params: owned.value });
}
function validateInvocation(target: CustomTarget, view: ViewConfig, invocation: ReadInvocation) {
  const initial = initialQuery(view, target.workspaceId);
  if (
    invocation.connection_id !== target.connection.id ||
    invocation.generation !== target.connection.generation ||
    invocation.method !== initial.method ||
    invocation.lane !== (view.source === "sessions" ? "history" : "visible")
  )
    throw new ProjectionError("Source invocation changed its retained endpoint, method or lane.");
  const nativeGuards =
    view.source === "runs"
      ? ["expected_revision", "head"]
      : view.source === "attempts"
        ? ["expected_revision"]
        : view.source === "sessions"
          ? ["head"]
          : view.source === "discussions"
            ? ["revision"]
            : view.source === "activity"
              ? []
              : ["at_revision"];
  const variable = new Set(["offset", "max_bytes", ...nativeGuards]);
  if (view.source === "activity") {
    variable.add("cursor");
    variable.add("after");
  }
  const strip = (params: JsonObject) =>
    d.jsonObject(
      params.fields
        .filter((field) => !variable.has(field.name))
        .map((field) => [field.name, field.value]),
    );
  if (!sameJson(strip(initial.params), strip(invocation.params)))
    throw new ProjectionError("Source invocation changed the retained view selectors/scope.");
  const budget = read(d.decimal, jsonField(invocation.params, "max_bytes"));
  if (BigInt(budget) > 1048576n || budget === "0")
    throw new ProjectionError("Invalid bounded source budget.");
}
export function decodeSourcePage(
  target: CustomTarget,
  view: ViewConfig,
  invocation: ReadInvocation,
  response: ReadResponse,
  previous?: SourceCapture,
): HttpResult<CustomPage> {
  try {
    target = captureTarget(target);
    view = retainedView(view);
    invocation = ownInvocation(invocation);
    validateInvocation(target, view, invocation);
    const observed = capture(target, view, response);
    if (previous !== undefined && !sameCapture(previous, observed))
      throw new ProjectionError("Source capture changed between pages.");
    for (const [name, value] of guard(observed)) {
      const requested = jsonField(invocation.params, name);
      if (requested !== undefined && !sameJson(requested, value))
        throw new ProjectionError("Returned source does not match requested capture.");
    }
    const rows = projectRows(target, view, response, observed);
    if (response.pagination === null)
      throw new ProjectionError("Native continuation metadata is missing.");
    const page = read(paginationCodec, response.pagination),
      expected =
        observed.kind === "history"
          ? "immutable_history_head"
          : observed.kind === "activity"
            ? "opaque_captured_cursor"
            : "current_revision_guard";
    if (!sameJson(page.capture, captureMetadata(observed)))
      throw new ProjectionError("Continuation metadata differs from returned native capture.");
    if (page.consistency !== expected || page.complete !== (page.stop === "complete"))
      throw new ProjectionError("Invalid source continuation completeness/consistency.");
    const next = continued(invocation, response, observed, rows.length, page.next_request, false),
      retry = continued(invocation, response, observed, rows.length, page.retry_request, true);
    if (page.complete && (next !== null || retry !== null))
      throw new ProjectionError("Completed page offered a continuation.");
    return {
      ok: true,
      httpStatus: 200,
      data: freezeOwned({
        target,
        view,
        invocation,
        response,
        capture: observed,
        rows,
        complete: page.complete,
        partial: partial(response),
        byteCoverage:
          jsonField(response.response.meta, "budget") === undefined
            ? {
                kind: "not_reported",
                message:
                  "Native source reports no byte-omission metadata; complete traversal does not establish complete row fields.",
              }
            : { kind: "reported", truncated: partial(response) },
        next,
        retry,
        stop: page.stop,
      }),
    };
  } catch (error) {
    if (error instanceof ProjectionError) return protocol(error.message);
    throw error;
  }
}
const aborted = (): HttpResult<never> => ({ ok: false, failure: { kind: "aborted" } });
type Coverage = CustomPageEnrichment["rows"][number];
function enriched(
  page: CustomPage,
  kind: CustomPageEnrichment["kind"],
  rows: readonly LoadedRow[],
  coverage: readonly Coverage[],
  reads: CustomPageEnrichment["reads"],
): HttpResult<CustomPage> {
  return {
    ok: true,
    httpStatus: 200,
    data: freezeOwned({
      ...page,
      rows,
      partial: page.partial || coverage.some((row) => row.status !== "decoded"),
      enrichment: {
        kind,
        rows: coverage,
        reads,
        limits: kind === "resource_json" ? { perResourceBytes: 65536, pageBytes: 1048576 } : null,
      },
    }),
  };
}
export function createSourceAdapter(http: HttpClient): CustomSourceAdapter {
  const api = createCompanion(http);
  async function factValues(
    page: CustomPage,
    signal: AbortSignal,
  ): Promise<HttpResult<CustomPage>> {
    if (page.capture.kind !== "planning") return protocol("Facts require planning capture.");
    const keys = page.rows.map((row) => row.identity),
      scope = page.view.scope;
    const invocation: ReadInvocation = Object.freeze({
      connection_id: page.target.connection.id,
      generation: page.target.connection.generation,
      lane: "visible",
      method: "fact.multi_get",
      params: d.jsonObject([
        ["workspace_id", d.jsonString(page.target.workspaceId)],
        ["scope", scopeJson(page.view)],
        ["limit", d.jsonString("100")],
        ["max_bytes", d.jsonString("1048576")],
        ["offset", d.jsonString("0")],
        ["at_revision", d.jsonString(page.capture.revision)],
        ["keys", d.jsonArray(keys.map(d.jsonString))],
      ]),
    });
    const result = await api.read(invocation, signal);
    if (signal.aborted) return aborted();
    const reads = result.ok ? [{ invocation, response: result.data }] : [];
    const unavailable = (status: Coverage["status"], message: string) =>
      enriched(
        page,
        "fact_values",
        page.rows,
        page.rows.map((row) => ({ identity: row.identity, status, message, pin: null })),
        reads,
      );
    if (!result.ok)
      return result.failure.kind === "aborted"
        ? result
        : unavailable("unavailable", `Fact values unavailable: ${result.failure.kind}.`);
    let clipped: boolean;
    try {
      clipped = partial(result.data);
    } catch (error) {
      if (error instanceof ProjectionError) return unavailable("invalid", error.message);
      throw error;
    }
    const values = decodeCapture(
      { ...page.target, scope },
      result.data,
      factPageCodec(factObservationCodec),
      page.capture.revision,
    );
    if (!values.ok)
      return unavailable(
        clipped ? "budget" : "invalid",
        clipped
          ? "Fact value reply was clipped by its byte budget; no omitted value is treated as missing."
          : "Invalid fact value reply; inspect the original reply.",
      );
    const value = values.data.value;
    if (
      value.offset !== "0" ||
      value.items.some(
        (item, index) => item.key !== keys[index] || !sameScope(item.scope, scope),
      ) ||
      BigInt(value.remaining) + BigInt(value.items.length) !== BigInt(keys.length)
    )
      return unavailable("invalid", "Fact join changed requested key order/count or scope.");
    const coverage: Coverage[] = [];
    const rows = page.rows.map((row, index) => {
      const item = value.items[index];
      if (item === undefined) {
        coverage.push({
          identity: row.identity,
          status: "budget",
          message: "Fact value not returned in this bounded join.",
          pin: null,
        });
        return row;
      }
      if (item.kind === "missing") {
        coverage.push({
          identity: row.identity,
          status: "missing",
          message: "Native join explicitly reported this key missing.",
          pin: null,
        });
        return row;
      }
      if (row.fields.revision?.kind !== "number" || row.fields.revision.lexeme !== item.revision) {
        coverage.push({
          identity: row.identity,
          status: "invalid",
          message: "Fact value changed per-key revision within the planning capture.",
          pin: null,
        });
        return row;
      }
      if (item.kind === "deleted") {
        coverage.push({
          identity: row.identity,
          status: "deleted",
          message: "Native join reports a deleted fact.",
          pin: null,
        });
        return row;
      }
      if (clipped) {
        coverage.push({
          identity: row.identity,
          status: "budget",
          message: "Fact reply was clipped; pointer values are unavailable.",
          pin: null,
        });
        return row;
      }
      coverage.push({ identity: row.identity, status: "decoded", message: null, pin: null });
      return { ...row, fields: { ...row.fields, value: item.value }, decoded: item.value };
    });
    return enriched(page, "fact_values", rows, coverage, reads);
  }
  async function resourceJson(
    page: CustomPage,
    signal: AbortSignal,
  ): Promise<HttpResult<CustomPage>> {
    const records = read(itemArray, jsonField(page.response.response.data, "items")).map((item) =>
      read(resourceRecordCodec, item),
    );
    const rows: LoadedRow[] = [],
      coverage: Coverage[] = [],
      reads: { invocation: ReadInvocation; response: ReadResponse }[] = [];
    let reserved = 0n;
    for (let index = 0; index < page.rows.length; index++) {
      if (signal.aborted) return aborted();
      const row = page.rows[index],
        record = records[index];
      if (row === undefined || record === undefined)
        throw new Error("Admitted resource row lost its record.");
      const version = record.current_version,
        size = version.size_bytes;
      const pin: ContentPin | null =
        size === null
          ? null
          : Object.freeze({
              resource_id: record.resource_id,
              version: version.revision,
              digest: version.digest,
              size_bytes: size,
            });
      const mark = (status: Coverage["status"], message: string | null) => {
        rows.push(row);
        coverage.push({ identity: row.identity, status, message, pin });
      };
      if (pin === null) {
        mark("unavailable", "Native content size is unavailable; JSON pointers were not loaded.");
        continue;
      }
      if (
        version.mime_type.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" &&
        !version.mime_type.split(";", 1)[0]?.trim().toLowerCase().endsWith("+json")
      ) {
        mark("unsupported", "This content MIME type is not JSON; use its exact resource link.");
        continue;
      }
      if (BigInt(pin.size_bytes) > 65536n || reserved + BigInt(pin.size_bytes) > 1048576n) {
        mark(
          "budget",
          "JSON pointer loading is limited to 64 KiB per resource and 1 MiB per page.",
        );
        continue;
      }
      reserved += BigInt(pin.size_bytes);
      const invocation: ReadInvocation = Object.freeze({
        connection_id: page.target.connection.id,
        generation: page.target.connection.generation,
        lane: "visible",
        method: "resource.read_chunk",
        params: d.jsonObject([
          ["workspace_id", d.jsonString(page.target.workspaceId)],
          ["resource_id", d.jsonString(pin.resource_id)],
          ["version", d.jsonString(pin.version)],
          ["offset", d.jsonString("0")],
          ["length", d.jsonString("65536")],
        ]),
      });
      const result = await api.read(invocation, signal);
      if (signal.aborted) return aborted();
      if (!result.ok) {
        if (result.failure.kind === "aborted") return result;
        mark("unavailable", `Pinned content unavailable: ${result.failure.kind}.`);
        continue;
      }
      reads.push({ invocation, response: result.data });
      const parsed = resourceChunkCodec.decode(result.data.response.data);
      if (!parsed.ok) {
        mark("invalid", "Invalid pinned resource range; inspect its raw reply.");
        continue;
      }
      const chunk = parsed.value;
      if (!chunk.eof || chunk.next_offset !== null || chunk.chunk_digest !== pin.digest) {
        mark("invalid", "Resource range is not the complete exact pinned content.");
        continue;
      }
      const adapted = await adaptResourceChunk(
        {
          ...page.target,
          resourceId: pin.resource_id,
          version: pin.version,
          digest: pin.digest,
          sizeBytes: pin.size_bytes,
          filename: version.filename,
          mimeType: version.mime_type,
        },
        chunk,
        read(d.decimal, d.jsonString("0")),
      );
      if (signal.aborted) return aborted();
      if (!adapted.ok) {
        mark("invalid", "Pinned resource bytes failed identity/length/hash verification.");
        continue;
      }
      const bytes = chunkBytes(adapted.data, adapted.data.blob, 0, 65536);
      // Check exact UTF-8 before worker JSON parsing; neither replacement decoding nor
      // partial JSON may activate pointer data.
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        mark("invalid", "Pinned JSON content is not valid UTF-8.");
        continue;
      }
      const document = await http.processing.parse(bytes, {
        signal,
        limits: { maxBytes: 65536, maxDepth: 64, maxNodes: 20000, maxStringBytes: 65536 },
      });
      if (signal.aborted) return aborted();
      if (!document.ok) {
        if (document.failure.kind === "aborted") return aborted();
        mark("unavailable", `JSON processing unavailable: ${document.failure.kind}.`);
        continue;
      }
      if (!document.value.ok) {
        mark("invalid", "Pinned content is not valid JSON within the pointer limits.");
        continue;
      }
      rows.push({ ...row, decoded: document.value.value.value });
      coverage.push({ identity: row.identity, status: "decoded", message: null, pin });
    }
    return enriched(page, "resource_json", rows, coverage, reads);
  }
  async function load(
    target: CustomTarget,
    view: ViewConfig,
    invocation: ReadInvocation,
    signal: AbortSignal,
    previous?: SourceCapture,
  ): Promise<HttpResult<CustomPage>> {
    if (signal.aborted) return aborted();
    const result = await api.read(invocation, signal);
    if (signal.aborted) return aborted();
    if (!result.ok) return result;
    const page = decodeSourcePage(target, view, invocation, result.data, previous);
    if (!page.ok || page.data.rows.length === 0) return page;
    if (view.source === "facts") return factValues(page.data, signal);
    if (
      view.source === "resources" &&
      view.columns.some((column) => column.selector.kind === "pointer")
    )
      return resourceJson(page.data, signal);
    return page;
  }
  return {
    initial(target, view, signal) {
      try {
        const owner = captureTarget(target),
          config = retainedView(view),
          query = initialQuery(config, owner.workspaceId);
        return load(
          owner,
          config,
          Object.freeze({
            connection_id: owner.connection.id,
            generation: owner.connection.generation,
            method: query.method,
            params: query.params,
            lane: config.source === "sessions" ? "history" : "visible",
          }),
          signal,
        );
      } catch (error) {
        if (error instanceof ProjectionError) return Promise.resolve(protocol(error.message));
        throw error;
      }
    },
    next(page, kind, signal) {
      try {
        const selected = kind === "next" ? page.next : page.retry;
        if (selected === null)
          return Promise.resolve(protocol("No captured continuation is available."));
        const target = captureTarget(page.target),
          view = retainedView(page.view),
          invocation = ownInvocation(selected),
          previous = freezeOwned({
            ...page.capture,
            ...(page.capture.kind === "runs"
              ? { history: page.capture.history === null ? null : { ...page.capture.history } }
              : {}),
          });
        validateInvocation(target, view, invocation);
        for (const [name, expected] of guard(previous))
          if (!sameJson(jsonField(invocation.params, name), expected))
            return Promise.resolve(
              protocol("Continuation no longer carries its original capture guard."),
            );
        return load(target, view, invocation, signal, previous);
      } catch (error) {
        if (error instanceof ProjectionError) return Promise.resolve(protocol(error.message));
        throw error;
      }
    },
  };
}
