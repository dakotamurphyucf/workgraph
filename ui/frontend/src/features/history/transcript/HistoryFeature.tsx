import { conversationToolPairs, type ToolPair } from "./presentation";
import type { ProjectedItem } from "../formats";
import { prettyJson } from "./pretty-json";
import { SessionContext } from "./SessionContext";
import { SessionUsageOverview } from "./SessionUsageOverview";
import { transcriptContent } from "./content-lane";
import { ConversationBlock, HistoryText, ToolContent } from "./ConversationBlocks";
import { HistoryReferences } from "./HistoryReferences";
import { HistoryGuide } from "./HistoryGuide";
import { HISTORY_GUIDES } from "./guides";
import { ReferenceField } from "../../discussions/ReferenceFields";
import { FormSection } from "../../discussions/FormSection";
import { ManagementPresentation } from "../../connections/management-presentation";
import "../../../components/section-navigation.css";
import { Dialog } from "../../../components/Dialog";
import { Icon } from "../../../components/Icon";
import { ActorAvatar } from "../../../components/ActorAvatar";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { FeatureContext, Route } from "../../../app/types";
import { routeHref } from "../../../app/navigation";
import { Button, Field, Panel, Select, Toolbar } from "../../../components/Primitives";
import { ContentViewer, type ContentSource } from "../../../content";
import { eventJson } from "./event-json";
import type { OperationController } from "../../../core/state/operations";
import type { ReadState } from "../../../core/state/read-slot";
import { JsonView, LazyDetails, OperationPanel } from "../../connections/shared";
import { failureText } from "../../connections/failure";
import { FORMAT_ADAPTERS, type FormatSelection, type ProjectionResult } from "../formats";
import { historyNavigationTarget } from "./navigation-target";
import { current, decimal, partBlob, partKey } from "./controller";
import { duplicateReportedText, reportedDuplicates } from "./presentation";
import { FormatCoverageSummary } from "../formats/FormatCoverage";
import { formatCoverage } from "../formats/coverage";
import type {
  EventRecord,
  HistoryController,
  HistoryNavigationTarget,
  HistoryScope,
  HistoryState,
  PayloadPart,
} from "./types";
import "./history.css";
import "./history-polish.css";
// Like the generic viewer, the shared client has no live worker between jobs.
// One transcript lane prevents a 16-event mount from overflowing worker admission.

