import { CapturedValues } from "./CapturedValues";
import { useManagementPresentation } from "./management-presentation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Badge, Button, Panel, Toolbar } from "../../components/Primitives";
import { ObservationNotice } from "../../components/ObservationNotice";
import { ContentViewer, type ContentSource } from "../../content";
import { type JsonValue } from "../../core/json";
import { preparationJson } from "../../core/protocol/client";
import { failureText } from "./failure";
import type { ProtocolProcessor } from "../../core/protocol/worker";
import type { Identifier, Operation, Preparation } from "../../core/protocol/types";
import type { ManagedAction, OperationController } from "../../core/state/operations";
import { destinationText, operationDestination } from "./operation-destination";

export function DestinationSummary({
  preparation,
  operation,
}: {
  readonly preparation: Preparation;
  readonly operation: Operation | null;
}) {
  return (
    <div>
      <p className="wg-hint">
        Destination: {destinationText(operationDestination(preparation, operation))}
      </p>
      <p className="wg-hint">
        Original endpoint: {operation?.connection.label ?? preparation.connection_id}
        {" · generation "}
        {preparation.generation}
      </p>
    </div>
  );
}

/** Collapsed passive observations do not occupy protocol/viewer worker capacity. */
export function LazyDetails({
  summary,
  children,
  onOpenChange,
}: {
  readonly summary: string;
  readonly children: ReactNode;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        onOpenChange?.(next);
      }}
    >
      <summary>{summary}</summary>
      {open && children}
    </details>
  );
}

export function JsonView({
  value,
  label,
  identity,
  partial = false,
  processing,
}: {
  readonly value: JsonValue;
  readonly label: string;
  readonly identity: string;
  readonly partial?: boolean;
  readonly processing: ProtocolProcessor;
}) {
  const [observed, setObserved] = useState<{
    readonly value: JsonValue;
    readonly identity: string;
    readonly source: ContentSource | null;
    readonly issue: string | null;
    readonly unexpected: { readonly error: unknown } | null;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void processing
      .encode(value, {
        signal: controller.signal,
        limits: {
          maxBytes: 16 * 1024 * 1024,
          maxDepth: 96,
          maxNodes: 400_000,
          maxStringBytes: 16 * 1024 * 1024,
        },
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.ok) {
          setObserved({
            value,
            identity,
            source: null,
            issue: result.failure.message,
            unexpected: null,
          });
          return;
        }
        if (!result.value.ok) {
          setObserved({
            value,
            identity,
            source: null,
            issue: result.value.error.message,
            unexpected: null,
          });
          return;
        }
        setObserved({
          value,
          identity,
          source: {
            key: identity,
            label,
            bytes: new TextEncoder().encode(result.value.value),
            completeness: partial ? "partial" : "complete",
            hints: { mime: "application/json", intent: "code" },
          },
          issue: null,
          unexpected: null,
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setObserved({ value, identity, source: null, issue: null, unexpected: { error } });
      });
    return () => controller.abort();
  }, [processing, value, label, identity, partial]);
  if (observed === null || observed.value !== value || observed.identity !== identity)
    return <p role="status">Preparing passive JSON view…</p>;
  if (observed.unexpected !== null) throw observed.unexpected.error;
  if (observed.source === null)
    return (
      <p role="alert" className="wg-error">
        {observed.issue}
      </p>
    );
  return <ContentViewer source={observed.source} chrome="compact" />;
}

