import type { ConnectionProfile, Decimal, Identifier } from "../protocol/types";
import type { HttpResult } from "../protocol/http";

export type LiveFollowMode = "follow_latest" | "reading_older" | "historical";
export type LiveSource = "planning" | "history";
/** Exact endpoint identity; project filtering belongs to the projection read,
 * not the workspace observer, so workspace-scoped changes still invalidate it. */
export interface LiveScope {
  readonly connection: ConnectionProfile;
  readonly workspaceId: Identifier | null;
  readonly projectId: Identifier | null;
}
export interface LiveRefreshResult {
  readonly ok: boolean;
  /** A deliberately pinned projection was retained; Latest remains explicit. */
  readonly retainedCapture?: boolean;
}
export type LiveRefresh = (signal: AbortSignal) => Promise<LiveRefreshResult>;
export interface LiveAdapter {
  readonly key: string;
  readonly sources: readonly LiveSource[];
  /** Ephemeral observations/host registries need bounded fallback polling. */
  readonly poll: boolean;
  readonly refresh: LiveRefresh;
}
export interface LiveStatus {
  readonly kind: "connecting" | "live" | "reconnecting" | "offline" | "paused";
  readonly lastSuccessMs: number | null;
  readonly failures: number;
  readonly retainedCapture: boolean;
}
export interface LiveChangePage {
  readonly source: LiveSource;
  readonly through: Decimal;
  readonly cursor: string;
  readonly hasMore: boolean;
  readonly needsLargerBudget: boolean;
  readonly changed: boolean;
}
export interface LiveChangeReader {
  readonly read: (
    scope: LiveScope,
    source: LiveSource,
    cursor: string | null,
    wait: boolean,
    signal: AbortSignal,
  ) => Promise<HttpResult<LiveChangePage>>;
}
/** One owner per mounted visible feature. Opening a new scope cancels old waits
 * and passive reads; stopping observation has no mutation/lifecycle meaning. */
export interface LiveReadOwner {
  readonly get: () => LiveStatus;
  readonly subscribe: (listener: () => void) => () => void;
  readonly open: (scope: LiveScope, adapter: LiveAdapter) => () => void;
  readonly refresh: () => Promise<void>;
  readonly setVisible: (visible: boolean) => void;
  readonly dispose: () => void;
}
/** Controller implementation opts current projections into passive refresh.
 * Guard reads, immutable bytes and retained historical captures stay fixed. */
export interface LiveReadable {
  readonly refreshLive: LiveRefresh;
}
