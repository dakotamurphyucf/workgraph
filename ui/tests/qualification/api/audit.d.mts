import type { AuditManifest, Descriptor, AuditIssue } from "./types.mjs";
/** Structural integrity never establishes that referenced behavioral tests passed. */
export function audit(
  manifest: AuditManifest,
  descriptors: readonly Descriptor[],
  helperNames: readonly string[],
  workflowNames: readonly string[],
  additionalNames: readonly string[],
  availablePaths: ReadonlyMap<string, string>,
): readonly AuditIssue[];
