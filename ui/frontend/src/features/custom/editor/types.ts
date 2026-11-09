import type { LiveReadable } from "../../../core/state/live-types";
import type { ReactNode } from "react";
import type { FeatureContext } from "../../../app/types";
import type { JsonValue } from "../../../core/json";
import type { HttpClient, HttpResult, HttpFailure } from "../../../core/protocol/http";
import type {
  ConnectionProfile,
  Decimal,
  Digest,
  Identifier,
  ReadInvocation,
  ReadResponse,
} from "../../../core/protocol/types";
import type { CustomPageEnrichment, CustomSourceByteCoverage } from "./source";
import type { FormDraft } from "./forms/types";
import type { PersonalInventory } from "./settings";
import type { OperationController } from "../../../core/state/operations";
import type { ReadState } from "../../../core/state/read-slot";
import type {
  ConfigDecode,
  ConfigPublicationCapture,
  ConfigScope,
  ContentPin,
  LoadedRow,
  PreparedConfigPublication,
  RegisteredRenderer,
  RendererSubject,
  RendererConfig,
  ViewConfig,
  VerifiedConfig,
} from "../config";

/** Ordinary read selection. Existing mutation drafts retain their own target. */
export interface CustomTarget {
  readonly connection: ConnectionProfile;
  readonly workspaceId: Identifier;
}
export interface PersonalDocument {
  readonly id: Identifier;
  /** Exact UTF-8 source, including an unsupported version. Never activated implicitly. */
  readonly source: string;
}
/** Global private-store CAS revision is independent of native planning/resource revisions. */
export interface PersonalSettings {
  readonly target: CustomTarget;
  readonly revision: Decimal;
  readonly documents: readonly PersonalDocument[];
  readonly selectedId: Identifier | null;
}
/** Optional read-side names; never part of a private CAS or portable document. */
export interface PersonalLabelCapture {
  readonly settings: PersonalSettings;
  readonly status: "loading" | "complete" | "unavailable";
  readonly documents: readonly {
    readonly id: Identifier;
    readonly source: string;
    readonly title: string | null;
  }[];
}
export type SourceCapture =
  | { readonly kind: "planning"; readonly revision: Decimal }
  | {
      readonly kind: "runs";
      readonly revision: Decimal;
      readonly history: { readonly head: Digest | null; readonly sequence: Decimal } | null;
    }
  | { readonly kind: "communication"; readonly revision: Decimal }
  | { readonly kind: "history"; readonly head: Digest | null; readonly sequence: Decimal }
  | {
      readonly kind: "activity";
      readonly lineage: Digest;
      readonly after: Decimal;
      readonly afterChangeIndex: Decimal | null;
      readonly through: Decimal;
    };
export interface CustomPage {
  readonly target: CustomTarget;
  readonly view: ViewConfig;
  readonly invocation: ReadInvocation;
  readonly response: ReadResponse;
  readonly capture: SourceCapture;
  readonly rows: readonly LoadedRow[];
  /** Collection traversal and omitted fields are independent disclosures. */
  readonly complete: boolean;
  readonly partial: boolean;
  readonly next: ReadInvocation | null;
  readonly retry: ReadInvocation | null;
  readonly stop: string;
  readonly enrichment?: CustomPageEnrichment;
  readonly byteCoverage?: CustomSourceByteCoverage;
}
export type DocumentOrigin =
  | { readonly kind: "personal"; readonly id: Identifier }
  | { readonly kind: "shared"; readonly capture: VerifiedConfig }
  | { readonly kind: "new" };
export type ConfigurationDraft =
  | {
      readonly kind: "editing";
      readonly id: Identifier;
      readonly target: CustomTarget;
      readonly source: string;
      readonly form: FormDraft | null;
      readonly personalBase: PersonalSettings | null;
      readonly decoded:
        ConfigDecode | { readonly kind: "invalid_json"; readonly message: string } | null;
      readonly origin: DocumentOrigin;
      readonly mode: "form" | "raw";
      readonly busy: boolean;
      readonly message: string | null;
    }
  | {
      readonly kind: "captured";
      readonly id: Identifier;
      readonly prepared: PreparedConfigPublication;
    };
export interface ActiveConfiguration {
  readonly target: CustomTarget;
  readonly view: ViewConfig;
  readonly origin: DocumentOrigin;
}
/** Import has no endpoint authority. Each view must be explicitly mapped before saving. */
export interface ConfigurationImport {
  readonly documents: readonly {
    readonly id: Identifier;
    readonly source: string;
    readonly decoded: ConfigDecode;
    readonly mappedScope: ConfigScope | null;
  }[];
  readonly selectedId: Identifier | null;
}
export interface SharedCatalog {
  readonly scope: ConfigScope;
  readonly indexRevision: Decimal;
  readonly capture: VerifiedConfig;
  readonly renderers: readonly RegisteredRenderer[];
  /** Failed/unverified entries prevent an implicit unique-match claim. */
  readonly unavailable: readonly { readonly pin: ContentPin; readonly message: string }[];
}
export interface PersonalSavePlan {
  readonly target: CustomTarget;
  readonly expectedRevision: Decimal;
  readonly documents: readonly PersonalDocument[];
  readonly selectedId: Identifier | null;
}
export type PersonalSaveState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving"; readonly plan: PersonalSavePlan }
  | {
      readonly kind: "rejected";
      readonly plan: PersonalSavePlan;
      readonly failure: HttpFailure;
      readonly message: string;
    }
  | { readonly kind: "unknown"; readonly plan: PersonalSavePlan; readonly message: string }
  | {
      readonly kind: "conflict";
      readonly plan: PersonalSavePlan;
      readonly observed: PersonalSettings;
      readonly message: string;
    }
  | {
      readonly kind: "saved";
      readonly revision: Decimal;
      readonly confirmation: "acknowledged" | "desired_state_observed";
    };
