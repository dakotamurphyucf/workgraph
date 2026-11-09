/** Read-only progress, owned by the browser launch rather than a mounted view. */
export type ProgressDecision = "pending" | "complete" | "unknown" | "error";
export type ProgressStatus =
  | { readonly kind: "observing"; readonly attempts: number }
  | {
      readonly kind: "stopped";
      readonly reason:
        | "complete"
        | "unknown"
        | "error"
        | "deadline"
        | "attempt_limit"
        | "cancelled"
        | "disposed"
        | "busy";
      readonly attempts: number;
    };
export interface ProgressInspection {
  /** Must inspect one captured identity only; never execute, retry or recover. */
  readonly inspect: (signal: AbortSignal) => Promise<ProgressDecision>;
  readonly changed: (status: ProgressStatus) => void;
  /** Unexpected exceptions retain their identity for the owning error boundary. */
  readonly unexpected: (error: unknown) => void;
}
export interface ProgressObserver {
  /** Same-key starts coalesce; they cannot replace or extend the existing deadline. */
  readonly start: (key: string, inspection: ProgressInspection) => void;
  /** Cancels only the observation read. An admitted daemon write keeps running. */
  readonly stop: (key: string) => void;
  readonly dispose: () => void;
}

/** At most eight active identities, twelve reads and thirty seconds per explicit start. */
export function createProgressObserver(): ProgressObserver {
  interface Flight {
    readonly inspection: ProgressInspection;
    readonly controller: AbortController;
    attempts: number;
    timer: ReturnType<typeof setTimeout> | undefined;
    deadline: ReturnType<typeof setTimeout> | undefined;
  }
  const active = new Map<string, Flight>();
  const delays = [150, 300, 600, 1000, 1500, 2000] as const;
  let disposed = false;
  const finish = (
    key: string,
    flight: Flight,
    reason: Extract<ProgressStatus, { kind: "stopped" }>["reason"],
  ) => {
    if (active.get(key) !== flight) return;
    active.delete(key);
    clearTimeout(flight.timer);
    clearTimeout(flight.deadline);
    if (reason === "deadline" || reason === "cancelled" || reason === "disposed")
      flight.controller.abort();
    flight.inspection.changed({ kind: "stopped", reason, attempts: flight.attempts });
  };
  const schedule = (key: string, flight: Flight): void => {
    flight.timer = setTimeout(
      () => {
        if (active.get(key) !== flight) return;
        flight.attempts += 1;
        flight.inspection.changed({ kind: "observing", attempts: flight.attempts });
        void Promise.resolve()
          .then(() => {
            if (flight.controller.signal.aborted) return "unknown" as const;
            return flight.inspection.inspect(flight.controller.signal);
          })
          .then(
            (decision) => {
              if (active.get(key) !== flight) return;
              if (decision !== "pending") finish(key, flight, decision);
              else if (flight.attempts >= 12) finish(key, flight, "attempt_limit");
              else schedule(key, flight);
            },
            (error: unknown) => {
              if (active.get(key) !== flight) return;
              finish(key, flight, "error");
              flight.inspection.unexpected(error);
            },
          );
      },
      delays[Math.min(flight.attempts, delays.length - 1)],
    );
  };
  return {
    start: (key, inspection) => {
      if (active.has(key)) return;
      if (disposed || active.size >= 8) {
        inspection.changed({
          kind: "stopped",
          reason: disposed ? "disposed" : "busy",
          attempts: 0,
        });
        return;
      }
      const flight: Flight = {
        inspection,
        controller: new AbortController(),
        attempts: 0,
        timer: undefined,
        deadline: undefined,
      };
      active.set(key, flight);
      inspection.changed({ kind: "observing", attempts: 0 });
      flight.deadline = setTimeout(() => finish(key, flight, "deadline"), 30_000);
      schedule(key, flight);
    },
    stop: (key) => {
      const flight = active.get(key);
      if (flight !== undefined) finish(key, flight, "cancelled");
    },
    dispose: () => {
      disposed = true;
      for (const [key, flight] of active) finish(key, flight, "disposed");
    },
  };
}
