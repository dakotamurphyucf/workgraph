import type { ReactNode } from "react";
import type { FeatureContext } from "../../../app/types";
import type { HttpClient } from "../../../core/protocol/http";
import type { Decimal, Identifier } from "../../../core/protocol/types";
import type { ReadState } from "../../../core/state/read-slot";
import type { OperationController } from "../../../core/state/operations";
import type { WorkActionsController } from "../../work/actions";
import type {
  Capture,
  Page,
  Ticket,
  TicketRead,
  WorkActionContext,
  WorkController,
  WorkScope,
} from "../../work/read-model.types";

export type RelationKind = "prerequisite" | "inherited" | "hierarchy" | "related";
export type GraphFocus = "connected" | "neighbors" | "ancestors" | "downstream" | "subtree" | "all";
export type GraphGrouping = "project" | "milestone" | "none";
export interface ProposedRelation {
  readonly kind: Exclude<RelationKind, "inherited">;
  readonly from: Identifier | null;
  readonly to: Identifier | null;
}
/** Launch-retained unsent relationship sheet. Context and all endpoint choices are frozen at opening. */
export interface GraphRelationDraft {
  readonly id: string;
  readonly context: FeatureContext;
  readonly scope: WorkScope;
  readonly revision: Decimal;
  readonly tickets: readonly Capture<TicketRead>[];
  readonly captureId: string;
  readonly input: ProposedRelation;
}
export interface Waiver {
  readonly prerequisite_ticket_id: Identifier;
  readonly actor_id: Identifier;
  readonly reason: string;
  readonly timestamp: string;
}
export interface GraphRecord {
  readonly ticket: Ticket;
  readonly waivers: readonly Waiver[];
  readonly captureId: string;
  readonly revision: Decimal;
}
export interface HierarchyPolicy {
  readonly ticket_id: Identifier;
  readonly policy: {
    readonly ticket_id: Identifier;
    readonly revision: Decimal;
    readonly descendant_prerequisites: "independent" | "inherit";
    readonly child_completion: "all_done" | "done_or_canceled";
    readonly reason: string;
  } | null;
  readonly effective: {
    readonly descendant_prerequisites: "independent" | "inherit";
    readonly child_completion: "all_done" | "done_or_canceled";
  };
}
/** from -> to means prerequisite -> dependent, parent -> child, or canonical related endpoints. */
export interface GraphRelation {
  readonly id: string;
  readonly kind: RelationKind;
  readonly from: Identifier;
  readonly to: Identifier;
  /** Declaring ticket; inherited relations remain editable only here. */
  readonly source: Identifier;
  readonly waiver: Waiver | null;
  readonly captureId: string;
}
export interface GraphNode {
  readonly id: Identifier;
  /** Null is an explicit boundary reference, never an invented ticket record. */
  readonly record: GraphRecord | null;
  readonly inQuery: boolean;
}
export interface GraphProjection {
  readonly nodes: readonly GraphNode[];
  readonly relations: readonly GraphRelation[];
  readonly unknownAncestry: readonly Identifier[];
  readonly omittedRelations: number;
  readonly omittedBoundaryNodes: number;
  readonly asymmetricRelatedPairs: number;
}
export interface GraphPosition {
  readonly x: number;
  readonly y: number;
}
export interface GraphPositionBounds {
  readonly maxX: number;
  readonly maxY: number;
}
export interface GraphLayout {
  readonly positions: ReadonlyMap<Identifier, GraphPosition>;
  readonly lanes: readonly {
    readonly label: string;
    readonly y: number;
    readonly height: number;
  }[];
  readonly width: number;
  readonly height: number;
}
export interface GraphState {
  readonly scope: WorkScope | null;
  readonly queryKey: string | null;
  readonly revision: Decimal | null;
  /** Ordered pages from one query/revision only; explicit refresh replaces the capture. */
  readonly pages: readonly Capture<Page<Ticket>>[];
  readonly expanded: ReadonlyMap<Identifier, Capture<TicketRead>>;
  readonly policies: ReadonlyMap<Identifier, Capture<HierarchyPolicy>>;
  readonly referenceRead: ReadState<Capture<TicketRead>>;
  readonly policyRead: ReadState<Capture<HierarchyPolicy>>;
  readonly resolutionRead: ReadState<
    Capture<{ readonly ticket_id: Identifier; readonly display_key: string }>
  >;
  readonly projection: GraphProjection;
  readonly layers: Readonly<Record<RelationKind, boolean>>;
  readonly focus: GraphFocus;
  readonly grouping: GraphGrouping;
  readonly positions: ReadonlyMap<Identifier, GraphPosition>;
  readonly zoom: number;
  readonly ancestryLoading: boolean;
  readonly ancestryIssue: string | null;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
  readonly composer: GraphRelationDraft | null;
  readonly composerOpen: boolean;
}
export interface GraphController {
  readonly get: () => GraphState;
  readonly subscribe: (listener: () => void) => () => void;
  /** All presentation setters are local and never submit a native mutation. */
  readonly present: (patch: {
    readonly layers?: Partial<Readonly<Record<RelationKind, boolean>>>;
    readonly focus?: GraphFocus;
    readonly grouping?: GraphGrouping;
    readonly zoom?: number;
  }) => void;
  readonly move: (id: Identifier, position: GraphPosition) => void;
  readonly resetLayout: () => void;
  /** Expands one exact boundary ticket at the graph revision, not the current head. */
  readonly expand: (id: Identifier) => Promise<void>;
  /** Current-only native read; admit only its returned matching graph revision. */
  readonly policy: (id: Identifier) => Promise<void>;
  /** Follow every missing ancestor/policy, deduplicated within this capture, without a depth cap. */
  readonly loadAncestry: () => Promise<void>;
  /** Resolves a display key against the same endpoint/workspace/revision; stale completion returns null. */
  readonly resolve: (displayKey: string) => Promise<Identifier | null>;
  readonly compose: (context: FeatureContext, initial: Partial<ProposedRelation>) => void;
  readonly editComposer: (patch: Partial<ProposedRelation>) => void;
  readonly closeComposer: () => void;
  readonly hideComposer: () => void;
  readonly dispose: () => void;
}
export interface GraphControllerOptions {
  readonly http: HttpClient;
  /** Launch-owned shared Work selection/inspector; disposed by its own launch owner. */
  readonly readController: WorkController;
}
export interface GraphFeatureProps {
  /** Presentation navigation only; launch-owned evidence work remains retained. */
  readonly onOpenLocalEvidence?: () => void;
  readonly askTicket?: (target: WorkActionContext) => void;
  readonly onOpenPlans?: (view: "templates" | "drafts") => void;
  readonly context: FeatureContext;
  readonly controller: GraphController;
  readonly readController: WorkController;
  readonly actions: WorkActionsController;
  readonly operations: OperationController;
  readonly renderProgress?: (context: WorkActionContext) => ReactNode;
  readonly renderInspectorSections?: (context: WorkActionContext) => ReactNode;
}