export interface CustomState {
  readonly target: CustomTarget | null;
  readonly personal: ReadState<PersonalSettings>;
  readonly personalLabels: PersonalLabelCapture | null;
  readonly inventory: ReadState<PersonalInventory>;
  readonly shared: ReadState<SharedCatalog>;
  readonly personalSave: PersonalSaveState;
  readonly draft: ConfigurationDraft | null;
  readonly active: ActiveConfiguration | null;
  readonly page: ReadState<CustomPage>;
  readonly activation: ReadState<CustomPage>;
  readonly loaded: readonly LoadedRow[];
  readonly loadedCoverage: CustomPageEnrichment["rows"];
  readonly loadedLimitReached: boolean;
  readonly loadedPartial: boolean;
  readonly loadedPages: readonly CustomPage[];
  readonly imported: ConfigurationImport | null;
  readonly message: string | null;
  readonly unexpected: { readonly cause: unknown } | null;
}
export interface CustomController extends LiveReadable {
  readonly get: () => CustomState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly select: (context: FeatureContext) => void;
  readonly newView: (scope: ConfigScope) => void;
  readonly newRenderer: () => void;
  readonly editPersonal: (id: Identifier) => void;
  readonly editSource: (source: string) => void;
  readonly editForm: (form: FormDraft) => void;
  readonly editDocument: (document: ViewConfig | RendererConfig) => void;
  readonly setMode: (mode: "form" | "raw") => void;
  readonly activate: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly continue: (kind: "next" | "retry") => Promise<void>;
  /** Explicit private CAS write; unknown save retains original guards/source. */
  readonly savePersonal: () => Promise<void>;
  readonly inspectPersonal: () => Promise<void>;
  readonly inspectInventory: () => Promise<void>;
  readonly selectSavedTarget: (target: CustomTarget) => void;
  readonly retryPersonal: () => Promise<void>;
  /** Deliberate new local CAS after inspection, never automatic unknown-write retry. */
  readonly rebasePersonal: () => void;
  /** Explicitly discard a no-draft inspected intention; clear stale observations before fresh read, never write. */
  readonly discardPersonalSave: () => Promise<void>;
  /** Explicitly persists the preferred document; it never activates or loads it. */
  readonly setPersonalDefault: (id: Identifier | null) => Promise<void>;
  readonly removePersonal: (id: Identifier) => Promise<void>;
  readonly exportPersonal: () => Promise<Blob | null>;
  readonly importSource: (source: string) => Promise<void>;
  readonly mapImport: (index: number, scope: ConfigScope | null) => void;
  readonly adoptImport: () => Promise<void>;
  readonly loadShared: (scope: ConfigScope) => Promise<void>;
  readonly openShared: (id: Identifier) => Promise<void>;
  /** Capture includes independently observed resource/index guards, never current-writer substitution. */
  readonly prepareShared: (
    context: FeatureContext,
    input: {
      readonly documentResourceId: Identifier;
      readonly catalogResourceId: Identifier;
      readonly indexScope: ConfigScope;
      readonly link: ConfigPublicationCapture["link"];
    },
  ) => Promise<void>;
  readonly discardDraft: () => void;
  readonly dispose: () => void;
}
export interface CustomControllerOptions {
  readonly http: HttpClient;
  readonly operations: OperationController;
}
export interface CustomViewsFeatureProps {
  readonly context: FeatureContext;
  readonly controller: CustomController;
  readonly operations: OperationController;
}
/** Passive interpretation only; original host Source/Raw and attribution remain owned by the host. */
export interface CustomValuePresentationProps {
  readonly identity: string;
  readonly association: {
    readonly connectionId: Identifier;
    readonly generation: Decimal;
    readonly socket: string;
    readonly workspaceId: Identifier;
  };
  readonly subject: Omit<RendererSubject, "value">;
  readonly content:
    | { readonly kind: "value"; readonly value: JsonValue; readonly complete?: boolean }
    | {
        readonly kind: "bytes";
        readonly bytes: Uint8Array;
        readonly complete: boolean;
        readonly verified: boolean;
      };
  readonly controller: CustomController;
  readonly generic: ReactNode;
  readonly processing: HttpClient["processing"];
}
export interface CustomSourceAdapter {
  readonly initial: (
    target: CustomTarget,
    view: ViewConfig,
    signal: AbortSignal,
  ) => Promise<HttpResult<CustomPage>>;
  readonly next: (
    page: CustomPage,
    kind: "next" | "retry",
    signal: AbortSignal,
  ) => Promise<HttpResult<CustomPage>>;
}
/** Portable allowlist; no profile, socket, writer, capability, journal or receipt fields. */
export interface PortableSettings {
  readonly settings_version: 1;
  readonly documents: readonly PersonalDocument[];
  readonly selected_id: Identifier | null;
}
