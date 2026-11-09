import { jsonField, type JsonLimits, type JsonValue } from "../../../core/json";
import type { ProtocolProcessor, ProcessingResult } from "../../../core/protocol/worker/types";
import { structureCodec } from "./codecs";
import { semanticIssues } from "./semantics";
import type { ConfigDecode } from "./types";
import { compareNumbers, integerNumber } from "./values";

export const CONFIG_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 65_536,
  maxDepth: 64,
  maxNodes: 65_536,
  maxStringBytes: 65_536,
});
/** Called only on the bounded, duplicate-free lossless parser result. */
export function decodeConfigValue(raw: JsonValue): ConfigDecode {
  const version = jsonField(raw, "config_version");
  if (
    version?.kind === "number" &&
    compareNumbers(version.lexeme, "1") !== 0 &&
    integerNumber(version.lexeme)
  )
    return { kind: "unsupported_version", version: version.lexeme, raw };
  const structure = structureCodec.decode(raw);
  if (!structure.ok)
    return {
      kind: "invalid",
      raw,
      issues: [{ path: structure.issue.path, message: structure.issue.expected }],
    };
  const issues = semanticIssues(structure.value);
  return issues.length === 0
    ? { kind: "valid", document: structure.value, raw }
    : { kind: "invalid", issues, raw };
}
export type ConfigSourceDecode =
  ConfigDecode | { readonly kind: "invalid_json"; readonly message: string };
/** Parsing enforces raw bytes, Unicode, duplicate-key, depth and aggregate limits before activation. */
export async function decodeConfigSource(
  processing: ProtocolProcessor,
  source: string | Uint8Array,
  signal?: AbortSignal,
): Promise<ProcessingResult<ConfigSourceDecode>> {
  const result = await processing.parse(source, {
    limits: CONFIG_LIMITS,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!result.ok) return result;
  if (!result.value.ok)
    return { ok: true, value: { kind: "invalid_json", message: result.value.error.message } };
  return { ok: true, value: decodeConfigValue(result.value.value.value) };
}
