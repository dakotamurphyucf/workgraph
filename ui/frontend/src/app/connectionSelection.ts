import type { ConnectionProfile } from "../core/protocol/types";

/** Resolve an implicit choice once. Reordering or removing a profile never selects another endpoint. */
export function pinDefaultProfile(
  previous: string | null,
  profiles: readonly ConnectionProfile[],
): string | null {
  return previous ?? profiles[0]?.id ?? null;
}
