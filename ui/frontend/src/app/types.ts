import type { ReactNode } from "react";
import type { HttpClient } from "../core/protocol/http";
import type { ConnectionProfile } from "../core/protocol/types";

export type ViewId =
  | "overview"
  | "work"
  | "workflow"
  | "discussions"
  | "participants"
  | "history"
  | "resources"
  | "facts"
  | "activity"
  | "advanced"
  | "saved";
export interface HistoryRouteTarget {
  /** Immutable retained connection generation; never silently rebound to current. */
  readonly generation: string;
  /** null selects the empty capture, not current history. */
  readonly head: string | null;
  readonly sequence?: string;
}
export type DiscussionRouteTarget =
  | { readonly kind: "comment"; readonly generation: string; readonly revision: string }
  | {
      readonly kind: "board" | "thread";
      readonly generation: string;
    }
  | {
      readonly kind: "ticket";
      readonly generation: string;
      readonly comment: { readonly id: string; readonly revision: string } | null;
    }
  | {
      readonly kind: "messages";
      readonly generation: string;
      /** Explicit received-message browser consumer and recipient. It is never
       * the acting writer or an actionable Inbox consumer by default. */
      readonly capture: {
        readonly consumerId: string;
        readonly recipient: { readonly kind: "actor" | "run"; readonly id: string };
        readonly after: string;
        readonly through: string;
        readonly ticketId: string | null;
        readonly excludeSelf: boolean;
        readonly notificationId: string | null;
      } | null;
    };
/** A recorded participant target at one retained endpoint generation. */
export interface ParticipantsRouteTarget {
  readonly kind: "actor" | "run" | "attempt";
  readonly generation: string;
}
/** Requests retain their own selectors instead of borrowing a live discussion
 * or current acting recipient. Query capture and entity revision are distinct. */
export type RequestsRouteTarget =
  | { readonly kind: "requests"; readonly generation: string }
  | {
      readonly kind: "request";
      readonly generation: string;
      readonly requestId: string;
      readonly revision: string | null;
    }
  | {
      readonly kind: "inbox";
      readonly generation: string;
      readonly capture: {
        readonly consumerId: string;
        readonly recipient: { readonly kind: "actor" | "run"; readonly id: string };
        readonly after: string;
        readonly through: string;
        readonly kinds: readonly string[];
        readonly ticketId: string | null;
        readonly excludeSelf: boolean;
        readonly notificationId: string | null;
      } | null;
    }
  | {
      readonly kind: "routing";
      readonly generation: string;
      readonly entity: { readonly kind: "team" | "subscription"; readonly id: string } | null;
    };
/** Retained endpoint plus independently pinned published content. null follows
 * current verified publications; an unavailable requested version never rebases. */
export interface ResourceRouteTarget {
  readonly generation: string;
  readonly content: { readonly version: string; readonly expectedDigest: string | null } | null;
}
/** Recorded planning association, resolved as a current record at this exact
 * retained endpoint. It never promises historical planning state or write eligibility. */
export interface PlanningRouteTarget {
  readonly kind: "workspace" | "project" | "milestone" | "ticket";
  readonly generation: string;
}
/** Editable Work/Workflow destination admitted only after exact retained-profile verification. */
export interface WorkbenchRouteTarget {
  readonly generation: string;
  readonly socket: string;
}
/** Fact version and planning query revision are independent. Directory links retain
 * an explicit scope/endpoint without selecting a key or carrying a historical pin. */
export type FactRouteTarget = {
  readonly generation: string;
  readonly scope:
    | { readonly kind: "workspace" }
    | { readonly kind: "project" | "milestone" | "ticket"; readonly id: string };
} & (
  | { readonly key: null; readonly factRevision: null; readonly atRevision: null }
  | {
      readonly key: string;
      readonly factRevision: string | null;
      readonly atRevision: string | null;
    }
);
export interface CommandSearchContext {
  readonly connection: ConnectionProfile | null;
  readonly profiles: readonly ConnectionProfile[];
  readonly route: Route;
  readonly navigate: (route: Route) => void;
  readonly onClose: () => void;
}
/** A navigable subview belongs to one feature. It is URL state, so Back,
 * Forward and copied links restore the same screen without changing drafts. */
export type RouteSection =
  | { readonly view: "work"; readonly value: "list" | "board" }
  | {
      readonly view: "workflow";
      readonly value: "graph" | "relationships" | "templates" | "drafts" | "local-evidence";
    }
  | {
      readonly view: "participants";
      readonly value: "records" | "allocation" | "reservations" | "conditions" | "recovery";
    }
  | { readonly view: "history"; readonly value: "sessions" | "search" | "usage" | "summary" };
export interface Route {
  readonly view: ViewId;
  readonly connectionId: string | null;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  readonly entityId: string | null;
  readonly history?: HistoryRouteTarget;
  readonly discussion?: DiscussionRouteTarget;
  readonly participant?: ParticipantsRouteTarget;
  readonly requests?: RequestsRouteTarget;
  readonly resource?: ResourceRouteTarget;
  readonly planning?: PlanningRouteTarget;
  readonly workbench?: WorkbenchRouteTarget;
  readonly fact?: FactRouteTarget;
  readonly section?: RouteSection;
}
export interface WriterSelection {
  /** Read access does not require an acting actor. Selection never authenticates or transfers a claim. */
  readonly actorId: string | null;
  readonly runId: string | null;
}
export interface FeatureContext {
  readonly client: HttpClient;
  /** Exact profile generation; feature read/cache/cancel keys must include it. */
  readonly connection: ConnectionProfile;
  /** Directory freshness, not daemon health. Preserve existing drafts; do not silently recapture their writer/scope. */
  readonly profileState: "current" | "refreshing" | "unavailable";
  readonly route: Route;
  readonly writer: WriterSelection;
  readonly navigate: (route: Route) => void;
}
export interface ConnectionsRenderContext {
  readonly client: HttpClient;
  readonly profiles: readonly ConnectionProfile[];
  readonly selectedId: string | null;
  readonly route: Route;
  readonly writer: WriterSelection;
  readonly navigate: (route: Route) => void;
  readonly onProfilesChanged: () => void;
  readonly onDisconnect: () => void;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
}
export interface AppProps {
  readonly renderCommandSearch?: (
    context: CommandSearchContext,
    mode: "jump" | "search",
  ) => ReactNode;
  /** Root bootstrap owns reading the per-launch capability and creating this client. */
  readonly client: HttpClient;
  /** Feature packages supply real projections. An absent feature renders an explicit unavailable state. */
  readonly renderFeature?: (context: FeatureContext) => ReactNode;
  /** Dialog body, available before any connection or acting writer is selected. */
  readonly renderConnections?: (context: ConnectionsRenderContext) => ReactNode;
}
export interface NavigationItem {
  readonly id: ViewId;
  readonly label: string;
  readonly description: string;
  readonly icon:
    | "overview"
    | "work"
    | "workflow"
    | "discussions"
    | "participants"
    | "history"
    | "resources"
    | "saved"
    | "facts"
    | "activity"
    | "advanced";
}