export interface HistoryFeatureProps {
  /** Passive interpretation of original captured bytes; no new reads or provider inference. */
  readonly renderPayload?: (
    capture: {
      readonly scope: HistoryScope;
      readonly source: ContentSource;
      readonly complete: boolean;
      readonly verified: boolean;
      readonly event: EventRecord;
      readonly part: PayloadPart;
      readonly head: string | null;
    },
    generic: ReactNode,
  ) => ReactNode;
  readonly context: FeatureContext;
  readonly controller: HistoryController;
  readonly operations: OperationController;
  /** Owning views resolve exact generation/version or show unavailable, never substitute current. */
  readonly onNavigateTarget?: (target: HistoryNavigationTarget) => void;
  /** Pure availability for the same exact target handled by onNavigateTarget.
   * Omitted preserves existing callback semantics. Unsupported targets remain selectable text. */
  readonly canNavigateTarget?: (target: HistoryNavigationTarget) => boolean;
  /** Search/usage child owns its own bounded state and may expand exact captured targets. */
  readonly renderSearch?: (selection: {
    readonly scope: HistoryScope;
    readonly sessionId: string | null;
    readonly head: string | null | undefined;
  }) => ReactNode;
}
function TargetControl({
  target,
  label,
  onNavigateTarget,
  canNavigateTarget,
}: {
  readonly target: HistoryNavigationTarget;
  readonly label: string;
  readonly onNavigateTarget: ((target: HistoryNavigationTarget) => void) | undefined;
  readonly canNavigateTarget: ((target: HistoryNavigationTarget) => boolean) | undefined;
}) {
  return onNavigateTarget && (canNavigateTarget?.(target) ?? true) ? (
    <Button onClick={() => onNavigateTarget(target)}>{label}</Button>
  ) : (
    <span className="ht-source">
      <code tabIndex={0}>{label}</code> · exact target navigation unavailable in this build
    </span>
  );
}
function ReadStatus<T>({ state, label }: { readonly state: ReadState<T>; readonly label: string }) {
  if (state.kind === "unexpected_error") throw state.error;
  if (state.kind === "loading" && state.previous === undefined)
    return (
      <p role="status">
        Loading {label}…{state.previous ? " Previous capture remains visible." : ""}
      </p>
    );
  if (state.kind === "failed")
    return (
      <p role="alert" className="wg-error">
        {label}: {failureText(state.failure)}
        {state.previous ? " Previous capture retained; it is not fresh." : ""}
      </p>
    );
  return null;
}
function observedTime(value: string | null) {
  if (value === null) return "Unknown";
  if (BigInt(value) > 8_640_000_000_000_000n) return "Outside calendar display range";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(Number(value)),
  );
}
function exactRoute(
  context: FeatureContext,
  state: HistoryState,
  sessionId: string,
  head: string | null,
  sequence?: string,
): Route {
  return {
    ...context.route,
    view: "history",
    entityId: sessionId,
    history: {
      generation: state.scope?.generation ?? context.connection.generation,
      head,
      ...(sequence === undefined ? {} : { sequence }),
    },
  };
}
function ExactLink({
  context,
  state,
  sessionId,
  head,
  sequence,
  children,
}: {
  readonly context: FeatureContext;
  readonly state: HistoryState;
  readonly sessionId: string;
  readonly head: string | null;
  readonly sequence?: string;
  readonly children: ReactNode;
}) {
  return <a href={routeHref(exactRoute(context, state, sessionId, head, sequence))}>{children}</a>;
}
function ProjectionView({
  value,
  identity,
  duplicateEvents,
  pairedTools,
  pairedResults,
  renderResult,
}: {
  readonly pairedTools?: ReadonlyMap<ProjectedItem, ToolPair>;
  readonly pairedResults?: ReadonlySet<ProjectedItem>;
  readonly renderResult?: (pair: ToolPair) => ReactNode;
  readonly duplicateEvents?: ReadonlyMap<number, string>;
  readonly value: ProjectionResult;
  readonly identity: string;
}) {
  if (value.status !== "recognized")
    return (
      <p className="wg-hint">
        Generic presentation ·{" "}
        {value.status === "ambiguous"
          ? "ambiguous matching formats; choose explicitly"
          : value.reason}
        . Raw events and bytes remain authoritative.
      </p>
    );
  const projection = value.projection,
    duplicates = duplicateReportedText(projection.items),
    visible = projection.items
      .map((item, index) => ({ item, index }))
      .filter(
        ({ index }) =>
          !duplicates.has(index) &&
          !duplicateEvents?.has(index) &&
          !pairedResults?.has(projection.items[index]!),
      );
  return (
    <section aria-label="Validated format projection">
      <div className="ht-conversation-blocks">
        {visible.map(({ item, index }) => (
          <ConversationBlock
            key={`${identity}/${index}`}
            item={item}
            {...(pairedTools?.has(item) && renderResult
              ? { pairedResult: renderResult(pairedTools.get(item)!) }
              : {})}
            index={index}
            identity={identity}
          />
        ))}
        {visible.length === 0 && !duplicates.size && !duplicateEvents?.size && (
          <p className="wg-hint">
            This record has no readable message blocks. Its original source is available below.
          </p>
        )}
      </div>
      {projection.reportedError && (
        <p>
          Source reported error: {String(projection.reportedError.value)} (separate from result
          subtype).
        </p>
      )}
      {projection.warnings
        .filter((w) => w.startsWith("Recorded on a side branch"))
        .map((warning, index) => (
          <p className="wg-hint" key={index}>
            {warning}
          </p>
        ))}
      {duplicateEvents && duplicateEvents.size > 0 && (
        <p>
          Same reported text as event {[...duplicateEvents.values()].join(", ")}; displayed once in
          Timeline. Both exact raw events remain available in All raw events.
        </p>
      )}
      {duplicates.size > 0 && (
        <p>
          Identical reported text displayed once; all {projection.items.length} source blocks remain
          in the original payload.
        </p>
      )}
    </section>
  );
}
function sourceTime(value: ProjectionResult | undefined): string {
  if (value?.status !== "recognized" || value.projection.sourceTime === null) return "";
  const time = value.projection.sourceTime.value;
  const milliseconds =
    time.format === "unix-seconds"
      ? Number(time.exact) * 1000
      : /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(time.exact)
        ? Date.parse(time.exact)
        : NaN;
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8640000000000000)
    return time.exact;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(milliseconds));
}
function PayloadView({
  raw,
  showSource,
  renderPayload,
  event,
  part,
  state,
  controller,
  duplicateEvents,
  pairedTools,
  pairedResults,
  renderResult,
}: {
  readonly pairedTools?: ReadonlyMap<ProjectedItem, ToolPair>;
  readonly pairedResults?: ReadonlySet<ProjectedItem>;
  readonly renderResult?: (pair: ToolPair) => ReactNode;
  readonly raw: boolean;
  readonly showSource: boolean;
  readonly renderPayload: HistoryFeatureProps["renderPayload"];
  readonly duplicateEvents?: ReadonlyMap<number, string>;
  readonly event: EventRecord;
  readonly part: PayloadPart;
  readonly state: HistoryState;
  readonly controller: HistoryController;
}) {
  const key = partKey(event.event_ref, part),
    payload = state.payloads.get(key),
    blob = partBlob(event, part),
    capture = current(state.window);
  const parsed = state.projections.get(partKey(event.event_ref, { kind: "payload" }))?.document;
  const formatted = useMemo(
    () => (part.kind === "payload" && parsed?.ok ? prettyJson(parsed.value.value) : null),
    [parsed, part.kind],
  );
  const source = useMemo<ContentSource | null>(
    () =>
      payload
        ? {
            key: `${state.scope?.connectionId}/${state.scope?.generation}/${state.scope?.workspaceId}/${key}/${payload.blob.digest}/${payload.blob.size_bytes}/${payload.nextOffset}`,
            label: `Event ${event.event_ref.sequence} ${part.kind}`,
            bytes: payload.bytes,
            completeness: payload.complete ? "complete" : "partial",
            hints: { intent: "prose" },
          }
        : null,
    [
      payload,
      state.scope?.connectionId,
      state.scope?.generation,
      state.scope?.workspaceId,
      key,
      event.event_ref.sequence,
      part.kind,
    ],
  );
  if (!blob) return <p>This part is not retained.</p>;
  const projected =
    part.kind === "payload" && !raw
      ? state.projections.get(partKey(event.event_ref, { kind: "payload" }))
      : undefined;
  return (
    <section className="ht-payload" aria-label={`Event ${event.event_ref.sequence} ${part.kind}`}>
      {(!payload?.complete || part.kind !== "payload") && (
        <p role="status" className="ht-payload-summary">
          {payload
            ? `${payload.bytes.length} bytes loaded · ${payload.complete ? (payload.verified ? "complete and verified" : "complete, not verified") : "partial prefix; more bytes retained"}`
            : "Payload not loaded."}
          {" · "}
          {projected?.status === "recognized" ? projected.adapter.label : "Generic"}
        </p>
      )}
      {part.kind === "payload" && projected?.status === "recognized" && (
        <ProjectionView
          key={`${key}/${state.format}`}
          value={projected}
          {...(pairedTools ? { pairedTools } : {})}
          {...(pairedResults ? { pairedResults } : {})}
          {...(renderResult ? { renderResult } : {})}
          {...(duplicateEvents === undefined ? {} : { duplicateEvents })}
          identity={source?.key ?? key}
        />
      )}
      {(showSource || raw || (projected !== undefined && projected.status !== "recognized")) && (
        <div className="ht-event-source">
          {source && !payload?.complete && !raw && !showSource && part.kind === "payload" ? (
            <p className="ht-payload-summary">
              This event exceeds the 16 MiB conversation preview. Download the complete event below,
              or open its source to inspect the loaded bytes. Partial JSON is not rendered as a
              conversation message.
            </p>
          ) : (
            source &&
            (() => {
              const generic = (
                <>
                  {formatted === null ? (
                    <ContentViewer client={transcriptContent} source={source} chrome="compact" />
                  ) : (
                    <>
                      <HistoryText
                        text={formatted}
                        identity={`${source.key}/formatted`}
                        label="Formatted event JSON"
                        hints={{ language: "json" }}
                      />
                      <LazyDetails summary="Original bytes and source controls">
                        <ContentViewer
                          client={transcriptContent}
                          source={source}
                          chrome="compact"
                        />
                      </LazyDetails>
                    </>
                  )}
                </>
              );
              return (raw || showSource || part.kind !== "payload") &&
                renderPayload !== undefined &&
                state.scope !== null &&
                capture !== undefined &&
                payload !== undefined
                ? renderPayload(
                    {
                      scope: state.scope,
                      source: { ...source, bytes: payload.bytes },
                      complete: payload.complete,
                      verified: payload.verified,
                      event,
                      part,
                      head: capture.capture.head,
                    },
                    generic,
                  )
                : generic;
            })()
          )}
          {part.kind === "payload" &&
            payload?.complete &&
            projected &&
            projected.status !== "recognized" && (
              <ProjectionView value={projected} identity={source?.key ?? key} />
            )}
          <details className="ht-source ht-payload-tools">
            <summary>Download and payload tools</summary>
            <Toolbar label="Payload retrieval">
              <Button
                disabled={state.expanding || payload?.complete}
                onClick={() => controller.expand(event, part)}
              >
                Load next byte chunk
              </Button>
              <Button
                disabled={
                  state.expanding || payload?.complete || Number(blob.size_bytes) > 16 * 1024 * 1024
                }
                onClick={() => controller.expand(event, part, true)}
              >
                Load complete preview ≤16MiB
              </Button>
              {state.expanding && (
                <Button onClick={controller.cancelExpansion}>Cancel payload read</Button>
              )}
              <Button
                disabled={state.transfer.kind === "loading"}
                onClick={() => controller.download(event, part)}
              >
                Download verified exact bytes
              </Button>
            </Toolbar>
          </details>
          <details className="ht-source">
            <summary>Exact payload identity and continuation</summary>
            <p>
              {blob.size_bytes} exact source bytes · SHA-256 <code>{blob.digest}</code>
            </p>
            {payload && !payload.complete && (
              <p>
                Next byte offset <code>{payload.nextOffset}</code>; an empty prefix at offset 0 is
                unfinished retrieval.
              </p>
            )}
          </details>
        </div>
      )}
    </section>
  );
}
function PairedToolResult({
  pair,
  state,
  controller,
  renderPayload,
}: {
  readonly pair: ToolPair;
  readonly state: HistoryState;
  readonly controller: HistoryController;
  readonly renderPayload: HistoryFeatureProps["renderPayload"];
}) {
  const [source, setSource] = useState(false);
  const sequence = pair.resultEvent.event_ref.sequence;
  const size = pair.resultEvent.event.payload.blob.size_bytes;
  return (
    <div className="ht-paired-result" data-result-event={sequence}>
      <div className="ht-paired-result-heading">
        <span className={pair.result.reportedError ? "is-error" : ""}>
          {pair.result.reportedError ? "Reported error" : "Recorded result"} · #{sequence} ·{" "}
          {BigInt(size).toLocaleString()} bytes
        </span>
        <Button
          tone="quiet"
          className="ht-json-button"
          aria-label={`Show JSON for result event ${sequence}`}
          aria-expanded={source}
          onClick={() => setSource(!source)}
        >
          {"{ }"}
        </Button>
      </div>
      <LazyDetails summary="Result · expand recorded output">
        <ToolContent
          value={pair.result.content}
          identity={`${pair.result.provenance.captureId}/${pair.result.provenance.path.join("/")}`}
        />
      </LazyDetails>
      {source && (
        <PayloadView
          raw
          showSource
          event={pair.resultEvent}
          part={{ kind: "payload" }}
          state={state}
          controller={controller}
          renderPayload={renderPayload}
        />
      )}
    </div>
  );
}
function EventCard({
  renderPayload,
  event,
  state,
  context,
  controller,
  open: focused,
  onOpen,
  raw,
  duplicateEvents,
  pairedTools,
  pairedResults,
  renderResult,
  onNavigateTarget,
  canNavigateTarget,
}: {
  readonly pairedTools?: ReadonlyMap<ProjectedItem, ToolPair>;
  readonly pairedResults?: ReadonlySet<ProjectedItem>;
  readonly renderResult?: (pair: ToolPair) => ReactNode;
  readonly renderPayload: HistoryFeatureProps["renderPayload"];
  readonly onNavigateTarget: ((target: HistoryNavigationTarget) => void) | undefined;
  readonly canNavigateTarget: ((target: HistoryNavigationTarget) => boolean) | undefined;
  readonly duplicateEvents?: ReadonlyMap<number, string>;
  readonly event: EventRecord;
  readonly state: HistoryState;
  readonly context: FeatureContext;
  readonly controller: HistoryController;
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly raw: boolean;
}) {
  const [part, setPart] = useState<PayloadPart>({ kind: "payload" });
  const [collapsed, setCollapsed] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const open = raw ? focused : !collapsed;
  const capture = current(state.window);
  if (!capture) return null;
  const value = event.event,
    key = partKey(event.event_ref, { kind: "payload" }),
    projection = state.projections.get(key);
  // New rows are published as a complete interpreted batch. Never mount a
  // generic/error-shaped placeholder just because a body is still being read.
  if (!projection || !state.payloads.has(key)) return null;
  if (
    !raw &&
    !showSource &&
    projection.status === "recognized" &&
    projection.projection.items.length > 0 &&
    projection.projection.items.every((item) => pairedResults?.has(item)) &&
    value.attachments.length === 0
  )
    return null;
  return (
    <article
      className={`ht-event ${open ? "ht-event-open" : ""}`}
      data-role={value.role}
      id={`history-event-${event.event_ref.sequence}`}
    >
      <header>
        <Button
          onClick={() => {
            if (!raw) setCollapsed(!collapsed);
            onOpen();
          }}
          aria-expanded={open}
        >
          <span className="ht-role-icon">
            <Icon
              name={
                value.role === "user"
                  ? "participants"
                  : value.role === "tool"
                    ? "advanced"
                    : "discussions"
              }
            />
          </span>
          <span className="ht-event-role">
            {projection?.status === "recognized" &&
            projection.projection.items.every((item) => item.kind !== "text")
              ? "Recorded activity"
              : value.role}
          </span>
          {raw && <span className="ht-event-kind">{value.kind}</span>}
          <span className="ht-seq">#{event.event_ref.sequence}</span>
        </Button>
        <time className="ht-source-time">{sourceTime(projection)}</time>
        <Button
          tone="quiet"
          className="ht-json-button"
          aria-label={`Show JSON for event ${event.event_ref.sequence}`}
          title="Original event JSON"
          aria-expanded={showSource}
          onClick={() => {
            setShowSource(!showSource);
            setCollapsed(false);
          }}
        >
          {"{ }"}
        </Button>
      </header>
      {!open && (
        <p className="ht-source">
          {value.payload.blob.size_bytes} source bytes ·{" "}
          {projection?.status === "recognized" ? projection.adapter.label : "Generic"} · source time{" "}
          {projection?.status === "recognized"
            ? (projection.projection.sourceTime?.value.exact ?? "unavailable")
            : "unavailable"}
        </p>
      )}
      {open && (
        <>
          {((raw && value.searchable_text) || value.attachments.length > 0) && (
            <details className="ht-source">
              <summary>Attachments and indexed text</summary>
              <Toolbar label="Retained event parts">
                <Button onClick={() => setPart({ kind: "payload" })}>Payload</Button>
                {value.searchable_text && (
                  <Button
                    onClick={() => {
                      setPart({ kind: "searchable_text" });
                      controller.expand(event, { kind: "searchable_text" });
                    }}
                  >
                    Searchable text
                  </Button>
                )}
                {value.attachments.map((attachment, index) => (
                  <Button
                    key={index}
                    onClick={() => {
                      const selected = {
                        kind: "attachment" as const,
                        index: decimal(String(index)),
                      };
                      setPart(selected);
                      controller.expand(event, selected);
                    }}
                  >
                    Attachment {index + 1} · {attachment.size_bytes}B
                  </Button>
                ))}
              </Toolbar>
            </details>
          )}
          <PayloadView
            raw={raw}
            {...(pairedTools ? { pairedTools } : {})}
            {...(pairedResults ? { pairedResults } : {})}
            {...(renderResult ? { renderResult } : {})}
            showSource={showSource}
            renderPayload={renderPayload}
            key={`${event.event_ref.sequence}/${part.kind}/${part.kind === "attachment" ? part.index : ""}`}
            event={event}
            part={part}
            {...(duplicateEvents === undefined ? {} : { duplicateEvents })}
            state={state}
            controller={controller}
          />
          {raw && (
            <details className="ht-source">
              <summary>Recorded attribution and correlation</summary>
              <p className="ht-source">
                Recorded actor {event.actor_id} · run {event.run_id ?? "none"} · client ID{" "}
                {value.client_id} · correlation {value.correlation ?? "none"}
              </p>
            </details>
          )}
          {raw && (
            <LazyDetails summary="Complete event metadata and provenance">
              <JsonView
                processing={context.client.processing}
                value={eventJson(event)}
                identity={`${capture.capture.head}/${key}/metadata`}
                label="Raw event metadata"
              />
            </LazyDetails>
          )}
          {value.resource_versions.length > 0 && (
            <div>
              <h4>Pinned resource references</h4>
              {value.resource_versions.map((resource, index) => (
                <p key={index}>
                  {state.scope && (
                    <TargetControl
                      target={historyNavigationTarget(state.scope, {
                        kind: "resource-version",
                        resourceId: resource.resource_id,
                        contentVersion: resource.revision,
                      })}
                      label={`Resource ${resource.resource_id} · immutable content version ${resource.revision}`}
                      onNavigateTarget={onNavigateTarget}
                      canNavigateTarget={canNavigateTarget}
                    />
                  )}
                  . Opening a current resource would not be this exact version.
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </article>
  );
}
function DraftView({
  state,
  controller,
  operations,
  context,
}: {
  readonly state: HistoryState;
  readonly controller: HistoryController;
  readonly operations: OperationController;
  readonly context: FeatureContext;
}) {
  const draft = state.draft;
  const entry = useSyncExternalStore(operations.subscribe, () =>
    draft?.preparation ? operations.get(draft.preparation.intention_id) : undefined,
  );
  if (!draft) return null;
  const frozen = draft.pending || draft.preparation !== null || draft.batchIndex > 0;
  return (
    <HistoryReferences context={context} target={draft.context}>
      <div>
        <div className="ht-writer">
          <ActorAvatar actor={draft.context.writer.actorId ?? "No actor"} />
          <div>
            <strong>Acting as {draft.context.writer.actorId ?? "No actor selected"}</strong>
            <span>
              Workspace {draft.context.route.workspaceId} · this draft keeps its original writer and
              destination.
            </span>
          </div>
        </div>
        <FormSection
          title={draft.kind === "create" ? "Name this history" : "Choose the history"}
          icon="history"
          description={
            draft.kind === "create"
              ? "A session is a collection of recorded events. Give it a stable ID and a title people can recognize. Saving creates the empty collection; an importer can then append events."
              : draft.kind === "import"
                ? "Select the existing session that should receive these events. Import adds to its history; it never replaces earlier events."
                : "Select the session to close permanently. Archiving prevents all future appends, preserves reading and search, and does not stop the originating agent."
          }
        >
          {draft.kind === "create" ? (
            <Field
              label="New session ID"
              value={draft.sessionId}
              disabled={frozen}
              hint="A stable unique identifier, such as release-review-01."
              onChange={(event) => controller.editDraft({ sessionId: event.target.value })}
            />
          ) : (
            <ReferenceField
              kind="session"
              label="Session"
              value={draft.sessionId}
              disabled={frozen}
              onChange={(value) => controller.editDraft({ sessionId: value })}
            />
          )}
          {draft.kind === "create" && (
            <Field
              label="Session title"
              value={draft.title}
              disabled={frozen}
              onChange={(event) => controller.editDraft({ title: event.target.value })}
            />
          )}
        </FormSection>
        {draft.kind === "archive" && (
          <p className="ht-warning">
            Archive permanently prevents future appends. History remains retrievable. There is no
            unarchive or delete operation.
          </p>
        )}
        {draft.kind === "import" && (
          <FormSection
            title="Supply recorded events"
            icon="resources"
            tone="violet"
            description="Each entry includes the original payload plus the role, event kind and a stable client ID. These IDs let the daemon recognize exact retries. This advanced importer accepts Workgraph event inputs, not a provider JSONL file directly."
          >
            <p>
              First create a session, then prepare the events using the Workgraph history API. Paste
              that event array below. A Claude Code or Codex JSONL file needs conversion before it
              can be imported here; selecting a display format does not convert a file.
            </p>
            <label className="ht-field">
              Exact event-input JSON
              <textarea
                aria-label="Exact event-input JSON"
                value={draft.source}
                disabled={frozen}
                onChange={(event) => controller.editDraft({ source: event.target.value })}
              />
            </label>
            <details className="ht-import-help">
              <summary>Import format and batch limits</summary>
              <p>
                Each event needs stable client_id, role, kind and phase fields, plus a payload using
                inline Base64 or an installed blob reference. Searchable text is optional and must
                be supplied explicitly.
              </p>
              <p>
                A plan accepts up to 1,024 events, divided into batches of at most 128 and 4 MiB per
                request. Review and apply each batch in order. If you stop midway, earlier saved
                batches remain in the session.
              </p>
            </details>
            {draft.batches.length > 0 && (
              <p>
                Import batch {draft.batchIndex + 1} of {draft.batches.length}. Earlier committed
                batches remain durable; no rollback is implied.
              </p>
            )}
          </FormSection>
        )}
        {draft.issue && (
          <p role="alert" className="wg-error">
            {draft.issue}
          </p>
        )}
        <Toolbar label="Saved history draft">
          <Button
            disabled={frozen || context.profileState !== "current"}
            onClick={() => {
              void controller.reviewDraft().catch(() => {
                /* Controller retains unexpected error for the React boundary. */
              });
            }}
          >
            Review session action
          </Button>
          <Button disabled={draft.pending} onClick={controller.discardDraft}>
            Discard unsaved draft
          </Button>
          {draft.kind === "import" && draft.batchIndex + 1 < draft.batches.length && (
            <Button
              disabled={entry?.operation?.state.kind !== "committed"}
              onClick={controller.nextImportBatch}
            >
              Review next import batch
            </Button>
          )}
        </Toolbar>
        {draft.preparation && (
          <OperationPanel
            applyLabel="Apply session action"
            operations={operations}
            intention={draft.preparation.intention_id}
            processing={context.client.processing}
          />
        )}
      </div>
    </HistoryReferences>
  );
}
function DownloadView({
  state,
  controller,
}: {
  readonly state: HistoryState;
  readonly controller: HistoryController;
}) {
  const transfer = state.transfer;
  const url = useMemo(
    () => (transfer.kind === "complete" ? URL.createObjectURL(transfer.blob) : null),
    [transfer],
  );
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  if (transfer.kind === "idle") return null;
  return (
    <Panel title="Exact byte download">
      {(transfer.kind === "loading" || transfer.kind === "complete") && (
        <details className="ht-source">
          <summary>Original download target</summary>
          <p>{transfer.origin}</p>
        </details>
      )}
      {transfer.kind === "loading" ? (
        <>
          <p role="status">
            {transfer.label} · {transfer.received}/{transfer.total} bytes. Verification pending.
          </p>
          <p>Large files may take several minutes. Downloads stop after five minutes.</p>
          <progress max={transfer.total || 1} value={transfer.received} />
          <Button onClick={controller.cancelDownload}>Cancel download</Button>
        </>
      ) : transfer.kind === "failed" ? (
        <p role="alert">{transfer.message}</p>
      ) : (
        <>
          <p role="status">
            Complete file verified · {transfer.blob.size} bytes · SHA-256{" "}
            <code>{transfer.digest}</code>
          </p>
          {url && (
            <a href={url} download={transfer.label}>
              Save verified {transfer.label}
            </a>
          )}
        </>
      )}
    </Panel>
  );
}
export function HistoryFeature({
  context,
  controller,
  operations,
  renderSearch,
  renderPayload,
  onNavigateTarget,
  canNavigateTarget,
}: HistoryFeatureProps) {
  const sessionScope = JSON.stringify([
    context.connection.id,
    context.connection.generation,
    context.route.workspaceId,
    context.route.entityId,
  ]);
  const timelineRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(false);
  const scrollIntent = useRef(false);
  const [viewScope, setViewScope] = useState(sessionScope);
  const state = useSyncExternalStore(controller.subscribe, controller.get),
    [selected, setSelected] = useState<string | null>(null),
    [raw, setRaw] = useState(false),
    [dialog, setDialog] = useState<"actions" | "filters" | null>(null),
    [sessionSearch, setSessionSearch] = useState(""),
    [archivedOnly, setArchivedOnly] = useState(false),
    [editorOpen, setEditorOpen] = useState(false);
  const tab = context.route.section?.view === "history" ? context.route.section.value : "sessions";
  const setTab = (value: "sessions" | "search" | "usage" | "summary") =>
    context.navigate({ ...context.route, section: { view: "history", value } });
  useEffect(() => {
    controller.select(context);
  }, [controller, context]);
  // Reset only session-local controls; preserve the directory DOM and scroll.
  if (viewScope !== sessionScope) {
    setViewScope(sessionScope);
    setSelected(null);
    setRaw(false);
  }
  if (state.unexpected !== null) throw state.unexpected.error;
  const directory = current(state.directory),
    detail = current(state.session),
    window = current(state.window),
    events = window
      ? [...window.data.items].sort((a, b) =>
          BigInt(a.event_ref.sequence) < BigInt(b.event_ref.sequence)
            ? -1
            : BigInt(a.event_ref.sequence) > BigInt(b.event_ref.sequence)
              ? 1
              : 0,
        )
      : [];
  useLayoutEffect(() => {
    followingRef.current = false;
    scrollIntent.current = false;
    if (timelineRef.current) timelineRef.current.scrollTop = 0;
  }, [sessionScope]);
  const hasWindow = window !== undefined;
  useEffect(() => {
    const node = messagesRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current && timelineRef.current)
        timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [sessionScope, hasWindow]);
  const overview = context.route.entityId === null;
  const visibleSessions =
    directory?.data.items.filter(
      (item) =>
        (!archivedOnly || item.archived) &&
        `${item.title} ${item.session_id} ${item.actor_id}`
          .toLowerCase()
          .includes(sessionSearch.toLowerCase()),
    ) ?? [];
  const showDirectory = () => {
    const route: Route = {
      ...context.route,
      entityId: null,
      section: { view: "history", value: "sessions" },
    };
    const next = { ...route };
    delete next.history;
    context.navigate(next);
  };
  const opened =
      events.find((event) => event.event_ref.sequence === selected) ??
      events.find((event) => event.event_ref.sequence === context.route.history?.sequence),
    duplicates = reportedDuplicates(events, state.projections);
  const pairing = (() => {
    const pairs = conversationToolPairs(events, state.projections).filter(
      (pair) => pair.resultEvent.event_ref.sequence !== context.route.history?.sequence,
    );
    return {
      calls: new Map(pairs.map((pair) => [pair.call, pair])),
      results: new Set(pairs.map((pair) => pair.result)),
    };
  })();
  return (
    <ManagementPresentation.Provider value={true}>
      <HistoryReferences context={context}>
        <section className="ht-root" aria-label="Recorded history">
          <header className="ht-topbar wg-section-navigation">
            <h1>
              <Icon name="history" />
              History
            </h1>
            <Toolbar label="History views">
              {(
                [
                  ["sessions", "Sessions"],
                  ["search", "Search"],
                  ["usage", "Usage reports"],
                  ["summary", "Session summary"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  tone="quiet"
                  aria-pressed={tab === value}
                  onClick={() => setTab(value)}
                >
                  <Icon
                    name={
                      value === "sessions"
                        ? "history"
                        : value === "search"
                          ? "search"
                          : value === "usage"
                            ? "activity"
                            : "list"
                    }
                  />
                  {label}
                </Button>
              ))}
            </Toolbar>
            <div className="ht-topbar-actions">
              <Button tone="quiet" onClick={() => setDialog("actions")}>
                Session actions
              </Button>
              <Button
                tone="quiet"
                aria-label="Refresh current history capture"
                onClick={controller.refresh}
              >
                <Icon name="refresh" />
              </Button>
            </div>
          </header>
          {(overview || tab !== "sessions") && <HistoryGuide {...HISTORY_GUIDES[tab]} />}
          {state.historicalGeneration && (
            <p className="ht-warning">
              Viewing retained connection generation {state.scope?.generation}; global connection
              selection is unchanged. This link starts no mutation.
            </p>
          )}
          {dialog === "actions" && (
            <Dialog
              title="Session actions"
              wide
              description="Create or import recorded history at the current connection. Actions use your selected actor and keep their captured target."
              onClose={() => setDialog(null)}
            >
              {!context.writer.actorId && (
                <p className="ht-action-note">
                  <Icon name="participants" /> Creating, importing or archiving history needs an
                  actor. Choose an action below to select who you are working as.
                </p>
              )}
              {state.draft && (
                <p className="ht-action-note">
                  An unfinished action is already open. Close this menu and resume it, or discard
                  that draft before starting another.
                </p>
              )}
              {!detail && (
                <p className="wg-hint">
                  To archive a session, open it from the directory first. Archived history stays
                  readable and searchable.
                </p>
              )}
              <div className="ht-action-grid" aria-label="History actions">
                <Button
                  requiresActor
                  disabled={state.draft !== null || context.profileState !== "current"}
                  onClick={() => {
                    controller.newDraft(context, "create");
                    setDialog(null);
                    setEditorOpen(true);
                  }}
                >
                  <Icon name="plus" />
                  <strong>New session</strong>
                  <span>
                    Create an empty history collection. This does not launch an agent or record
                    anything automatically.
                  </span>
                </Button>
                <Button
                  requiresActor
                  disabled={
                    state.draft !== null ||
                    context.profileState !== "current" ||
                    state.historicalGeneration ||
                    detail?.data.session.archived === true
                  }
                  onClick={() => {
                    controller.newDraft(context, "import", detail?.data.session.session_id);
                    setDialog(null);
                    setEditorOpen(true);
                  }}
                >
                  <Icon name="resources" />
                  <strong>Import events</strong>
                  <span>
                    Append recorded events to an existing open session. Prepare and review the
                    import before saving.
                  </span>
                </Button>
                {detail && (
                  <Button
                    requiresActor
                    disabled={
                      state.draft !== null ||
                      detail.data.session.archived ||
                      state.historicalGeneration ||
                      context.profileState !== "current"
                    }
                    onClick={() => {
                      controller.newDraft(context, "archive", detail.data.session.session_id);
                      setDialog(null);
                      setEditorOpen(true);
                    }}
                  >
                    <Icon name="archive" />
                    <strong>Archive session</strong>
                    <span>
                      Permanently close this session to new events. Everything already recorded
                      remains readable.
                    </span>
                  </Button>
                )}
              </div>
            </Dialog>
          )}

          {state.draft && !editorOpen && (
            <div className="ht-retained-editor">
              <Icon name="resources" />
              <span>
                Unfinished{" "}
                {state.draft.kind === "create"
                  ? "new session"
                  : state.draft.kind === "import"
                    ? "event import"
                    : "archive"}{" "}
                action
              </span>
              <Button onClick={() => setEditorOpen(true)}>Resume session action</Button>
            </div>
          )}
          {state.draft && editorOpen && (
            <Dialog
              title={
                state.draft.kind === "create"
                  ? "Create a history session"
                  : state.draft.kind === "import"
                    ? "Import recorded events"
                    : "Archive this session"
              }
              wide
              onClose={() => setEditorOpen(false)}
            >
              <div className="ht-editor">
                <DraftView
                  state={state}
                  controller={controller}
                  operations={operations}
                  context={context}
                />
              </div>
            </Dialog>
          )}
          <DownloadView state={state} controller={controller} />
          {state.scope === null ? (
            <p>Select a workspace to read its history. No actor is required for reads.</p>
          ) : (
            <>
              {tab !== "sessions" && (
                <div className="ht-analytics">
                  {" "}
                  {renderSearch?.({
                    scope: state.scope,
                    sessionId: detail?.data.session.session_id ?? null,
                    head: detail?.capture.head,
                  })}
                </div>
              )}
              {tab === "sessions" && (
                <div className={`ht-layout${overview ? " ht-layout-overview" : ""}`}>
                  <aside>
                    <Panel title={overview ? "Sessions" : "Session directory"}>
                      <p className="ht-directory-intro">
                        {overview
                          ? "Explore recorded conversations, tool traces, and other event histories."
                          : "All workspace sessions"}
                      </p>
                      {overview && directory && (
                        <div className="ht-overview-metrics" aria-label="Loaded session page">
                          <div>
                            <span>Sessions in this page</span>
                            <strong>{directory.data.items.length}</strong>
                            <small>
                              {directory.data.has_more
                                ? "More pages available"
                                : "End of captured directory"}
                            </small>
                          </div>
                          <div>
                            <span>Open in this page</span>
                            <strong>
                              {directory.data.items.filter((item) => !item.archived).length}
                            </strong>
                            <small>Accepts new events</small>
                          </div>
                          <div>
                            <span>Archived in this page</span>
                            <strong>
                              {state.query.includeArchived
                                ? directory.data.items.filter((item) => item.archived).length
                                : "—"}
                            </strong>
                            <small>
                              {state.query.includeArchived
                                ? "Retained for reading"
                                : "Excluded by Open filter"}
                            </small>
                          </div>
                        </div>
                      )}
                      {overview && directory && (
                        <SessionUsageOverview
                          key={JSON.stringify(state.scope)}
                          context={context}
                          directory={directory}
                          onOpenSession={(id) => controller.open(id)}
                          onOpenUsage={() => setTab("usage")}
                        />
                      )}
                      <div className="ht-directory-navigation">
                        <Toolbar label="Session lifecycle">
                          <Button
                            tone="quiet"
                            aria-pressed={!state.query.includeArchived}
                            onClick={() => {
                              setArchivedOnly(false);
                              controller.directory({ ...state.query, includeArchived: false });
                            }}
                          >
                            Open
                          </Button>
                          <Button
                            tone="quiet"
                            aria-pressed={state.query.includeArchived && archivedOnly}
                            onClick={() => {
                              setArchivedOnly(true);
                              controller.directory({ ...state.query, includeArchived: true });
                            }}
                          >
                            Archived
                          </Button>
                          <Button
                            tone="quiet"
                            aria-pressed={state.query.includeArchived && !archivedOnly}
                            onClick={() => {
                              setArchivedOnly(false);
                              controller.directory({ ...state.query, includeArchived: true });
                            }}
                          >
                            All sessions
                          </Button>
                        </Toolbar>
                        <p className="ht-lifecycle-help">
                          Open means events can be appended, not that an agent is running. Archived
                          history stays readable.
                        </p>
                        <div className="ht-directory-controls">
                          <Field
                            label="Find in loaded sessions"
                            placeholder="Find title, actor, or ID…"
                            value={sessionSearch}
                            onChange={(event) => setSessionSearch(event.currentTarget.value)}
                          />
                          <Button
                            tone="quiet"
                            aria-label="Filter sessions"
                            onClick={() => setDialog("filters")}
                          >
                            <Icon name="filter" />
                          </Button>
                        </div>
                      </div>
                      {dialog === "filters" && (
                        <Dialog
                          title="Filter sessions"
                          wide
                          description="Choose the directory order and exact run scope. Search in the sidebar filters the loaded page only."
                          onClose={() => setDialog(null)}
                        >
                          <div className="ht-directory-filters">
                            {" "}
                            <Select
                              label="Session order"
                              value={state.query.order}
                              onChange={(event) =>
                                controller.directory({
                                  ...state.query,
                                  order:
                                    event.target.value === "created_at"
                                      ? "created_at"
                                      : event.target.value === "session_id"
                                        ? "session_id"
                                        : "last_event_at",
                                })
                              }
                            >
                              <option value="last_event_at">Recent activity</option>
                              <option value="created_at">Recently created</option>
                              <option value="session_id">Session ID</option>
                            </Select>
                            <ReferenceField
                              kind="run"
                              label="Originating run"
                              value={state.query.runId}
                              onChange={(value) =>
                                controller.directory({ ...state.query, runId: value })
                              }
                            />
                          </div>
                        </Dialog>
                      )}

                      <ReadStatus state={state.directory} label="session directory" />
                      {directory && (
                        <>
                          {archivedOnly && (
                            <p className="ht-page-note">
                              Archived entries in this loaded page of all sessions.{" "}
                              {directory.data.has_more
                                ? "Continue to the next page to check more entries."
                                : "End of captured directory."}
                            </p>
                          )}
                          {visibleSessions.length === 0 && (
                            <p className="ht-page-note">
                              No matching sessions in this page.{" "}
                              {directory.data.has_more
                                ? "More sessions are available on the next page."
                                : ""}
                            </p>
                          )}
                          {overview && (
                            <div className="ht-session-columns" aria-hidden="true">
                              <span>Session</span>
                              <span>State</span>
                              <span>Recorded actor</span>
                              <span>Events</span>
                              <span>Last event received</span>
                            </div>
                          )}
                          <ul className="ht-directory">
                            {visibleSessions.map((item) => (
                              <li key={item.session_id}>
                                <button
                                  className="ht-session-row"
                                  onClick={() => controller.open(item.session_id)}
                                  aria-pressed={item.session_id === detail?.data.session.session_id}
                                >
                                  <span className="ht-session-icon">
                                    <Icon name="history" />
                                  </span>
                                  <span className="ht-session-row-body">
                                    <strong>{item.title}</strong>
                                    <span className="ht-session-id">
                                      {item.scopes
                                        .map((scope) =>
                                          scope.kind === "workspace"
                                            ? "Workspace"
                                            : `${scope.kind}: ${scope.id}`,
                                        )
                                        .join(" · ") || "No planning scope"}
                                    </span>
                                    <span className="ht-session-id" title={item.session_id}>
                                      {item.session_id}
                                    </span>
                                  </span>
                                  <span
                                    className={`ht-lifecycle ${item.archived ? "is-archived" : "is-open"}`}
                                  >
                                    <span />
                                    {item.archived ? "Archived" : "Open"}
                                  </span>
                                  {!overview && (
                                    <span className="ht-sidebar-session-meta">
                                      <ActorAvatar actor={item.actor_id} />
                                      <span>{item.actor_id}</span>
                                      <time>{observedTime(item.last_event_at_unix_ms)}</time>
                                    </span>
                                  )}
                                  {overview && (
                                    <>
                                      <span className="ht-row-actor">
                                        <ActorAvatar actor={item.actor_id} />
                                        <span>{item.actor_id}</span>
                                      </span>
                                      <span className="ht-row-events">
                                        {directory.capture.sessions.find(
                                          (bound) => bound.session_id === item.session_id,
                                        )?.through ?? "Unknown"}
                                      </span>
                                      <span
                                        className="ht-row-time"
                                        title={`Created ${observedTime(item.created_at_unix_ms)}`}
                                      >
                                        {observedTime(item.last_event_at_unix_ms)}
                                      </span>
                                    </>
                                  )}
                                </button>
                              </li>
                            ))}
                          </ul>
                          {directory.data.has_more && (
                            <Button
                              disabled={state.directory.kind === "loading"}
                              onClick={() => controller.directory(state.query, true)}
                            >
                              Load more sessions
                            </Button>
                          )}
                        </>
                      )}
                    </Panel>
                  </aside>
                  <section
                    className="ht-timeline"
                    aria-label="Session timeline"
                    ref={timelineRef}
                    onScroll={(event) => {
                      const node = event.currentTarget;
                      const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
                      const allLoaded =
                        !!window &&
                        (events.at(-1)?.event_ref.sequence ?? "0") === window.data.through;
                      if (!atBottom || !allLoaded) {
                        followingRef.current = false;
                        controller.pauseFollowing();
                      } else if (
                        scrollIntent.current &&
                        !state.loadingMore &&
                        !state.readingEvents &&
                        !context.route.history
                      ) {
                        followingRef.current = true;
                        controller.setFollowing(true);
                      }
                    }}
                    onClickCapture={(event) => {
                      if (
                        event.target instanceof Element &&
                        event.target.closest("button,summary,input,select,a")
                      ) {
                        scrollIntent.current = false;
                        followingRef.current = false;
                        controller.pauseFollowing();
                      }
                    }}
                    onPointerDown={(event) => {
                      if (event.target === event.currentTarget) scrollIntent.current = true;
                    }}
                    onWheel={(event) => {
                      scrollIntent.current = event.deltaY > 0;
                      if (event.deltaY < 0) {
                        followingRef.current = false;
                        controller.pauseFollowing();
                      }
                    }}
                    onTouchMove={() => {
                      scrollIntent.current = true;
                    }}
                    onKeyDown={(event) => {
                      if (["End", "PageDown", "ArrowDown"].includes(event.key))
                        scrollIntent.current = true;
                      if (["Home", "PageUp", "ArrowUp"].includes(event.key)) {
                        scrollIntent.current = false;
                        followingRef.current = false;
                        controller.pauseFollowing();
                      }
                    }}
                    tabIndex={0}
                  >
                    {detail && (
                      <header className="ht-session-heading">
                        <Button tone="quiet" onClick={showDirectory}>
                          ← All sessions
                        </Button>
                        <span className="ht-session-kicker">Recorded history</span>
                        <h2>{detail.data.session.title}</h2>
                        <div>
                          <ActorAvatar actor={detail.data.session.actor_id} />
                          <span>{detail.data.session.actor_id}</span>
                          <span className="ht-session-separator">·</span>
                          <span>{detail.data.through} events</span>
                          <span
                            className={`ht-lifecycle ${detail.data.session.archived ? "is-archived" : "is-open"}`}
                          >
                            <span />
                            {detail.data.session.archived ? "Archived" : "Open"}
                          </span>
                        </div>
                      </header>
                    )}
                    {detail && state.scope && (
                      <SessionContext
                        context={context}
                        detail={detail}
                        scope={state.scope}
                        onNavigateTarget={onNavigateTarget}
                        canNavigateTarget={canNavigateTarget}
                      />
                    )}
                    {detail && (
                      <>
                        <details className="ht-session-about">
                          <summary>
                            <Icon name="history" /> About this session · dates, linked work and
                            lifecycle
                          </summary>
                          <div
                            className={`ht-lifecycle-banner ${detail.data.session.archived ? "is-archived" : "is-open"}`}
                          >
                            <Icon name={detail.data.session.archived ? "archive" : "history"} />
                            <div>
                              <strong>
                                {detail.data.session.archived
                                  ? "Archived history"
                                  : context.route.history
                                    ? "Open at this saved capture"
                                    : "Open for new events"}
                              </strong>
                              {context.route.history && (
                                <p>
                                  This is a pinned history snapshot. Refresh current history to
                                  inspect the latest session state.
                                </p>
                              )}
                              <p>
                                {detail.data.session.archived
                                  ? "Events and payloads are preserved. This session no longer accepts appends; the API has no reopen or delete action."
                                  : "An importer can append more events. This state does not indicate whether the originating agent or process is running."}
                              </p>
                            </div>
                          </div>
                          <ExactLink
                            context={context}
                            state={state}
                            sessionId={detail.data.session.session_id}
                            head={detail.capture.head}
                          >
                            Link to this saved session capture
                          </ExactLink>
                          <dl className="ht-session-facts">
                            <div>
                              <dt>Created</dt>
                              <dd>{observedTime(detail.data.session.created_at_unix_ms)}</dd>
                            </div>
                            <div>
                              <dt>Last event received</dt>
                              <dd>{observedTime(detail.data.session.last_event_at_unix_ms)}</dd>
                            </div>
                            <div>
                              <dt>Originating run</dt>
                              <dd>
                                {detail.data.session.run_id && state.scope ? (
                                  <TargetControl
                                    target={historyNavigationTarget(state.scope, {
                                      kind: "run",
                                      runId: detail.data.session.run_id,
                                    })}
                                    label={detail.data.session.run_id}
                                    onNavigateTarget={onNavigateTarget}
                                    canNavigateTarget={canNavigateTarget}
                                  />
                                ) : (
                                  "Not recorded"
                                )}
                              </dd>
                            </div>
                            <div>
                              <dt>Linked scopes</dt>
                              <dd>
                                {detail.data.session.scopes.length === 0
                                  ? "None"
                                  : detail.data.session.scopes.map(
                                      (scope, index) =>
                                        state.scope && (
                                          <TargetControl
                                            key={index}
                                            target={historyNavigationTarget(state.scope, {
                                              kind: "scope",
                                              scope,
                                            })}
                                            label={
                                              scope.kind === "workspace"
                                                ? "Workspace"
                                                : `${scope.kind}: ${scope.id}`
                                            }
                                            onNavigateTarget={onNavigateTarget}
                                            canNavigateTarget={canNavigateTarget}
                                          />
                                        ),
                                    )}
                              </dd>
                            </div>
                          </dl>
                        </details>
                      </>
                    )}
                    <ReadStatus state={state.session} label="session metadata" />
                    {detail ? (
                      <>
                        {detail.data.session.parent_event && (
                          <p className="wg-hint">
                            Forked from {detail.data.session.parent_event.session_id} · event{" "}
                            {detail.data.session.parent_event.sequence}. Parent events are not
                            copied.
                          </p>
                        )}
                        <Toolbar label="History presentation">
                          <Button aria-pressed={!raw} onClick={() => setRaw(false)}>
                            Conversation
                          </Button>
                          <Button aria-pressed={raw} onClick={() => setRaw(true)}>
                            All raw events
                          </Button>
                          <Select
                            label="Payload format"
                            disabled={state.readingEvents || state.loadingMore || state.projecting}
                            value={state.format}
                            onChange={(event) =>
                              controller.setFormat(event.target.value as FormatSelection)
                            }
                          >
                            <option value="auto">Auto-detect format</option>
                            <option value="generic">Generic records</option>
                            {FORMAT_ADAPTERS.map((adapter) => (
                              <option value={adapter.id} key={adapter.id}>
                                {adapter.label}
                              </option>
                            ))}
                          </Select>
                        </Toolbar>
                        {window && (
                          <details className="ht-format-help">
                            <summary>Format recognition</summary>
                            <FormatCoverageSummary
                              selection={state.format}
                              coverage={formatCoverage(
                                events.map((event) => {
                                  const key = partKey(event.event_ref, { kind: "payload" });
                                  const payload = state.payloads.get(key);
                                  return {
                                    payload: payload
                                      ? payload.complete
                                        ? "complete"
                                        : "partial"
                                      : "unloaded",
                                    projection: state.projections.get(key) ?? null,
                                  };
                                }),
                              )}
                            />
                          </details>
                        )}
                        <ReadStatus state={state.window} label="event window" />
                        <ReadStatus state={state.payloadBatch} label="visible payload batch" />
                        {window && (
                          <>
                            <details className="ht-window-details">
                              <summary>Event window details</summary>
                              <p className="ht-range">
                                Loaded {events.length} events · range{" "}
                                {events[0]?.event_ref.sequence ?? "empty"}–
                                {events.at(-1)?.event_ref.sequence ?? "empty"} of captured bound
                                {window.data.through} · omitted for this page byte budget{" "}
                                {window.data.omitted_for_budget} · native has_more{" "}
                                {String(window.data.has_more)} · next anchor{" "}
                                {window.data.next_anchor}. Source timestamps never change event
                                order.
                              </p>
                            </details>
                            {window.data.omitted_for_budget !== "0" && (
                              <p className="ht-warning">
                                {window.data.omitted_for_budget} events omitted for this page byte
                                budget. Use event navigation to continue.
                              </p>
                            )}
                            {events.length === 0 && (
                              <p>No events in this captured session/window.</p>
                            )}
                            <div className="ht-messages" ref={messagesRef}>
                              {events.map((event) => (
                                <EventCard
                                  renderPayload={renderPayload}
                                  {...(!raw
                                    ? {
                                        pairedTools: pairing.calls,
                                        pairedResults: pairing.results,
                                        renderResult: (pair: ToolPair) => (
                                          <PairedToolResult
                                            pair={pair}
                                            state={state}
                                            controller={controller}
                                            renderPayload={renderPayload}
                                          />
                                        ),
                                      }
                                    : {})}
                                  key={`${window.data.session_id}/${event.event_ref.sequence}/${event.identity_hash}/${raw}`}
                                  event={event}
                                  onNavigateTarget={onNavigateTarget}
                                  canNavigateTarget={canNavigateTarget}
                                  {...(!raw &&
                                  duplicates.get(event.event_ref.sequence) !== undefined
                                    ? { duplicateEvents: duplicates.get(event.event_ref.sequence)! }
                                    : {})}
                                  context={context}
                                  state={state}
                                  controller={controller}
                                  open={event === opened}
                                  onOpen={() => {
                                    controller.pauseFollowing();
                                    setSelected(event.event_ref.sequence);
                                  }}
                                  raw={raw}
                                />
                              ))}
                            </div>
                            <div className="ht-transcript-footer">
                              {(events.at(-1)?.event_ref.sequence ?? "0") !==
                              detail.data.through ? (
                                <>
                                  <Button
                                    disabled={
                                      state.loadingMore ||
                                      state.readingEvents ||
                                      state.projecting ||
                                      state.expanding
                                    }
                                    onClick={() => {
                                      followingRef.current = false;
                                      controller.pauseFollowing();
                                      controller.loadMore();
                                    }}
                                  >
                                    Load 60 more events
                                  </Button>
                                  <Button
                                    disabled={
                                      state.loadingMore ||
                                      state.readingEvents ||
                                      state.projecting ||
                                      state.expanding
                                    }
                                    onClick={() => {
                                      followingRef.current = false;
                                      controller.pauseFollowing();
                                      controller.loadMore(true);
                                    }}
                                  >
                                    Load all
                                  </Button>
                                  <span>
                                    {(
                                      BigInt(detail.data.through) -
                                      BigInt(events.at(-1)?.event_ref.sequence ?? "0")
                                    ).toString()}{" "}
                                    remaining
                                  </span>
                                </>
                              ) : (
                                <span>
                                  <Icon name={detail.data.session.archived ? "archive" : "check"} />
                                  {detail.data.session.archived
                                    ? "End of session · archived"
                                    : "Up to date · new events appear here"}
                                </span>
                              )}
                              {state.loadingMore && (
                                <Button onClick={controller.cancelLoadMore}>Stop loading</Button>
                              )}
                              {state.followLatest && (
                                <span className="ht-following">Following live</span>
                              )}
                            </div>
                          </>
                        )}
                        {state.projecting && state.projections.size === 0 && (
                          <p role="status" className="wg-hint">
                            Preparing conversation…
                          </p>
                        )}
                        {state.payloadFailure && (
                          <p role="alert" className="wg-error">
                            {failureText(state.payloadFailure)}
                          </p>
                        )}
                      </>
                    ) : (
                      <div className="ht-empty">
                        <Icon name="history" />
                        <h2>Explore recorded history</h2>
                        <p>
                          Choose a session to read its events, conversations, and original source
                          data.
                        </p>
                        <p>
                          Workgraph supports general records as well as recognized agent formats.
                        </p>
                      </div>
                    )}
                  </section>
                </div>
              )}
            </>
          )}
        </section>
      </HistoryReferences>
    </ManagementPresentation.Provider>
  );
}
