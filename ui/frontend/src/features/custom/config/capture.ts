import type {
  ResourceCapture,
  ResourceRecord,
  ResourceTarget,
} from "../../knowledge/resources/types";
import type { PublicationBase } from "./types";
import { ConfigInputError } from "./publication";
/** A complete typed metadata read establishes count/link guards; content bytes are a separate verified capture. */
export function publicationBase(
  capture: ResourceCapture<ResourceRecord>,
  link: Extract<ResourceTarget, { kind: "workspace" | "project" }>,
): PublicationBase {
  const record = capture.value;
  if (
    capture.partial ||
    record.version_count !== record.current_version.revision ||
    record.current_version.size_bytes === null ||
    BigInt(record.revision) < BigInt(record.version_count)
  )
    throw new ConfigInputError(
      "Publication requires complete resource metadata, version count and known content size.",
    );
  return Object.freeze({
    kind: "existing",
    scope: Object.freeze({
      ...capture.scope,
      connection: Object.freeze({ ...capture.scope.connection }),
    }),
    link: Object.freeze({ ...link }),
    resourceId: record.resource_id,
    metadataRevision: record.revision,
    versionCount: record.version_count,
    content: Object.freeze({
      resource_id: record.resource_id,
      version: record.current_version.revision,
      digest: record.current_version.digest,
      size_bytes: record.current_version.size_bytes,
    }),
    linked: record.metadata.targets.some(
      (target) =>
        target.kind === link.kind &&
        (target.kind === "workspace" || (link.kind === "project" && target.id === link.id)),
    ),
  });
}