export function OperationPanel({
  operations,
  intention,
  processing,
  applyLabel = "Execute saved request",
  resultActions,
}: {
  readonly operations: OperationController;
  readonly intention: Identifier;
  readonly processing: ProtocolProcessor;
  readonly applyLabel?: string;
  readonly resultActions?: ReactNode;
}) {
  const management = useManagementPresentation();
  const [hiddenIntention, setHiddenIntention] = useState<Identifier | null>(null);
  const [failure, setFailure] = useState("");
  const [unexpected, setUnexpected] = useState<{ readonly error: unknown } | null>(null);
  const entry = useSyncExternalStore(operations.subscribe, () => operations.get(intention));
  if (entry === undefined) return null;
  if (entry.phase.kind === "unexpected_error") throw entry.phase.error;
  const pending = entry.phase.kind === "pending";
  const operation = entry.operation;
  const act = (action: ManagedAction) => {
    setFailure("");
    void operations
      .act(intention, action)
      .then((result) => {
        if (!result.ok) setFailure(failureText(result.failure));
      })
      .catch((error: unknown) => {
        setUnexpected({ error });
      });
  };
  if (unexpected !== null) throw unexpected.error;
  if (management && hiddenIntention === intention)
    return (
      <Button onClick={() => setHiddenIntention(null)}>
        Show saved action review ·{" "}
        {(operation?.state.kind ?? entry.phase.kind).replaceAll("_", " ")}
      </Button>
    );
  const settled = operation?.state.kind === "committed" || operation?.state.kind === "observed";
  const controls = (
    <Toolbar label="Captured action controls">
      {operation === null ? (
        <Button disabled={pending} onClick={() => act("prepare")}>
          Validate & prepare same intention
        </Button>
      ) : (
        <>
          <Button disabled={pending} onClick={() => act("inspect")}>
            Inspect saved action
          </Button>
          {(operation.state.kind === "prepared_unsent" || operation.state.kind === "sending") && (
            <Button
              tone="primary"
              disabled={pending || operation.state.kind !== "prepared_unsent"}
              onClick={() => act("execute")}
            >
              {applyLabel}
            </Button>
          )}
          {operation.state.kind === "outcome_unknown" && (
            <Button
              disabled={pending || operation.state.kind !== "outcome_unknown"}
              onClick={() => act("retry")}
            >
              Retry exact saved request
            </Button>
          )}
          {operation.receipt_lookup_supported && (
            <Button
              disabled={pending || !operation.receipt_lookup_supported}
              onClick={() => act("recover")}
            >
              Recover receipt
            </Button>
          )}
        </>
      )}
    </Toolbar>
  );
  return (
    <Panel
      title="Review captured action"
      actions={
        <Toolbar label="Action review visibility">
          {management && <Button onClick={() => setHiddenIntention(intention)}>Hide review</Button>}
          <Badge tone={operation?.state.kind === "outcome_unknown" ? "warning" : "neutral"}>
            <span role="status" aria-live="polite" aria-atomic="true">
              {operation?.state.kind ?? entry.phase.kind}
            </span>
          </Badge>
        </Toolbar>
      }
    >
      <p>
        Original writer <strong>{entry.preparation.context.writer.actor_id}</strong>
        {operation?.state.kind === "prepared_unsent"
          ? " · Ready to apply"
          : operation?.state.kind === "committed"
            ? " · Saved"
            : operation?.state.kind === "observed"
              ? " · Result observed"
              : operation?.state.kind === "rejected"
                ? " · Not applied"
                : operation?.state.kind === "outcome_unknown"
                  ? " · Outcome unknown"
                  : operation?.state.kind === "sending"
                    ? " · Applying"
                    : ""}
      </p>
      <DestinationSummary preparation={entry.preparation} operation={operation} />
      {settled && resultActions}
      {entry.phase.kind === "unconfirmed" && (
        <p role="alert" className="wg-error">
          Unconfirmed observation: {failureText(entry.phase.failure)} Preserve this intention;
          inspect before an explicit retry.
        </p>
      )}
      {failure !== "" && (
        <p role="alert" className="wg-error">
          {failure}
        </p>
      )}
      {pending && <p role="status">{entry.phase.action} in progress…</p>}
      {operation?.state.kind === "sending" && <ObservationNotice status={entry.observation} />}
      {operation?.diagnostic && (
        <p role="alert">
          {operation.diagnostic.kind}: {operation.diagnostic.message}
        </p>
      )}
      {(operation?.state.kind === "rejected" || operation?.state.kind === "outcome_unknown") && (
        <p role="alert" className="wg-error">
          {operation.state.problem.kind}: {operation.state.problem.message}. A conflict requires a
          refreshed entity and a new reviewed draft; this saved request is unchanged.
        </p>
      )}
      {management && (
        <section aria-label="Changes to apply">
          <h3>Changes to apply</h3>
          <CapturedValues value={entry.preparation.params} />
        </section>
      )}
      {settled ? (
        <details>
          <summary>Inspect and receipt recovery</summary>
          {controls}
        </details>
      ) : (
        controls
      )}
      {!management &&
        (operation?.state.kind === "committed" || operation?.state.kind === "observed") && (
          <>
            <LazyDetails summary="Exact result JSON">
              <JsonView
                processing={processing}
                value={operation.state.response.data}
                label="Observed result"
                identity={`${operation.operation_id}-${operation.revision}`}
              />
            </LazyDetails>
          </>
        )}
      {!management && (
        <LazyDetails summary={`Exact captured ${operation === null ? "preparation" : "request"}`}>
          <p className="wg-hint">
            {entry.preparation.method} · connection {entry.preparation.connection_id}, generation{" "}
            {entry.preparation.generation}
            {" · "}Draft selection: workspace {entry.preparation.context.workspace_id ?? "none"},
            project {entry.preparation.context.project_id ?? "none"}
            {" · "}run {entry.preparation.context.writer.run_id ?? "none"}. Changing the current
            actor or scope does not change this action.
          </p>
          {operation !== null && (
            <p className="wg-hint">
              Original socket: <code>{operation.connection.socket}</code>.
            </p>
          )}
          {operation !== null && (
            <p className="wg-hint">
              Journal:{" "}
              <code>
                {operation.journal_path ?? "ephemeral operation; no durable daemon receipt"}
              </code>
              .
            </p>
          )}
          <JsonView
            processing={processing}
            value={operation?.request ?? preparationJson(entry.preparation)}
            label="Captured action JSON"
            identity={`${intention}-request`}
          />
        </LazyDetails>
      )}
    </Panel>
  );
}
