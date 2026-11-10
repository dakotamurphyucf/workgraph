import { resolveFormat } from "../../../content/languages";
import type { ResourceCapture, ResourceContent, ResourceRecord } from "./types";

/** Current metadata is a presentation hint only for the matching current
 * publication. Keep historical hints and immutable byte pins unchanged. */
export function resourcePresentation(
  content: ResourceContent,
  capture: ResourceCapture<ResourceRecord> | undefined,
): ResourceContent {
  if (content.kind !== "verified" || capture === undefined) return content;
  const { pin, source } = content;
  const { scope, value } = capture;
  if (
    scope.connection.id !== pin.connection.id ||
    scope.connection.generation !== pin.connection.generation ||
    scope.connection.socket !== pin.connection.socket ||
    scope.workspaceId !== pin.workspaceId ||
    value.resource_id !== pin.resourceId
  )
    return content;
  const current =
    value.current_version.revision === pin.version && value.current_version.digest === pin.digest;
  if (!current) return content;
  const filename = value.metadata.filename;
  const mime = value.metadata.mime_type;
  if (source.hints.filename === filename && source.hints.mime === mime) return content;
  return Object.freeze({
    ...content,
    source: Object.freeze({
      ...source,
      hints: Object.freeze({ ...source.hints, filename, mime }),
    }),
  });
}

export function resourceSize(value: string | null): string {
  if (value === null) return "Size not recorded";
  const bytes = BigInt(value);
  for (const [unit, divisor] of [
    ["MiB", 1048576n],
    ["KiB", 1024n],
  ] as const) {
    if (bytes >= divisor)
      return `${bytes / divisor}.${((bytes % divisor) * 10n) / divisor} ${unit}`;
  }
  return `${bytes} bytes`;
}
export function resourceKind(input: string, filename?: string): string {
  const mime = input.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const format = resolveFormat({ mime, ...(filename === undefined ? {} : { filename }) }, "auto");
  if (format.language === "markdown" && format.via !== "default") return "Markdown";
  if (format.language === "json") return "JSON";
  if (mime.includes("json")) return "JSON";
  if (mime.startsWith("image/")) return "Image";
  if (mime === "application/pdf") return "PDF";
  if (mime.startsWith("text/")) return "Text";
  return "File";
}
