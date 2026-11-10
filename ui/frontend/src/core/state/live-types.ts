import type { ConnectionProfile, Identifier } from "../protocol/types";
import type { HttpResult } from "../protocol/http";

export type LiveFollowMode = "follow_latest" | "reading_older" | "historical";
export type LiveSource = "planning" | "history" | "runtime";
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
  readonly refresh: LiveRefresh;
}
export interface LiveStatus {
  readonly kind: "connecting" | "live" | "reconnecting" | "offline" | "paused" | "refresh_failed";
  readonly lastSuccessMs: number | null;
  readonly failures: number;
  readonly retainedCapture: boolean;
}
/** Both positions travel together; the untouched feed retains its exact cursor. */
export interface LiveCursor {
  readonly planning: string;
  readonly runtime: string | null;
  readonly history: string | null;
}
export interface LiveChangePage {
  readonly cursor: LiveCursor;
  readonly hasMore: boolean;
  readonly needsLargerBudget: boolean;
  readonly changed: boolean;
}
export interface LiveChangeReader {
  readonly read: (
    scope: LiveScope,
    sources: readonly LiveSource[],
    cursor: LiveCursor | null,
    wait: boolean,
    signal: AbortSignal,
  ) => Promise<HttpResult<LiveChangePage>>;
}
/** One owner per application launch. Pages attach projections; equal endpoint,
 * workspace and feed sets retain observation across attachment replacement.
 * Background visibility does not stop observation or projection refresh.
 * Projection reads cancel separately. Ending observation requests server-side
 * cancellation and drains the response; it has no write/lifecycle meaning. */
export interface LiveReadOwner {
  readonly get: () => LiveStatus;
  readonly subscribe: (listener: () => void) => () => void;
  readonly open: (scope: LiveScope, adapter: LiveAdapter) => () => void;
  readonly refresh: () => Promise<void>;
  readonly dispose: () => void;
}
/** Controller implementation opts current projections into passive refresh.
 * Guard reads, immutable bytes and retained historical captures stay fixed. */
export interface LiveReadable {
  readonly refreshLive: LiveRefresh;
}
