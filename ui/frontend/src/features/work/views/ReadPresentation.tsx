import { useEffect, useMemo, useState } from "react";
import { Badge, Button } from "../../../components/Primitives";
import { ContentViewer } from "../../../content";
import type { ContentSource } from "../../../content";
import { type JsonValue } from "../../../core/json";
import type { HttpClient } from "../../../core/protocol/http";
import { HTTP_LIMITS } from "../../../core/protocol/worker/jobs";
import type { ReadState } from "../../../core/state/read-slot";
import type { Capture, PageControl } from "../read-model.types";

export function ReadStatus<T>({
  state,
  label,
}: {
  readonly state: ReadState<T>;
  readonly label: string;
}) {
  if (state.kind === "unexpected_error") throw state.error;
  if (state.kind === "idle") return <p className="wg-hint">{label} has not been loaded.</p>;
  if (state.kind === "loading" && state.previous !== undefined) return null;
  if (state.kind === "loading")
    return (
      <p role="status" className="wg-hint">
        Loading {label.toLowerCase()}…
        {state.previous ? " Showing the previous capture until this read finishes." : ""}
      </p>
    );
  if (state.kind === "failed") {
    const failure = state.failure;
    const message =
      failure.kind === "aborted"
        ? "Read cancelled."
        : failure.kind === "remote"
          ? `${failure.problem.kind}: ${failure.problem.message}`
          : failure.message;
    return (
      <p role="alert" className="work-read-error">
        {label}: {message}
        {state.previous ? " Previous captured data remains visible; it is not a fresh result." : ""}
      </p>
    );
  }
  return null;
}
export function PageButtons({
  control,
  load,
  disabled = false,
  previous,
}: {
  readonly previous?: () => void;
  readonly control: PageControl | undefined;
  readonly load: (kind: "next" | "retry") => void;
  readonly disabled?: boolean;
}) {
  if (!control) return <p className="wg-hint">No validated continuation metadata is available.</p>;
  return (
    <div className="work-page-controls">
      {previous && (
        <Button disabled={disabled} onClick={previous}>
          Previous page
        </Button>
      )}
      <span className="wg-hint">
        {control.complete
          ? "Capture complete"
          : `Incomplete · ${control.stop.replaceAll("_", " ")}`}
      </span>
      {control.next && (
        <Button disabled={disabled} onClick={() => load("next")}>
          Next page
        </Button>
      )}
      {control.retry && (
        <Button disabled={disabled} onClick={() => load("retry")}>
          Retry this page
        </Button>
      )}
    </div>
  );
}
export function CaptureLabel({ capture }: { readonly capture: Capture<unknown> }) {
  return (
    <div className="work-capture">
      <span>
        Workspace revision <code>{capture.revision}</code>
      </span>
      {capture.partial && <Badge tone="warning">Partial capture</Badge>}
    </div>
  );
}
export function Prose({
  text,
  capture,
  label,
  partial = false,
}: {
  readonly text: string;
  readonly capture: string;
  readonly label: string;
  readonly partial?: boolean;
}) {
  const source = useMemo<ContentSource>(
    () => ({
      key: `${capture}:${label}`,
      label,
      bytes: new TextEncoder().encode(text),
      completeness: partial ? "partial" : "complete",
      hints: { intent: "prose" },
    }),
    [text, capture, label, partial],
  );
  return text.length === 0 ? (
    <p className="work-empty-prose">
      {partial ? "No text in this partial capture." : "Not provided."}
    </p>
  ) : (
    <ContentViewer source={source} chrome="reading" />
  );
}
export function RawValue({
  value,
  client,
  capture,
  label,
}: {
  readonly value: JsonValue;
  readonly client: HttpClient;
  readonly capture: string;
  readonly label: string;
}) {
  const [open, setOpen] = useState(false),
    [result, setResult] = useState<{
      readonly value: JsonValue;
      readonly source: ContentSource;
    } | null>(null),
    [failure, setFailure] = useState<{
      readonly value: JsonValue;
      readonly message: string;
    } | null>(null),
    [unexpected, setUnexpected] = useState<{
      readonly value: JsonValue;
      readonly error: unknown;
    } | null>(null);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void client.processing
      .encode(value, { signal: abort.signal, limits: HTTP_LIMITS })
      .then((outcome) => {
        if (abort.signal.aborted) return;
        if (!outcome.ok) {
          setFailure({ value, message: outcome.failure.message });
          return;
        }
        if (!outcome.value.ok) {
          setFailure({ value, message: outcome.value.error.message });
          return;
        }
        setResult({
          value,
          source: {
            key: `${capture}:raw-${crypto.randomUUID()}`,
            label,
            bytes: new TextEncoder().encode(outcome.value.value),
            completeness: "complete",
            hints: { language: "json" },
          },
        });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setUnexpected({ value, error });
      });
    return () => {
      abort.abort();
    };
  }, [value, client, open, capture, label]);
  if (unexpected?.value === value) throw unexpected.error;
  return (
    <div className="work-raw">
      <Button tone="quiet" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "Hide" : "Show"} {label}
      </Button>
      {open &&
        (result?.value === value ? (
          <ContentViewer source={result.source} />
        ) : failure?.value === value ? (
          <p role="alert">{failure.message}</p>
        ) : (
          <p role="status">Encoding captured source in worker…</p>
        ))}
    </div>
  );
}
