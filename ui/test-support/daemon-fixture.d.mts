/** Bounded process observations only; never exports registry/state-root contents. */
export interface NativeProcessDiagnostics {
  readonly capturedAt: string;
  readonly startedAt: string;
  readonly disposeStartedAt: string | null;
  readonly exit: {
    readonly at: string;
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  } | null;
  /** At most 64 KiB of bytes per stream, decoded for human diagnostics only. */
  readonly stdoutTail: string;
  readonly stderrTail: string;
}
/** Test-only synthetic workspace, never an existing registry or user workspace. */
export interface DaemonFixture {
  readonly root: string;
  readonly socket: string;
  readonly binary: string;
  readonly pid: number;
  readonly workspace: "demo";
  readonly project: "release";
  readonly actor: "fixture-author";
  /** Complete raw JSON-RPC envelope. Arbitrary values must use the lossless decoder. */
  readonly call: (method: string, paramsJson: string) => Promise<string>;
  readonly diagnostics: () => NativeProcessDiagnostics;
  /** Idempotent; stops only the child this fixture spawned, then removes its private root. */
  readonly dispose: () => Promise<void>;
}
export interface DaemonFixtureOptions {
  /** Absolute current build/artifact path, never a shell command or PATH lookup. */
  readonly binary: string;
  /** Default true; false exposes a fresh empty daemon for administration tests. */
  readonly seed?: boolean;
  /** Bounded startup wait in milliseconds, default 10000. */
  readonly startupTimeoutMs?: number;
}
export function startDaemonFixture(options: DaemonFixtureOptions): Promise<DaemonFixture>;
/** Resolve an explicitly selected binary or the repository's actual current build. */
export function fixtureBinary(): string;
