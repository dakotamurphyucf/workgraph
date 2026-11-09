import { test, expect } from "@playwright/test";
import { startDaemonFixture, fixtureBinary } from "../../../../test-support/daemon-fixture.mjs";
import { canonicalJson, jsonField, parseJsonText, type JsonValue } from "../../../src/core/json";
import { prepareConfigPublication } from "../../../src/features/custom/config/publication";
import { decodeConfigValue } from "../../../src/features/custom/config/decode";
import { projectSessionRow, timelineTime } from "../../../src/features/custom/config/loaded";
import { sessionDetail } from "../../../src/features/history/transcript/codecs";
import { view } from "./fixtures";
import { publicationBase } from "../../../src/features/custom/config/capture";
import type {
  ResourceCapture,
  ResourceRecord,
} from "../../../src/features/knowledge/resources/types";
import { resourceRecordCodec } from "../../../src/features/knowledge/resources/codecs";
import * as d from "../../../src/core/protocol/decoders";
import { createTestProcessor } from "../../core/processing-harness";
import { decimal, identifier, intention } from "./fixtures";
function encoded(value: JsonValue): string {
  const r = canonicalJson(value);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
function data(raw: string): JsonValue {
  const r = parseJsonText(raw);
  if (!r.ok) throw new Error(r.error.message);
  const result = jsonField(r.value.value, "result");
  if (result === undefined) throw new Error(raw);
  const value = jsonField(result, "data");
  if (value === undefined) throw new Error(raw);
  return value;
}
// Helper/storage proof only: product editor composition belongs to ui-v-editor.
// eslint-disable-next-line no-empty-pattern
test("Config native publication commits exact pins, retries identically and rolls back stale index/metadata guards atomically", async ({}, info) => {
  const daemon = await startDaemonFixture({ binary: fixtureBinary() }),
    processing = createTestProcessor();
  const observations: object[] = [];
  try {
    const connection = {
      id: identifier("fixture"),
      generation: decimal("1"),
      socket: daemon.socket,
      label: "Owned fixture",
    };
    await daemon.call(
      "session.create",
      JSON.stringify({
        workspace_id: "demo",
        session_id: "timeline-source",
        title: "Real native timestamp",
        actor_id: daemon.actor,
        mutation_id: "timeline-source-create",
        scopes: [],
      }),
    );
    const nativeSession = sessionDetail.decode(
      data(
        await daemon.call(
          "session.get",
          JSON.stringify({ workspace_id: "demo", session_id: "timeline-source" }),
        ),
      ),
    );
    if (!nativeSession.ok) throw new Error(nativeSession.issue.expected);
    const projected = projectSessionRow(nativeSession.value.session);
    const timeline = view("sessions", {
      sort: [{ field: "created_at", direction: "desc", nulls: "last" }],
      presentation: "timeline",
    });
    expect(nativeSession.value.session.created_at_unix_ms).not.toBeNull();
    expect(projected.fields.created_at).toEqual(
      d.jsonNumber(nativeSession.value.session.created_at_unix_ms!),
    );
    expect(timelineTime(projected, timeline)).not.toBeNull();
    observations.push({
      nativeSession: nativeSession.value.session,
      projectedTimestamp: projected.fields.created_at,
      timelinePlacement: timelineTime(projected, timeline),
    });
    const base = intention(connection);
    const prepared = await prepareConfigPublication(processing, base),
      request = encoded(prepared.preparation.params);
    const first = data(await daemon.call("transaction.apply", request));
    const retry = data(await daemon.call("transaction.apply", request));
    expect(encoded(retry)).toBe(encoded(first));
    const captures = new Map<string, ResourceCapture<ResourceRecord>>();
    const get = async (resourceId: string) => {
      const raw = await daemon.call(
        "resource.get",
        JSON.stringify({ workspace_id: "demo", resource_id: resourceId }),
      );
      const result = resourceRecordCodec.decode(data(raw));
      if (!result.ok) throw new Error(result.issue.expected);
      const parsedRaw = parseJsonText(raw);
      if (!parsedRaw.ok) throw new Error(parsedRaw.error.message);
      const envelope = jsonField(parsedRaw.value.value, "result");
      if (envelope === undefined) throw new Error("native result");
      const response = d.readResponse.decode(
        d.jsonObject([
          ["response", envelope],
          ["pagination", d.jsonNull()],
        ]),
      );
      if (!response.ok) throw new Error(response.issue.expected);
      const revision = d.decimal.decode(
        jsonField(response.value.response.meta, "workspace_revision"),
      );
      if (!revision.ok) throw new Error("native capture");
      const budget = jsonField(response.value.response.meta, "budget");
      const truncated = budget === undefined ? undefined : jsonField(budget, "truncated");
      if (truncated !== undefined && (truncated.kind !== "boolean" || truncated.value))
        throw new Error("Incomplete metadata capture");
      captures.set(resourceId, {
        scope: { connection, workspaceId: identifier("demo") },
        value: result.value,
        response: response.value,
        queryRevision: revision.value,
        partial: false,
      });

      return result.value;
    };
    const document = await get("custom-view"),
      catalog = await get("custom-catalog");
    expect(document.revision).toBe("2");
    expect(document.version_count).toBe("1");
    expect(document.current_version.digest).toBe(prepared.documentPin.digest);
    expect(catalog.current_version.digest).toBe(prepared.catalogPin.digest);
    const indexParams = {
      workspace_id: "demo",
      scope: { kind: "workspace" },
      key: "ui.config.index",
    };
    const index = data(await daemon.call("fact.get", JSON.stringify(indexParams)));
    expect(encoded(index)).toContain(prepared.catalogPin.digest);
    const staleIndex = await prepareConfigPublication(processing, {
      ...base,
      intentionId: identifier("stale-index"),
      documentResourceId: identifier("unpublished-view"),
      catalogResourceId: identifier("unpublished-catalog"),
    });
    await expect(
      daemon.call("transaction.apply", encoded(staleIndex.preparation.params)),
    ).rejects.toThrow('"kind":"Conflict"');
    for (const resource_id of ["unpublished-view", "unpublished-catalog"])
      await expect(
        daemon.call("resource.get", JSON.stringify({ workspace_id: "demo", resource_id })),
      ).rejects.toThrow('"kind":"Not_found"');
    expect(encoded(data(await daemon.call("fact.get", JSON.stringify(indexParams))))).toBe(
      encoded(index),
    );
    const operations = jsonField(prepared.preparation.params, "operations");
    if (operations?.kind !== "array") throw new Error("ops");
    const catalogParams = jsonField(operations.items[2]!, "params");
    if (catalogParams === undefined) throw new Error("params");
    const catalogText = jsonField(catalogParams, "text");
    if (catalogText?.kind !== "string") throw new Error("text");
    const parsed = parseJsonText(catalogText.value);
    if (!parsed.ok) throw new Error("catalog");
    const scope = { connection, workspaceId: identifier("demo") };
    const capture = (record: ResourceRecord): ResourceCapture<ResourceRecord> => {
      const retained = captures.get(record.resource_id);
      if (retained === undefined || retained.value.revision !== record.revision)
        throw new Error("Resource metadata capture mismatch");
      return retained;
    };
    const update = {
      ...base,
      intentionId: identifier("stale-metadata"),
      capture: {
        ...base.capture,
        documentBase: publicationBase(capture(document), { kind: "workspace" }),
        catalogBase: publicationBase(capture(catalog), { kind: "workspace" }),
        index: { ...base.capture.index, expectedRevision: decimal("1") },
        catalog: {
          kind: "existing" as const,
          capture: {
            scope,
            pin: prepared.catalogPin,
            blob: new Blob([catalogText.value]),
            decoded: decodeConfigValue(parsed.value.value),
          },
        },
      },
    };
    const staged = await prepareConfigPublication(processing, update);
    await daemon.call(
      "resource.update",
      JSON.stringify({
        workspace_id: "demo",
        actor_id: daemon.actor,
        mutation_id: "concurrent-metadata",
        resource_id: "custom-view",
        expected_revision: "2",
        description: "Explicit concurrent edit",
      }),
    );
    await expect(
      daemon.call("transaction.apply", encoded(staged.preparation.params)),
    ).rejects.toThrow('"kind":"Conflict"');
    expect((await get("custom-view")).version_count).toBe("1");
    expect((await get("custom-catalog")).version_count).toBe("1");
    expect(encoded(data(await daemon.call("fact.get", JSON.stringify(indexParams))))).toBe(
      encoded(index),
    );
    // Explicit guarded rebase is a new intention; no retry identity is rewritten.
    const refreshed = await get("custom-view");
    const rebased = await prepareConfigPublication(processing, {
      ...update,
      intentionId: identifier("explicit-rebase"),
      capture: {
        ...update.capture,
        documentBase: publicationBase(capture(refreshed), { kind: "workspace" }),
      },
    });
    const rebasedOperations = jsonField(rebased.preparation.params, "operations");
    expect(rebasedOperations?.kind === "array" && rebasedOperations.items.length).toBe(3);
    await daemon.call("transaction.apply", encoded(rebased.preparation.params));
    expect((await get("custom-view")).version_count).toBe("2");
    expect((await get("custom-view")).revision).toBe("4");
    expect((await get("custom-catalog")).version_count).toBe("2");
    expect((await get("custom-catalog")).revision).toBe("3");
    expect(encoded(data(await daemon.call("fact.get", JSON.stringify(indexParams))))).toContain(
      rebased.catalogPin.digest,
    );
    observations.push({
      committed: true,
      exactRetryEqual: true,
      documentPin: prepared.documentPin,
      catalogPin: prepared.catalogPin,
      newLinks: 2,
      staleIndexRolledBackBothResources: true,
      staleMetadataPreservedBothContentVersionsAndIndex: true,
      explicitRebaseNewIdentityThreeOperationsContent2Metadata4: true,
    });
  } finally {
    processing.dispose();
    await daemon.dispose();
    await info.attach("config-native-storage-proof", {
      body: JSON.stringify({ observations, daemon: daemon.diagnostics() }, null, 2),
      contentType: "application/json",
    });
  }
});
