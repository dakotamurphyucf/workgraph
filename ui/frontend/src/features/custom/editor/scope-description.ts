import type { ConfigScope, ConfigSource } from "../config";

/** Describes the existing native link filter, without changing query or coverage semantics. */
export function resourceScopeDescription(
  source: ConfigSource,
  scope: Pick<ConfigScope, "kind">,
): string | null {
  if (source !== "resources") return null;
  return scope.kind === "workspace"
    ? "Resources linked to this workspace. Unlinked resources can still appear in the Resources directory; this view excludes them."
    : `Resources linked to the selected ${scope.kind}. Other resources in the workspace are excluded.`;
}
