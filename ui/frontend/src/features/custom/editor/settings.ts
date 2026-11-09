import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { HttpClient, HttpResult } from "../../../core/protocol/http";
import type { Decimal, Identifier } from "../../../core/protocol/types";
import type { CustomTarget, PersonalSavePlan, PersonalSettings } from "./types";

const bytes = new TextEncoder();
/** Unknown configuration versions remain exact source text, not activated data. */
export const personalDocument = c.record({
  id: d.identifier,
  source: c.refine(c.text, (source) => bytes.encode(source).byteLength <= 65536, "source ≤64 KiB"),
});
const targetWire = c.record({ connection: d.connectionProfile, workspace_id: d.identifier });
const settingsWire = c.refine(
  c.record({
    target: targetWire,
    revision: d.decimal,
    documents: c.array(personalDocument, 25),
    selected_id: c.nullable(d.identifier),
  }),
  (value) =>
    new Set(value.documents.map((document) => document.id)).size === value.documents.length &&
    (value.selected_id === null ||
      value.documents.some((document) => document.id === value.selected_id)),
  "unique document IDs and an existing selected document",
);
export function sameTarget(left: CustomTarget, right: CustomTarget): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.connection.id === right.connection.id &&
    left.connection.generation === right.connection.generation &&
    left.connection.socket === right.connection.socket
  );
}
export function captureTarget(target: CustomTarget): CustomTarget {
  return Object.freeze({
    connection: Object.freeze({ ...target.connection }),
    workspaceId: target.workspaceId,
  });
}
export function captureSave(plan: PersonalSavePlan): PersonalSavePlan {
  return Object.freeze({
    target: captureTarget(plan.target),
    expectedRevision: plan.expectedRevision,
    documents: Object.freeze(plan.documents.map((document) => Object.freeze({ ...document }))),
    selectedId: plan.selectedId,
  });
}
export function settingsCodec(target: CustomTarget): c.Codec<PersonalSettings> {
  return {
    decode(value, path = []) {
      const result = settingsWire.decode(value, path);
      if (!result.ok) return result;
      const found = {
        connection: result.value.target.connection,
        workspaceId: result.value.target.workspace_id,
      };
      return sameTarget(target, found)
        ? {
            ok: true,
            value: Object.freeze({
              target: captureTarget(found),
              revision: result.value.revision,
              documents: result.value.documents,
              selectedId: result.value.selected_id,
            }),
          }
        : c.mismatch([...path, "target"], "original retained endpoint generation and workspace");
    },
  };
}
export interface PersonalTargetSummary {
  readonly target: CustomTarget;
  readonly documentIds: readonly Identifier[];
  readonly selectedId: Identifier | null;
}
export interface PersonalInventory {
  readonly revision: Decimal;
  readonly targets: readonly PersonalTargetSummary[];
}
const inventoryWire = c.record({
  revision: d.decimal,
  items: c.array(
    c.record({
      target: targetWire,
      document_ids: c.array(d.identifier, 25),
      selected_id: c.nullable(d.identifier),
    }),
    25,
  ),
});
export const inventoryCodec: c.Codec<PersonalInventory> = {
  decode(value, path = []) {
    const result = inventoryWire.decode(value, path);
    if (!result.ok) return result;
    const targets: PersonalTargetSummary[] = [];
    let total = 0;
    for (const item of result.value.items) {
      const target = { connection: item.target.connection, workspaceId: item.target.workspace_id };
      if (
        item.document_ids.length === 0 ||
        new Set(item.document_ids).size !== item.document_ids.length ||
        (item.selected_id !== null && !item.document_ids.includes(item.selected_id)) ||
        targets.some(
          (other) =>
            other.target.workspaceId === target.workspaceId &&
            other.target.connection.id === target.connection.id &&
            other.target.connection.generation === target.connection.generation,
        )
      )
        return c.mismatch(path, "nonempty unique saved-target summaries");
      total += item.document_ids.length;
      targets.push({
        target: captureTarget(target),
        documentIds: item.document_ids,
        selectedId: item.selected_id,
      });
    }
    return total > 25
      ? c.mismatch(path, "at most25 documents globally")
      : { ok: true, value: { revision: result.value.revision, targets } };
  },
};
function selector(target: CustomTarget) {
  return [
    ["connection_id", d.jsonString(target.connection.id)],
    ["generation", d.jsonString(target.connection.generation)],
    ["workspace_id", d.jsonString(target.workspaceId)],
  ] as const;
}
export interface PersonalClient {
  readonly inspect: (
    target: CustomTarget,
    signal?: AbortSignal,
  ) => Promise<HttpResult<PersonalSettings>>;
  readonly list: (signal?: AbortSignal) => Promise<HttpResult<PersonalInventory>>;
  readonly replace: (
    plan: PersonalSavePlan,
    signal?: AbortSignal,
  ) => Promise<HttpResult<PersonalSettings>>;
}
export function createPersonalClient(http: HttpClient): PersonalClient {
  return {
    inspect(target, signal) {
      const retained = captureTarget(target);
      return http.request({
        path: "/view-settings/inspect",
        method: "POST",
        body: d.jsonObject(selector(retained)),
        codec: settingsCodec(retained),
        ...(signal === undefined ? {} : { signal }),
      });
    },
    list(signal) {
      return http.request({
        path: "/view-settings/list",
        method: "POST",
        body: d.jsonObject([]),
        codec: inventoryCodec,
        ...(signal === undefined ? {} : { signal }),
      });
    },
    replace(plan, signal) {
      const retained = captureSave(plan),
        codec = settingsCodec(retained.target);
      const exact: c.Codec<PersonalSettings> = {
        decode(value, path = []) {
          const result = codec.decode(value, path);
          if (!result.ok) return result;
          const found = result.value;
          if (
            BigInt(found.revision) !== BigInt(retained.expectedRevision) + 1n ||
            found.selectedId !== retained.selectedId ||
            found.documents.length !== retained.documents.length ||
            found.documents.some(
              (document, index) =>
                document.id !== retained.documents[index]?.id ||
                document.source !== retained.documents[index]?.source,
            )
          )
            return c.mismatch(path, "exact saved settings and next private CAS revision");
          return result;
        },
      };
      return http.request({
        path: "/view-settings/replace",
        method: "POST",
        body: d.jsonObject([
          ...selector(retained.target),
          ["expected_revision", d.jsonString(retained.expectedRevision)],
          [
            "documents",
            d.jsonArray(
              retained.documents.map((document) =>
                d.jsonObject([
                  ["id", d.jsonString(document.id)],
                  ["source", d.jsonString(document.source)],
                ]),
              ),
            ),
          ],
          [
            "selected_id",
            retained.selectedId === null ? d.jsonNull() : d.jsonString(retained.selectedId),
          ],
        ]),
        codec: exact,
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}
