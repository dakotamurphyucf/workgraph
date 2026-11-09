/** Qualification evidence only; never renderer configuration or runtime policy. */
export type ContentLayer = "pure" | "native_companion" | "browser";
export type ContentFamily =
  | "lossless_json"
  | "worker_bounds"
  | "passive_text"
  | "verified_raster"
  | "immutable_bytes"
  | "exact_facts"
  | "config_renderers"
  | "reported_usage"
  | "native_security";
export interface SourcePin {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface Candidate {
  readonly companion: SourcePin;
  readonly core: SourcePin;
  readonly assets: SourcePin;
  readonly inlineRunner: SourcePin;
  readonly stateProcess: SourcePin;
}
export interface ContentControl {
  readonly id: string;
  readonly family: ContentFamily;
  readonly layer: ContentLayer;
  readonly paths: readonly string[];
  readonly behavior: string;
  /** Exact maintained test selection; a listed test is not proof of execution. */
  readonly selection: string | null;
}
export interface ContentRequirement {
  readonly id: string;
  readonly requirement: string;
  readonly controls: readonly string[];
}
export interface ContentMatrix {
  readonly format: "workgraph-ui-content-matrix-1";
  readonly inputs: readonly {
    readonly resource: string;
    readonly revision: string;
    readonly digest: string;
  }[];
  readonly controls: readonly ContentControl[];
  readonly requirements: readonly ContentRequirement[];
  /** Adjacent gates are disclosed, never counted as content controls passing. */
  readonly remainingGates: readonly {
    readonly ticket: string;
    readonly behavior: string;
  }[];
}
/** Reused proofs retain their original candidate and captured source inventory.
 * Current-candidate proofs also require exact artifact identity. */
export interface ContentProof {
  readonly id: string;
  readonly controlIds: readonly string[];
  readonly basis: "current_candidate" | "unchanged_sources";
  readonly sourceInventory: SourcePin;
  readonly sourcePaths: readonly string[];
  readonly artifacts: readonly SourcePin[];
  readonly evidence: readonly SourcePin[];
  readonly report:
    | {
        readonly kind: "vitest";
        readonly file: SourcePin;
        readonly cases: readonly string[];
      }
    | {
        readonly kind: "playwright";
        readonly file: SourcePin;
        readonly cases: readonly string[];
        readonly nativeCases: readonly string[];
        readonly componentCases: readonly string[];
      }
    | {
        readonly kind: "command_log";
        readonly file: SourcePin;
        readonly log: SourcePin;
        readonly cases: readonly string[];
        readonly passed: number;
      };
  /** Explain the exact behavior established and why changed host/native paths
   * are covered elsewhere. Hash equality alone never proves requirement scope. */
  readonly applicability: string;
}
export interface ContentManifest {
  readonly format: "workgraph-ui-content-qualification-1";
  readonly sourceRoot: string;
  readonly sourceInventory: SourcePin;
  readonly candidate: Candidate;
  readonly matrix: ContentMatrix;
  readonly proofs: readonly ContentProof[];
  readonly editor: {
    readonly ticket: "ui-v-editor";
    readonly generation: string;
    readonly manifest: { readonly id: string; readonly revision: string };
    readonly submission: SourcePin;
    readonly acceptance: SourcePin;
    readonly completion: SourcePin;
    readonly completionGate: SourcePin;
  };
}
export interface ContentAudit {
  readonly format: "workgraph-ui-content-audit-1";
  readonly manifest: SourcePin;
  readonly proofs: readonly {
    readonly id: string;
    readonly passed: boolean;
    readonly failures: readonly string[];
  }[];
  readonly editorAccepted: boolean;
  readonly missingControls: readonly string[];
  readonly failures: readonly string[];
  /** Evidence/hash/report validation, not independent semantic approval. Every
   * required control must be backed by passing source-applicable proof. */
  readonly readyForReview: boolean;
}
