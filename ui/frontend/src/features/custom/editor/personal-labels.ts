import type { ProtocolProcessor } from "../../../core/protocol/worker";
import { decodeConfigSource } from "../config";
import { sameTarget } from "./settings";
import type { PersonalDocument, PersonalLabelCapture, PersonalSettings } from "./types";

/** Presentation only. Opaque, unsupported and mismatched documents retain their stable ID. */
export async function validatedPersonalTitle(
  processing: ProtocolProcessor,
  document: PersonalDocument,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await decodeConfigSource(processing, document.source, signal);
  if (!result.ok || signal.aborted || result.value.kind !== "valid") return null;
  const config = result.value.document;
  return "kind" in config &&
    (config.kind === "view" || config.kind === "renderer") &&
    config.id === document.id
    ? config.title
    : null;
}

/** Exact capture check also fences callers retaining a label from another private revision. */
export function personalTitle(
  settings: PersonalSettings,
  document: PersonalDocument,
  labels: PersonalLabelCapture | null,
): string | null {
  if (
    labels === null ||
    !sameTarget(labels.settings.target, settings.target) ||
    labels.settings.revision !== settings.revision
  )
    return null;
  return (
    labels.documents.find((item) => item.id === document.id && item.source === document.source)
      ?.title ?? null
  );
}
