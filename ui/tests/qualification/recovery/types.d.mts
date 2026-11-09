/** Recovery qualification data, never runtime authorization or compatibility policy. */
export type Layer = "native_fault" | "native_socket" | "native_process" | "browser" | "pure";
export type Scope = "recovery_replay" | "other_final_gate";
export interface SourcePin {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface Control {
  readonly id: string;
  readonly layer: Layer;
  /** Maintained test source; a witness is not an executed success. */
  readonly paths: readonly string[];
  readonly behavior: string;
  readonly selection: string | null;
}
export interface Scenario {
  readonly id: string;
  readonly requirement: string;
  readonly scope: Scope;
  readonly controls: readonly string[];
  /** Explicitly retained companion gate, not a waiver or claim of passing evidence. */
  readonly otherGate: string | null;
  readonly limitation: string | null;
}
export interface RecoveryMatrix {
  readonly format: "workgraph-ui-recovery-matrix-1";
  readonly requirements: readonly {
    readonly resource: string;
    readonly version: string;
    readonly sha256: string;
  }[];
  readonly controls: readonly Control[];
  readonly scenarios: readonly Scenario[];
}
export interface CheckPlan {
  readonly id: string;
  readonly controlIds: readonly string[];
  /** Absolute executable and argv; no shell interpolation. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Fresh JSON report required for browser/node-side Playwright controls. */
  readonly playwright?: { readonly path: string; readonly cases: number };
}
export interface ResourcePin {
  readonly workspace: string;
  readonly resource: string;
  readonly version: string;
  readonly sha256: string;
}
export interface Observation {
  /** Exact CLI params and full actual response, retained alongside immutable resource pins. */
  readonly request: SourcePin;
  readonly response: SourcePin;
}
export interface AcceptedEditorProof {
  readonly state: "accepted";
  readonly ticket: "ui-v-editor";
  readonly generation: string;
  readonly manifest: { readonly id: string; readonly revision: string };
  readonly source: ResourcePin;
  readonly evidence: ResourcePin;
  readonly submission: Observation;
  readonly gate: Observation;
  readonly manifestObservation: Observation;
  /** Normalized complete accepted editor runtime input inventory; root verifies its
   * mapping to the pinned source output/archive. Each entry must match candidate sources. */
  readonly runtimeInventory: SourcePin;
}
export interface RunPlan {
  readonly format: "workgraph-ui-recovery-run-1";
  readonly candidate: readonly SourcePin[];
  /** Complete actual verification inputs, including declared test-only overlays. */
  readonly sources: readonly SourcePin[];
  readonly sourceRoot: string;
  readonly matrix: RecoveryMatrix;
  readonly checks: readonly CheckPlan[];
  readonly editor: { readonly state: "unqualified"; readonly reason: string } | AcceptedEditorProof;
}
export interface CheckResult {
  readonly id: string;
  readonly controls: readonly string[];
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly elapsedMs: number;
  readonly outcome: "passed" | "failed" | "timed_out" | "spawn_failed";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly log: SourcePin;
  readonly report: SourcePin | null;
  readonly verificationFailure: string | null;
}
export interface RecoveryRun {
  readonly format: "workgraph-ui-recovery-result-1";
  readonly plan: SourcePin;
  readonly candidate: readonly SourcePin[];
  readonly sources: readonly SourcePin[];
  readonly results: readonly CheckResult[];
  readonly unchanged: boolean;
  readonly editorAccepted: boolean;
  readonly editor: RunPlan["editor"];
  /** Never implied by merely listing controls or passing a subset. */
  readonly readyForReview: boolean;
}
