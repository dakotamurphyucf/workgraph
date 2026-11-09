import type { LiveReadable } from "../../../core/state/live-types";
import type { ReactNode } from "react";
import type { FeatureContext } from "../../../app/types";
import type { JsonValue } from "../../../core/json";
import type { HttpClient } from "../../../core/protocol/http";
import type {
  ConnectionProfile,
  Decimal,
  Identifier,
  Preparation,
  ReadResponse,
} from "../../../core/protocol/types";
import type { OperationController } from "../../../core/state/operations";
import type { ReadState } from "../../../core/state/read-slot";

/** Facts are explicitly scoped. A project never inherits workspace facts. */
export type FactScope =
  | { readonly kind: "workspace" }
  | { readonly kind: "project" | "milestone" | "ticket"; readonly id: Identifier };
export interface FactTarget {
  readonly connection: ConnectionProfile;
  readonly workspaceId: Identifier;
  readonly scope: FactScope;
}
export interface FactReference {
  readonly kind: "ticket" | "resource";
  readonly id: Identifier;
}
export type FactValueType = "null" | "boolean" | "number" | "string" | "array" | "object";
export interface FactMetadata {
  readonly scope: FactScope;
  readonly key: string;
  /** Per-key revision, independent of the planning snapshot revision. */
  readonly revision: Decimal;
  readonly actorId: Identifier;
  readonly runId: Identifier | null;
  readonly timestamp: string;
  readonly changedAtRevision: Decimal;
  readonly references: readonly FactReference[];
}
export type FactKey = FactMetadata &
  ({ readonly kind: "value"; readonly valueType: FactValueType } | { readonly kind: "deleted" });
export type FactVersion = FactMetadata &
  (
    | {
        readonly kind: "value";
        readonly valueType: FactValueType;
        readonly value: JsonValue;
        readonly canonicalBytes: number;
      }
    | { readonly kind: "deleted" }
  );
export type FactObservation =
  { readonly kind: "missing"; readonly scope: FactScope; readonly key: string } | FactVersion;
export interface FactPredicate {
  readonly pointer: string;
  readonly equals: JsonValue;
}
export interface FactQuery {
  readonly prefix: string;
  readonly includeDeleted: boolean;
  readonly predicates: readonly FactPredicate[];
}
export interface FactCapture<T> {
  readonly target: FactTarget;
  readonly value: T;
  readonly response: ReadResponse;
  readonly revision: Decimal;
  readonly partial: boolean;
}
export interface FactPage<T> {
  readonly items: readonly T[];
  readonly offset: Decimal;
  readonly nextOffset: Decimal | null;
  readonly remaining: Decimal;
}
/** Exact selected endpoint and explicit scope. Missing historical versions never fall back current. */
export type FactSelection = FactTarget &
  (
    | { readonly key: null; readonly atRevision?: never; readonly factRevision?: never }
    | { readonly key: string; readonly atRevision?: Decimal; readonly factRevision?: Decimal }
  );
export type FactReferencesInput =
  | { readonly kind: "preserve" }
  | {
      readonly kind: "replace";
      readonly items: readonly { readonly kind: "ticket" | "resource"; readonly id: string }[];
    };
export interface FactEditInput {
  readonly source: string;
  /** Retains an invalid structured edit without pretending the previous raw source changed. */
  readonly structured?: JsonValue;
  readonly references: FactReferencesInput;
}
export interface FactDraft {
  readonly id: Identifier;
  readonly target: FactTarget;
  readonly key: string;
  readonly writer: { readonly actorId: Identifier; readonly runId: Identifier | null };
  readonly base: FactCapture<FactObservation>;
  readonly input: FactEditInput;
  readonly method: "fact.put" | "fact.delete";
  readonly phase:
    | { readonly kind: "editing" }
    | { readonly kind: "validating" }
    | { readonly kind: "registered"; readonly preparation: Preparation };
  /** Conflict comparison does not change the original guard or preparation. */
  readonly current: FactCapture<FactObservation> | null;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface FactsState {
  readonly target: FactTarget | null;
  readonly historicalGeneration: boolean;
  readonly query: FactQuery;
  readonly keys: ReadState<FactCapture<FactPage<FactKey>>>;
  readonly keyPreviousOffsets: readonly Decimal[];
  readonly values: ReadState<FactCapture<FactPage<FactObservation>>>;
  readonly selectedKey: string | null;
  readonly detail: ReadState<FactCapture<FactObservation>>;
  readonly history: ReadState<FactCapture<FactPage<FactVersion>>>;
  /** Observed offsets preceding the visible history page, within its exact capture. */
  readonly historyPreviousOffsets: readonly Decimal[];
  readonly references: ReadState<FactCapture<FactPage<FactVersion>>>;
  readonly referenceQuery: FactReference | null;
  readonly referencePreviousOffsets: readonly Decimal[];
  readonly drafts: readonly FactDraft[];
  readonly selectedDraftId: Identifier | null;
  readonly issue: string | null;
  readonly unexpected: { readonly error: unknown } | null;
}
export interface FactsController extends LiveReadable {
  readonly get: () => FactsState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly select: (context: FeatureContext, selection?: FactSelection) => void;
  readonly changeScope: (scope: FactScope) => void;
  readonly query: (query: FactQuery) => void;
  /** Refresh the selected capture without silently replacing a historical pin. */
  readonly refresh: () => void;
  readonly nextKeys: () => void;
  readonly previousKeys: () => void;
  readonly inspect: (key: string) => void;
  /** Start a new history traversal for the selected fact. */
  readonly history: () => void;
  readonly nextHistory: () => void;
  readonly previousHistory: () => void;
  readonly references: (reference: FactReference, offset?: Decimal) => void;
  readonly nextReferences: () => void;
  readonly previousReferences: () => void;
  readonly open: (
    context: FeatureContext,
    key: string,
    method: "fact.put" | "fact.delete",
    restore?: FactVersion,
  ) => Promise<void>;
  readonly edit: (id: Identifier, input: FactEditInput) => void;
  readonly chooseDraft: (id: Identifier | null) => void;
  readonly discard: (id: Identifier) => void;
  readonly review: (id: Identifier) => Promise<void>;
  readonly compareCurrent: (id: Identifier) => Promise<void>;
  /** Explicitly create a new draft using current as base, retaining the local value. */
  readonly rebase: (id: Identifier) => void;
  readonly dispose: () => void;
}
export interface FactsOptions {
  readonly http: HttpClient;
  readonly operations: OperationController;
}
export interface FactsFeatureProps {
  /** Passive renderer receives the original exact observation; Source/Raw remain available. */
  readonly renderValue?: (capture: FactCapture<FactObservation>, generic: ReactNode) => ReactNode;
  readonly context: FeatureContext;
  readonly controller: FactsController;
  readonly operations: OperationController;
  readonly selection?: FactSelection;
  /** References name current entities; they do not claim an immutable resource publication. */
  readonly canOpenReference?: (target: FactTarget, reference: FactReference) => boolean;
  readonly openReference?: (target: FactTarget, reference: FactReference) => void;
}
