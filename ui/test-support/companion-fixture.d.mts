import type { NativeProcessDiagnostics } from "./daemon-fixture.mjs";
/** Fixed launcher metadata only; never an arbitrary Workgraph JSON decoder. */
export interface CompanionReady {
  readonly format: "workgraph-ui-ready-1";
  readonly event: "ready";
  readonly url: string;
  readonly state_root: string;
  readonly asset_manifest_sha256: string;
  readonly api_prefix: "/ui-api/v1";
  readonly host: "127.0.0.1" | "::1";
  readonly port: string;
}

export interface CompanionFixture {
  readonly diagnostics: () => NativeProcessDiagnostics;
  readonly binary: string;
  /** Actual selected executable bytes, recorded independently of its path. */
  readonly binarySha256: string;
  readonly root: string;
  readonly pid: number;
  readonly ready: CompanionReady;
  readonly url: string;
  /** Idempotent; signal only the spawned child, verify exit, then remove its private root. */
  readonly dispose: () => Promise<void>;
}

export interface CompanionFixtureOptions {
  /** Absolute real compiled/installed executable, no shell or PATH lookup. */
  readonly binary: string;
  readonly host?: "127.0.0.1" | "::1";
  readonly startupTimeoutMs?: number;
  /** Optional qualification pin; mismatch fails before creating temporary state. */
  readonly expectedBinarySha256?: string;
  /** Checked against readiness; a mismatch stops the owned child and removes state. */
  readonly expectedManifestSha256?: string;
}

/** Decode bounded fixed metadata with exact keys, duplicate rejection and scalar UTF-8. */
export function decodeReady(bytes: Uint8Array, expectedRoot: string): CompanionReady;
/** Fresh private state only; never starts a daemon, opens a browser or loads user data. */
export function startCompanionFixture(options: CompanionFixtureOptions): Promise<CompanionFixture>;
export function companionBinary(): string;
