import type { ResourceScope } from "../../knowledge/resources/types";
import type { CatalogConfig, ConfigReadResult, ConfigStore } from "./types";
/** Pin verification and decoded identity must both succeed before an entry becomes usable. Raw source stays available on mismatch. */
export async function readCatalogEntry(
  store: ConfigStore,
  scope: ResourceScope,
  entry: CatalogConfig["entries"][number],
  signal?: AbortSignal,
): Promise<ConfigReadResult> {
  const expectedKind = entry.kind,
    expectedId = entry.id;
  const result = await store.read(scope, Object.freeze({ ...entry.pin }), signal);
  if (!result.ok || result.capture.decoded.kind !== "valid") return result;
  const document = result.capture.decoded.document;
  if (!("kind" in document) || document.kind !== expectedKind || document.id !== expectedId)
    return {
      ok: true,
      capture: Object.freeze({
        ...result.capture,
        decoded: {
          kind: "invalid" as const,
          raw: result.capture.decoded.raw,
          issues: [
            {
              path: [],
              message:
                "Catalog entry kind/ID differs from its exact pinned source. No current-version fallback was used.",
            },
          ],
        },
      }),
    };
  return result;
}
