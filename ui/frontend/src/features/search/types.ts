import type { ReactNode } from "react";
import type { Route } from "../../app/types";
import type { HttpClient, HttpFailure, HttpResult } from "../../core/protocol/http";
import type {
  ConnectionProfile,
  Decimal,
  Identifier,
  ReadResponse,
} from "../../core/protocol/types";
import type { ReadState } from "../../core/state/read-slot";
import type {
  SearchCapture as HistorySearchCapture,
  SearchQuery as HistorySearchQuery,
  SearchHit as HistorySearchHit,
} from "../history/analytics/types";

/** One exact daemon generation and explicit workspace, never inferred from a hit ID. */
export interface SearchScope {
  readonly connection: ConnectionProfile;
  readonly workspaceId: Identifier;
  readonly projectId: Identifier | null;
}
export type EntityTarget =
  | { readonly kind: "workspace" }
  | { readonly kind: "project" | "milestone" | "ticket" | "resource"; readonly id: Identifier };
export type FactScope =
  | { readonly kind: "workspace" }
  | { readonly kind: "project" | "milestone" | "ticket"; readonly id: Identifier };
export type SearchKind =
  | "workspace"
  | "project"
  | "milestone"
  | "ticket"
  | "comment"
  | "handoff"
  | "resource"
  | "resource_text"
  | "fact";
/** Exact native source schemas; entity revision, content version and fact revision differ. */
export type SearchSource =
  | { readonly kind: "workspace"; readonly workspace_id: Identifier; readonly revision: Decimal }
  | { readonly kind: "project"; readonly project_id: Identifier; readonly revision: Decimal }
  | { readonly kind: "milestone"; readonly milestone_id: Identifier; readonly revision: Decimal }
  | {
      readonly kind: "ticket" | "handoff";
      readonly ticket_id: Identifier;
      readonly revision: Decimal;
    }
  | { readonly kind: "comment"; readonly comment_id: Identifier; readonly revision: Decimal }
  | {
      readonly kind: "resource" | "resource_text";
      readonly resource_id: Identifier;
      readonly revision: Decimal;
    }
  | {
      readonly kind: "fact";
      readonly scope: FactScope;
      readonly key: string;
      readonly revision: Decimal;
    };
export interface SearchMatch {
  readonly field: string;
  readonly match_offset: Decimal;
  readonly match_bytes: Decimal;
  readonly snippet_offset: Decimal;
  readonly snippet: string;
}
export interface SearchHit {
  readonly source: SearchSource;
  readonly target: EntityTarget;
  readonly matches: readonly SearchMatch[];
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly offset: Decimal;
  readonly remaining: Decimal;
  readonly next_offset: Decimal | null;
}
export interface ResourceCoverage {
  readonly source: Extract<SearchSource, { readonly kind: "resource" | "resource_text" }>;
  readonly reason:
    "prefix_only" | "invalid_utf8" | "not_requested" | "query_text_budget" | "unsupported_mime";
  readonly indexed_bytes: Decimal;
  readonly omitted_bytes: Decimal;
  readonly size_known: boolean;
}
export interface SearchCoverage {
  readonly current_revisions_only: boolean;
  readonly eligible_text_resources: Decimal;
  readonly indexed_text_resources: Decimal;
  readonly unindexed_text_resources: Decimal;
  readonly truncated_text_resources: Decimal;
  readonly resource_prefix_bytes: Decimal;
  readonly request_text_bytes: Decimal;
}
export interface SearchPage extends Page<SearchHit> {
  readonly unindexed_resources: Page<ResourceCoverage>;
  readonly index_revision: Decimal;
  readonly sources_scanned: Decimal;
  readonly coverage: SearchCoverage;
}
export interface PlanningQuery {
  readonly text: string;
  readonly kinds: readonly SearchKind[];
  readonly includeArchived: boolean;
}
export interface PlanningCapture {
  readonly scope: SearchScope;
  readonly query: PlanningQuery;
  readonly revision: Decimal;
  readonly value: SearchPage;
  readonly response: ReadResponse;
  /** Daemon byte-budget projection can omit noncontrol metadata. */
  readonly partial: boolean;
}
export interface CapturedHistorySearch {
  readonly scope: SearchScope;
  /** Original user query; later transport pages pin its head without rewriting this choice. */
  readonly requestedQuery: HistorySearchQuery;
  readonly value: HistorySearchCapture;
}
export interface SearchClient {
  readonly planning: (
    scope: SearchScope,
    query: PlanningQuery,
    offset: Decimal,
    atRevision?: Decimal,
    signal?: AbortSignal,
  ) => Promise<HttpResult<PlanningCapture>>;
  readonly history: (
    scope: SearchScope,
    query: HistorySearchQuery,
    after: HistorySearchHit["event_ref"] | null,
    signal: AbortSignal,
  ) => Promise<HttpResult<CapturedHistorySearch>>;
  /** Exact retained profile/socket comparison before daemon I/O. */
  readonly confirm: (
    scope: SearchScope,
    signal?: AbortSignal,
  ) => Promise<HttpResult<ConnectionProfile>>;
  readonly resolve: (
    capture: PlanningCapture,
    hit: SearchHit,
    signal?: AbortSignal,
  ) => Promise<HttpResult<Route>>;
}
export interface SearchDraft {
  readonly text: string;
  readonly domain: "planning" | "history";
  readonly kinds: readonly SearchKind[];
  readonly includeArchived: boolean;
  readonly sessionId: string;
  readonly paste: string;
}
export interface SearchState {
  readonly draft: SearchDraft;
  readonly planning: ReadState<PlanningCapture>;
  readonly history: ReadState<CapturedHistorySearch>;
  /** Last chosen result within this exact scope, restored when the palette returns. */
  readonly position: string | null;
  readonly opening: boolean;
  readonly issue: HttpFailure | null;
  readonly unexpected: { readonly owner: string; readonly error: unknown } | null;
  readonly recent: readonly Route[];
  readonly persistenceIssue: string | null;
}
export interface SearchController {
  readonly get: () => SearchState;
  readonly edit: (draft: SearchDraft) => void;
  readonly scope: (scope: SearchScope | null) => void;
  readonly position: (marker: string) => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly planning: (scope: SearchScope, query: PlanningQuery, next?: boolean) => Promise<void>;
  readonly history: (
    scope: SearchScope,
    query: HistorySearchQuery,
    next?: boolean,
  ) => Promise<void>;
  readonly open: (capture: PlanningCapture, hit: SearchHit) => Promise<Route | null>;
  readonly remember: (route: Route) => void;
  readonly clearRecent: () => void;
  /** Dismiss only a pending destination open; preserve query drafts and captured results. */
  readonly dismiss: () => void;
  readonly cancel: () => void;
  readonly dispose: () => void;
}
export interface SearchOptions {
  readonly http: HttpClient;
}
/** Passed by the shell even while offline or before a workspace is selected. */
export interface SearchPaletteContext {
  readonly connection: ConnectionProfile | null;
  readonly profiles: readonly ConnectionProfile[];
  readonly route: Route;
  readonly navigate: (route: Route) => void;
  readonly onClose: () => void;
}
export interface SearchFeatureProps {
  readonly context: SearchPaletteContext;
  readonly controller: SearchController;
  readonly mode: "jump" | "search";
  /** Optional feature-specific action groups; existing shell Actions remain separate. */
  readonly footer?: ReactNode;
}
