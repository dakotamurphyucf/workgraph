/** Qualification data only; never a production method allowlist or authority. */
export type SurfaceKind = "method" | "helper" | "workflow" | "additional_local_surface";
export type Disposition = "tailored" | "advanced" | "native_helper" | "host" | "external";
export interface ResourcePin {
  readonly workspace: string;
  readonly resource: string;
  readonly version: string;
  readonly digest: string;
}
export interface SourceWitness {
  /** Repository-relative authored source, not generated assets or a guessed endpoint. */
  readonly path: string;
  readonly reason: string;
}
export interface CheckWitness {
  readonly name: string;
  readonly behavior: string;
  readonly paths: readonly string[];
  /** Exact implementation subset exercised by this check; all entry sources need a witness. */
  readonly coveredSources: readonly string[];
  /** Immutable accepted evidence may be reused only with explicit source applicability. */
  readonly evidence: readonly ResourcePin[];
  readonly applicability: string;
  /** Source bytes actually exercised by the cited proof, including relevant implementation. */
  readonly verifiedSources: readonly ArtifactPin[];
}
interface CoverageBase {
  readonly name: string;
  readonly disposition: readonly Disposition[];
  readonly userSurface: string;
  readonly source: readonly SourceWitness[];
  readonly positive: readonly CheckWitness[];
  readonly negative: readonly CheckWitness[];
  readonly primaryWorkflow: boolean;
  readonly limitations: readonly string[];
}
export type CoverageEntry = CoverageBase &
  (
    | { readonly kind: "method"; readonly mode: "read" | "mutation" | "write" }
    | { readonly kind: Exclude<SurfaceKind, "method">; readonly mode?: never }
  );
export interface ArtifactPin {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface AuditManifest {
  readonly format: "workgraph-ui-api-qualification-1";
  readonly sourceVersion: string;
  readonly apiVersion: string;
  readonly baseline: ResourcePin;
  readonly candidate: readonly ArtifactPin[];
  readonly source: readonly ArtifactPin[];
  readonly entries: readonly CoverageEntry[];
}
export interface Descriptor {
  readonly name: string;
  readonly mode: "read" | "mutation" | "write";
  readonly params: unknown;
  readonly result: unknown;
}
export interface AuditIssue {
  readonly entry: string;
  readonly kind: "missing" | "duplicate" | "unexpected" | "contract" | "source" | "evidence";
  readonly message: string;
}
