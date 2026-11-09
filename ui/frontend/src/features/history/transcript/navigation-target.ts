import type { HistoryNavigationTarget, HistoryScope, ScopeRef } from "./types";
import type { Decimal, Identifier } from "../../../core/protocol/types";
type Target =
  | { readonly kind: "run"; readonly runId: Identifier }
  | {
      readonly kind: "resource-version";
      readonly resourceId: Identifier;
      readonly contentVersion: Decimal;
    }
  | { readonly kind: "scope"; readonly scope: ScopeRef };
/** Synchronous immutable capture. Future navigation must resolve this generation and exact content pin, or show unavailable. */
export function historyNavigationTarget(
  scope: HistoryScope,
  target: Target,
): HistoryNavigationTarget {
  const base = {
    connectionId: scope.connectionId,
    generation: scope.generation,
    workspaceId: scope.workspaceId,
  };
  return target.kind === "scope"
    ? Object.freeze({ ...base, kind: "scope", scope: Object.freeze({ ...target.scope }) })
    : Object.freeze({ ...base, ...target });
}
