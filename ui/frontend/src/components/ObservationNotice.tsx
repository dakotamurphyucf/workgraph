import type { ProgressStatus } from "../core/state/progress-observer";

/** Render beside a still-pending saved identity, retaining its explicit Inspect control. */
export function ObservationNotice({
  status,
  subject = "saved action",
}: {
  readonly status: ProgressStatus | undefined;
  readonly subject?: string;
}) {
  let text: string;
  if (status?.kind === "observing")
    text = `Observing this ${subject} with read-only inspections. No request is being retried.`;
  else {
    const reason = status?.kind === "stopped" ? status.reason : undefined;
    switch (reason) {
      case "deadline":
        text = "The automatic observation time limit was reached.";
        break;
      case "attempt_limit":
        text = "The automatic inspection limit was reached.";
        break;
      case "busy":
        text = "Automatic observation capacity is full.";
        break;
      case "unknown":
        text = "The outcome remains uncertain; automatic observation stopped.";
        break;
      case "error":
        text = "Automatic observation stopped after an inspection error.";
        break;
      case "cancelled":
      case "disposed":
        text = "Automatic observation stopped.";
        break;
      case "complete":
      case undefined:
        text = "This saved request has not been observed completing.";
        break;
    }
    text += ` The last observed state is retained. Use Inspect to check this ${subject}; retry and recovery remain explicit.`;
  }
  return (
    <p role="status" className="wg-hint">
      {text}
    </p>
  );
}
