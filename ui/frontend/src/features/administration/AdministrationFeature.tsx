import { AdminActionExplanation } from "../connections/ActionExplanation";
import { ManagementHelp } from "../connections/ManagementHelp";
import { JournalDirectorySummary } from "./JournalDirectorySummary";
import { CapturedValues } from "../connections/CapturedValues";
import { useManagementPresentation } from "../connections/management-presentation";
import { useLiveSlot } from "../../core/state/live-registry";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Badge, Button, Field, Panel, StatePanel, Toolbar } from "../../components/Primitives";
import { Icon, type IconName } from "../../components/Icon";
import { ObservationNotice } from "../../components/ObservationNotice";
import { useClipboardCopy } from "../../content/clipboard";
import { jsonField, type JsonValue } from "../../core/json";
import * as c from "../../core/protocol/codec";
import * as d from "../../core/protocol/decoders";
import { createCompanion } from "../../core/protocol/client";
import type { HttpResult } from "../../core/protocol/http";
import type { Identifier, JsonObject, ReadResponse } from "../../core/protocol/types";
import { createReadSlot, type ReadState } from "../../core/state/read-slot";
import { DraftInputError } from "../connections/model";
import { failureText } from "../connections/failure";
import { JsonView, LazyDetails, OperationPanel } from "../connections/shared";
import { actionJson, createAdministrationClient, exportJobCodec, planJson } from "./client";
import { field, retryCommand, shellQuote } from "./model";
import type {
  AdminDraft,
  AdminFields,
  AdminKind,
  AdminSelection,
  AdministrationFeatureProps,
  AdministrationController,
  ExportJob,
} from "./types";
import "./administration.css";

type AdminSection = "exports" | "restore" | "offline" | "journals";
function draftSection(kind: AdminKind): AdminSection {
  switch (kind) {
    case "workspace_export":
    case "export_all":
    case "export_cancel":
    case "export_retry":
      return "exports";
    case "workspace_restore":
    case "restore_all":
    case "restore_cancel":
      return "restore";
    case "migrate_0_6_2":
    case "cleanup_stage":
      return "offline";
  }
}
const SECTIONS: ReadonlyArray<{
  readonly id: AdminSection;
  readonly title: string;
  readonly icon: IconName;
  readonly description: string;
  readonly needsDaemon: boolean;
}> = [
  {
    id: "exports",
    title: "Exports",
    icon: "archive",
    description: "Save a workspace snapshot and check its files before sharing or restoring it.",
    needsDaemon: true,
  },
  {
    id: "restore",
    title: "Restore",
    icon: "history",
    description: "Restore an export into a fresh location, or inspect a previous restore request.",
    needsDaemon: true,
  },
  {
    id: "offline",
    title: "Offline migration",
    icon: "workflow",
    description: "Convert a stopped 0.6.2 workspace into a new location on the companion host.",
    needsDaemon: false,
  },
  {
    id: "journals",
    title: "Journals and recovery",
    icon: "saved",
    description:
      "Inspect saved operations and request files to recover their exact original intent.",
    needsDaemon: false,
  },
];

const LABELS: Readonly<Record<AdminKind, string>> = {
  workspace_export: "Export workspace",
  export_all: "Export all workspaces",
  export_cancel: "Cancel export",
  export_retry: "Retry captured export",
  workspace_restore: "Restore workspace",
  restore_all: "Restore all workspaces",
  restore_cancel: "Cancel pending restore",
  migrate_0_6_2: "Migrate 0.6.2 workspace",
  cleanup_stage: "Clean owned migration stage",
};
function Message<T>({ state }: { readonly state: ReadState<T> }) {
  if (state.kind === "unexpected_error") throw state.error;
  if (state.kind === "loading" && state.previous === undefined)
    return <p role="status">Reading current observation…</p>;
  if (state.kind === "failed")
    return (
      <p role="alert" className="wg-error">
        {failureText(state.failure)} Previous successful observations remain historical.
      </p>
    );
  return null;
}
function useQuery<T>(key: string) {
  const [slot] = useState(() => createReadSlot<T>());
  useLiveSlot(slot);
  const state = useSyncExternalStore(slot.subscribe, slot.get);
  const [unexpected, setUnexpected] = useState<{ readonly error: unknown } | null>(null);
  useEffect(
    () => () => {
      slot.clear();
    },
    [slot, key],
  );
  if (unexpected !== null) throw unexpected.error;
  const value =
    state.kind !== "idle" && state.key === key
      ? state.kind === "ready"
        ? state.value
        : state.previous
      : undefined;
  const load = (read: (signal: AbortSignal) => Promise<HttpResult<T>>) => {
    void slot.load(key, read, { live: true }).catch((error: unknown) => setUnexpected({ error }));
  };
  return { state, value, load, dismiss: () => slot.clear() };
}
function scopeKey(selection: AdminSelection): string {
  return JSON.stringify([
    selection.connection?.id ?? null,
    selection.connection?.generation ?? null,
    selection.route.workspaceId,
    selection.route.projectId,
    selection.writer.actorId,
    selection.writer.runId,
  ]);
}
function Raw({
  selection,
  value,
  label,
  identity,
  review = false,
}: {
  readonly review?: boolean;
  readonly selection: AdminSelection;
  readonly value: JsonValue;
  readonly label: string;
  readonly identity: string;
}) {
  const management = useManagementPresentation();
  if (management)
    return review ? (
      <section aria-label={label}>
        <h3>{label}</h3>
        <CapturedValues value={value} />
      </section>
    ) : null;
  return (
    <LazyDetails summary={label}>
      <JsonView
        processing={selection.client.processing}
        value={value}
        label={label}
        identity={identity}
      />
    </LazyDetails>
  );
}
function DaemonQuery({
  selection,
  method,
  params,
  label,
  children,
  readOnChange = false,
}: {
  readonly readOnChange?: boolean;
  readonly selection: AdminSelection;
  readonly method: string;
  readonly params: JsonObject;
  readonly label: string;
  readonly children?: (response: ReadResponse) => ReactNode;
}) {
  const companion = useMemo(() => createCompanion(selection.client), [selection.client]);
  // These query params contain bounded known-field strings only.
  const encoded = JSON.stringify(params);
  const key = `${scopeKey(selection)}:${method}:${encoded}`;
  const query = useQuery<ReadResponse>(key);
  const load = () => {
    const connection = selection.connection;
    if (connection === null) return;
    query.load((signal) =>
      companion.read(
        {
          connection_id: connection.id,
          generation: connection.generation,
          method,
          params,
          lane: "visible",
        },
        signal,
      ),
    );
  };
  useEffect(() => {
    if (readOnChange && selection.current) load();
    // Key captures endpoint generation, scope, effective writer and exact known-field parameters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, readOnChange, selection.current]);
  let projection: ReactNode = null;
  if (query.value) {
    try {
      projection = children?.(query.value);
    } catch (error: unknown) {
      if (error instanceof DraftInputError) projection = <p role="alert">{error.message}</p>;
      else throw error;
    }
  }
  return (
    <section className="wg-admin-query">
      <Button
        onClick={load}
        disabled={
          selection.connection === null || !selection.current || query.state.kind === "loading"
        }
      >
        {label}
      </Button>
      {query.state.kind !== "idle" && <Button onClick={query.dismiss}>Hide results</Button>}
      <Message state={query.state} />
      {query.value && (
        <>
          {projection}
          <Raw
            selection={selection}
            value={d.jsonObject([
              ["data", query.value.response.data],
              ["meta", query.value.response.meta],
              ["pagination", query.value.pagination ?? d.jsonNull()],
            ])}
            label={`Complete ${method} response`}
            identity={`${scopeKey(selection)}:${method}`}
          />
        </>
      )}
    </section>
  );
}
function LocalDraft({
  draft,
  selection,
  controller,
  invoke,
}: {
  readonly draft: AdminDraft;
  readonly selection: AdminSelection;
  readonly controller: AdministrationController;
  readonly invoke: (promise: Promise<void>) => void;
}) {
  const job = draft.local;
  const report = job?.state.status === "succeeded" ? job.state.report : null;
  const copy = useClipboardCopy(draft.frozen ?? draft, {
    unavailable: "Clipboard unavailable; report path remains selectable.",
    copied: "Full-report command copied.",
  });
  if (draft.frozen?.kind !== "local") return null;
  return (
    <Panel
      title="Review offline helper"
      actions={
        <Badge tone={job?.state.status === "outcome_unknown" ? "warning" : "neutral"}>
          <span role="status">{job?.state.status ?? "preparation unconfirmed"}</span>
        </Badge>
      }
    >
      <p>
        Intention <code>{draft.id}</code>. This is a companion-host helper, separate from daemon
        receipts.
      </p>
      <p>
        Captured actor {draft.frozen.plan.context.writer?.actor_id ?? "observer"}; run{" "}
        {draft.frozen.plan.context.writer?.run_id ?? "none"}; workspace{" "}
        {draft.frozen.plan.context.workspace_id ?? "none"}; project{" "}
        {draft.frozen.plan.context.project_id ?? "none"}.
      </p>
      {job?.state.status === "running" && (
        <ObservationNotice status={draft.observation} subject="offline helper" />
      )}
      {job?.cancel_requested && (
        <p role="status">
          {job.state.status === "canceled_unsent"
            ? "Canceled before execution. This helper was not run."
            : "Cancellation was requested after admission. It does not prove rollback or unpublished output."}
        </p>
      )}
      {(job?.state.status === "failed" || job?.state.status === "outcome_unknown") && (
        <p role="alert">
          {job.state.problem.kind}: {job.state.problem.message}
        </p>
      )}
      {job?.diagnostic && (
        <p role="alert">
          Diagnostic: {job.diagnostic.kind}: {job.diagnostic.message}. A report problem does not
          negate an observed successful conversion.
        </p>
      )}
      <Toolbar label="Offline helper controls">
        {job && (
          <Button
            onClick={() => invoke(controller.localAction(draft.id, "inspect"))}
            disabled={draft.pending}
          >
            Inspect saved helper
          </Button>
        )}
        <Button
          tone="primary"
          onClick={() => invoke(controller.localAction(draft.id, "start"))}
          disabled={draft.pending || job?.state.status !== "prepared_unsent"}
        >
          Apply prepared offline helper
        </Button>
        <Button
          onClick={() => invoke(controller.localAction(draft.id, "cancel"))}
          disabled={
            draft.pending ||
            !(job?.state.status === "prepared_unsent" || job?.state.status === "running")
          }
        >
          {job?.state.status === "prepared_unsent"
            ? "Cancel unsent helper"
            : "Request helper cancellation"}
        </Button>
      </Toolbar>
      <p className="wg-hint">
        {job?.state.status === "canceled_unsent"
          ? "The canceled plan cannot execute. Create a new reviewed plan to run the helper."
          : "No automatic retry. Inspect uncertain output before explicitly preparing a new plan; the helper will never overwrite a published destination."}
      </p>
      {report && (
        <div>
          <p>
            Complete report on companion host: <code>{report.path}</code>
          </p>
          <p>
            SHA256 <code>{report.sha256}</code> · {report.byte_count} bytes. This records immutable
            publication; startup checks its exact bytes. A later file change is not a new conversion
            outcome.
          </p>
          <Button
            onClick={() => {
              void copy.copy(`cat -- ${shellQuote(report.path)}`);
            }}
          >
            Copy full-report command
          </Button>
          <p role="status">{copy.notice}</p>
        </div>
      )}
      <Raw
        selection={selection}
        review
        value={planJson(draft.frozen.plan)}
        label="Original exact offline plan"
        identity={`local-plan:${draft.id}`}
      />
      {job && (
        <>
          <Raw
            selection={selection}
            review
            value={actionJson(job.execution_action)}
            label="Captured canonical execution paths"
            identity={`local-paths:${draft.id}`}
          />
          {job.state.status === "succeeded" && (
            <Raw
              selection={selection}
              review
              value={job.state.summary}
              label="Migration or cleanup result summary"
              identity={`local-result:${draft.id}:${job.revision}`}
            />
          )}
        </>
      )}
    </Panel>
  );
}
function Editor({ draft, ...props }: AdministrationFeatureProps & { readonly draft: AdminDraft }) {
  const [unexpected, setUnexpected] = useState<{ readonly error: unknown } | null>(null);
  const operation = useSyncExternalStore(props.operations.subscribe, () =>
    props.operations.get(draft.id),
  );
  if (unexpected !== null) throw unexpected.error;
  if (draft.unexpected !== null) throw draft.unexpected.error;
  const locked = draft.pending || draft.frozen !== null;
  const invoke = (promise: Promise<void>) => {
    void promise.catch((error: unknown) => setUnexpected({ error }));
  };
  const input = (name: keyof AdminFields, label: string, hint?: string) => (
    <Field
      label={label}
      value={draft.fields[name]}
      readOnly={locked}
      maxLength={2 * 1024 * 1024}
      {...(hint === undefined ? {} : { hint })}
      onChange={(event) => props.controller.edit(draft.id, { [name]: event.target.value })}
    />
  );
  const host = draft.kind === "migrate_0_6_2" || draft.kind === "cleanup_stage";
  const needsPrepare =
    draft.frozen === null ||
    (draft.frozen.kind === "local"
      ? draft.local === null
      : operation?.operation === null || operation === undefined);
  return (
    <Panel
      title={LABELS[draft.kind]}
      className="wg-management-editor"
      actions={
        <Button onClick={() => props.controller.discard(draft.id)} disabled={draft.pending}>
          Close editor
        </Button>
      }
    >
      <AdminActionExplanation kind={draft.kind} />
      <p className="wg-hint">
        {host
          ? "Paths refer to the companion host."
          : `Captured daemon ${draft.selection.connection?.socket ?? "none"}, generation ${draft.selection.connection?.generation ?? "none"}. Paths refer to that daemon host.`}{" "}
        Actor {draft.selection.writer.actorId ?? "observer"}, run{" "}
        {draft.selection.writer.runId ?? "none"}. Navigation does not recapture this draft.
      </p>
      <p className="wg-hint">
        Closing an editable draft discards its unsent fields. Saved operations remain in the
        companion journal.
      </p>
      {draft.frozen !== null && (
        <Button
          disabled={draft.pending}
          onClick={() => {
            const copied = props.controller.create(props.selection, draft.kind, draft.fields);
            if (copied !== null) props.controller.edit(copied, {}, draft.allowPartial);
          }}
        >
          Copy as new editable draft with current selection
        </Button>
      )}
      <div className="wg-admin-fields">
        {draft.kind === "workspace_export" && input("workspaceId", "Workspace ID")}
        {(draft.kind === "workspace_export" ||
          draft.kind === "export_all" ||
          draft.kind === "migrate_0_6_2") &&
          input(
            "destination",
            host
              ? "Fresh destination on companion host"
              : "Fresh export destination on daemon host",
            "Use a full path to a new folder. Its parent must exist, and it must be separate from existing workspace folders.",
          )}
        {draft.kind === "export_all" && (
          <label>
            <input
              type="checkbox"
              checked={draft.allowPartial}
              disabled={locked}
              onChange={(event) => props.controller.edit(draft.id, {}, event.target.checked)}
            />
            Allow partial capture (incomplete container cannot restore all)
          </label>
        )}
        {(draft.kind === "export_cancel" || draft.kind === "export_retry") &&
          input("jobId", "Export job ID")}
        {(draft.kind === "workspace_restore" || draft.kind === "restore_all") &&
          input("directory", "Export directory on daemon host")}
        {draft.kind === "workspace_restore" && input("root", "Fresh restore root on daemon host")}
        {draft.kind === "restore_all" && (
          <label>
            Exact workspace-to-root JSON
            <textarea
              aria-label="Exact workspace-to-root JSON"
              value={draft.fields.rootsSource}
              readOnly={locked}
              onChange={(event) =>
                props.controller.edit(draft.id, { rootsSource: event.target.value })
              }
            />
          </label>
        )}
        {draft.kind === "restore_cancel" && (
          <>
            {input("targetActor", "Original restore actor")}
            {input("targetMutation", "Original restore mutation")}
          </>
        )}
        {draft.kind === "migrate_0_6_2" &&
          input("source", "Stopped 0.6.2 workspace source on companion host")}
        {draft.kind === "cleanup_stage" && (
          <>
            {input("stage", "Owned unpublished stage on companion host")}
            {input("owner_token", "Exact cleanup owner token")}
          </>
        )}
      </div>
      {(draft.kind === "workspace_restore" || draft.kind === "restore_all") && (
        <p>
          Verifies and replays current-format complete exports. Workspace identities must be absent
          from the registry. Installed workspaces register closed; open them explicitly afterward.
          Across roots, publication is resumable and may be partial. Retry the original saved
          request after interruption.
        </p>
      )}
      {draft.kind === "restore_cancel" && (
        <p>
          Creates a new cancellation operation targeting the original pending restore identity.
          Cancellation is allowed only while no target was installed or occupied; it releases
          reservations without deleting files. Otherwise complete the original exact retry.
        </p>
      )}
      {draft.kind === "cleanup_stage" && (
        <p>
          Destructive cleanup is limited to an unpublished stage with its exact owner token and
          allowlisted contents. Original sources and published destinations are never removed.
        </p>
      )}
      {draft.issue && (
        <p className="wg-error" role="alert">
          {draft.issue}
        </p>
      )}
      {draft.pending && <p role="status">Preparing or observing the captured action…</p>}
      {needsPrepare && (
        <Button
          tone="primary"
          disabled={draft.pending}
          onClick={() => invoke(props.controller.review(draft.id))}
        >
          {draft.frozen === null
            ? "Review and prepare action"
            : "Retry preparation of same captured plan"}
        </Button>
      )}
      {draft.frozen?.kind === "daemon" && (
        <OperationPanel
          intention={draft.id}
          operations={props.operations}
          processing={props.selection.client.processing}
        />
      )}
      {draft.frozen?.kind === "local" && (
        <LocalDraft
          draft={draft}
          selection={props.selection}
          controller={props.controller}
          invoke={invoke}
        />
      )}
    </Panel>
  );
}
function ExportCard({
  job,
  selection,
  controller,
}: {
  readonly job: ExportJob;
  readonly selection: AdminSelection;
  readonly controller: AdministrationController;
}) {
  return (
    <article className="wg-admin-job">
      <h4>
        Export <code>{job.job_id}</code>{" "}
        <Badge tone={job.status === "failed" ? "warning" : "neutral"}>{job.status}</Badge>
      </h4>
      <p>
        <code>{job.destination}</code> · attempt {job.attempt} · {job.captures.length} captures ·{" "}
        {job.omitted.length} omitted
      </p>
      <p>
        Job status is current observation; admission receipts are historical. Completed means
        publication, not a fresh integrity verification.
      </p>
      {job.cancel_requested && <p>Cancellation requested; wait for the terminal status.</p>}
      {job.error && <p role="alert">{job.error}</p>}
      <p>
        {job.captures
          .slice(0, 3)
          .map((capture) => `${capture.workspace_id}@${capture.revision}`)
          .join(", ")}
        {job.captures.length > 3
          ? ` (3 of ${job.captures.length} captures previewed; complete vector in response below)`
          : ""}
      </p>
      {job.omitted.length > 0 && (
        <p>
          Incomplete container: cannot restore all. Omitted IDs are retained in the complete
          response.
        </p>
      )}
      <Toolbar label={`Export ${job.job_id} controls`}>
        <Button
          disabled={job.status !== "running" || job.cancel_requested}
          onClick={() => controller.create(selection, "export_cancel", { jobId: job.job_id })}
        >
          Review export cancellation
        </Button>
        <Button
          disabled={
            !(job.status === "failed" || job.status === "canceled" || job.status === "interrupted")
          }
          onClick={() => controller.create(selection, "export_retry", { jobId: job.job_id })}
        >
          Review retry of original capture
        </Button>
        <Button
          disabled={job.status !== "completed"}
          onClick={() =>
            controller.editTools({
              verifyDirectory:
                job.kind === "workspace"
                  ? job.destination
                  : `${job.destination}/workspaces/${job.captures[0]?.workspace_id ?? ""}`,
            })
          }
        >
          {job.kind === "workspace"
            ? "Use published directory for verification"
            : "Use first member for verification"}
        </Button>
      </Toolbar>
    </article>
  );
}
function Exports(props: AdministrationFeatureProps) {
  const [offset, setOffset] = useState("0"),
    [jobId, setJobId] = useState("");
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.get);
  const params = d.jsonObject([
    ["offset", d.jsonString(offset)],
    ["limit", d.jsonString("10")],
    ["max_bytes", d.jsonString("1048576")],
  ]);
  const [continuation, setContinuation] = useState<JsonObject | null>(null);
  // Continuations are taken verbatim from the native validator, including snapshot.
  const listing = continuation ?? params;
  return (
    <div className="wg-admin-export-layout">
      <section className="wg-admin-card wg-admin-export-jobs" aria-label="Workspace exports">
        <h3>
          <Icon name="archive" />
          Workspace exports
        </h3>
        <Toolbar label="Export actions">
          <Button
            tone="primary"
            onClick={() => props.controller.create(props.selection, "workspace_export")}
          >
            Export workspace
          </Button>
          <Button onClick={() => props.controller.create(props.selection, "export_all")}>
            Export all workspaces
          </Button>
          <Button
            onClick={() => {
              setOffset("0");
              setContinuation(null);
            }}
          >
            Show newest exports
          </Button>
        </Toolbar>
        <p className="wg-hint">
          Save committed tickets, history and resource files while normal work continues. Exporting
          starts only after you review and execute the saved request.
        </p>
        <DaemonQuery
          selection={props.selection}
          method="export.list"
          readOnChange
          params={listing}
          label="Read export jobs"
        >
          {(result) => {
            const items = field(result.response.data, "items", c.array(exportJobCodec, 100));
            const next =
              result.pagination === null ? undefined : jsonField(result.pagination, "next_request");
            const request =
              next === undefined
                ? null
                : c
                    .record({
                      jsonrpc: c.literal("2.0"),
                      workgraph_api: c.literal("0.7"),
                      id: c.raw,
                      method: c.literal("export.list"),
                      params: c.object,
                    })
                    .decode(next);
            return (
              <>
                {items.length === 0 ? (
                  <p>No export jobs in this captured page.</p>
                ) : (
                  items.map((job) => (
                    <ExportCard
                      key={job.job_id}
                      job={job}
                      selection={props.selection}
                      controller={props.controller}
                    />
                  ))
                )}
                <p>
                  Remaining jobs: {field(result.response.data, "remaining", d.decimal)}. Changes
                  invalidate the snapshot; restart the traversal after conflict.
                </p>
                <Button
                  disabled={request === null || !request.ok}
                  onClick={() => {
                    if (request?.ok) {
                      setContinuation(request.value.params);
                      setOffset(field(request.value.params, "offset", d.decimal));
                    }
                  }}
                >
                  Next export page
                </Button>
              </>
            );
          }}
        </DaemonQuery>
        <details className="wg-admin-inspector">
          <summary>Find an export by job ID</summary>
          <Field
            label="Export job to inspect"
            value={jobId}
            onChange={(event) => setJobId(event.target.value)}
          />
          <Button
            disabled={jobId === ""}
            onClick={() => props.controller.create(props.selection, "export_cancel", { jobId })}
          >
            Cancel export by ID
          </Button>
          {jobId !== "" && (
            <DaemonQuery
              selection={props.selection}
              method="export.get"
              params={d.jsonObject([["job_id", d.jsonString(jobId)]])}
              label="Inspect export current status"
            >
              {(result) => {
                const decoded = exportJobCodec.decode(result.response.data);
                return decoded.ok ? (
                  <ExportCard
                    job={decoded.value}
                    selection={props.selection}
                    controller={props.controller}
                  />
                ) : (
                  <p role="alert">This export status could not be read. Refresh to try again.</p>
                );
              }}
            </DaemonQuery>
          )}
        </details>
      </section>
      <section className="wg-admin-card" aria-label="Verify an export">
        <h3>
          <Icon name="check" />
          Verify an export
        </h3>
        <p className="wg-hint">
          Check an existing export before copying or restoring it. Paths refer to the machine
          running the daemon.
        </p>
        <Field
          label="Directory to verify on daemon host"
          value={state.tools.verifyDirectory}
          onChange={(event) => props.controller.editTools({ verifyDirectory: event.target.value })}
        />
        <p className="wg-hint">
          Checks file inventory, hashes, safe paths and captured metadata. For an all-workspace
          export, select one <code>workspaces/ID</code> member. This does not replay the database;
          restore performs that validation and checks the complete outer container.
        </p>
        <DaemonQuery
          selection={props.selection}
          method="export.verify"
          params={d.jsonObject([["directory", d.jsonString(state.tools.verifyDirectory)]])}
          label="Verify export inventory and hashes"
        >
          {(result) => (
            <p role="status">
              Inventory verification result for workspace{" "}
              {field(result.response.data, "workspace_id", d.identifier)}, revision{" "}
              {field(result.response.data, "revision", d.decimal)}. Full canonical replay is not
              performed by this check.
            </p>
          )}
        </DaemonQuery>
      </section>
    </div>
  );
}
function Restores(props: AdministrationFeatureProps) {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.get);
  return (
    <div className="wg-admin-export-layout">
      <section className="wg-admin-card" aria-label="Restore an export">
        <h3>
          <Icon name="history" />
          Restore an export
        </h3>
        <Toolbar label="Restore actions">
          <Button onClick={() => props.controller.create(props.selection, "workspace_restore")}>
            Restore workspace
          </Button>
          <Button onClick={() => props.controller.create(props.selection, "restore_all")}>
            Restore all workspaces
          </Button>
          <Button onClick={() => props.controller.create(props.selection, "restore_cancel")}>
            Cancel pending restore
          </Button>
        </Toolbar>
        <p className="wg-hint">
          Choose a workspace export or a complete all-workspace export. Restores require fresh
          target folders and register the restored workspaces closed; open them when ready.
        </p>
        <p className="wg-hint">
          Pending means the daemon has accepted the request, not that the restore has completed.
          There is no percentage progress value. Inspect the saved operation or its original
          receipt.
        </p>
      </section>
      <section className="wg-admin-card" aria-label="Inspect a restore receipt">
        <h3>
          <Icon name="search" />
          Inspect a restore receipt
        </h3>
        <p className="wg-hint">
          Use the actor and mutation IDs from the original saved restore request.
        </p>
        <Field
          label="Registry receipt actor"
          value={state.tools.receiptActor}
          onChange={(event) => props.controller.editTools({ receiptActor: event.target.value })}
        />
        <Field
          label="Registry receipt mutation"
          value={state.tools.receiptMutation}
          onChange={(event) => props.controller.editTools({ receiptMutation: event.target.value })}
        />
        <DaemonQuery
          selection={props.selection}
          method="registry.receipt"
          params={d.jsonObject([
            ["actor_id", d.jsonString(state.tools.receiptActor)],
            ["mutation_id", d.jsonString(state.tools.receiptMutation)],
          ])}
          label="Inspect original registry receipt"
        >
          {(result) => (
            <p role="status">
              Receipt: {field(result.response.data, "status", c.text)}. A pending or absent
              observation never authorizes a new identity to replace an uncertain original request.
            </p>
          )}
        </DaemonQuery>
      </section>
    </div>
  );
}
function Offline(props: AdministrationFeatureProps) {
  const [unexpected, setUnexpected] = useState<{ readonly error: unknown } | null>(null);
  const client = useMemo(
    () => createAdministrationClient(props.selection.client),
    [props.selection.client],
  );
  const [offset, setOffset] = useState("0");
  const jobs = useQuery<
    Awaited<ReturnType<typeof client.list>> extends HttpResult<infer T> ? T : never
  >(`local-jobs:${offset}`);
  if (unexpected !== null) throw unexpected.error;
  return (
    <div className="wg-admin-export-layout">
      <section className="wg-admin-card" aria-label="Offline workspace conversion">
        <h3>
          <Icon name="workflow" />
          Convert an older workspace
        </h3>
        <Toolbar label="Offline administration actions">
          <Button onClick={() => props.controller.create(props.selection, "migrate_0_6_2")}>
            Migrate 0.6.2 workspace
          </Button>
          <Button onClick={() => props.controller.create(props.selection, "cleanup_stage")}>
            Clean owned migration stage
          </Button>
        </Toolbar>
        <p>
          Explicit offline conversion accepts only released 0.6.2 workspace formats. Stop the old
          daemon and resolve its uncertain writes using its original executable first. The source
          committed files are preserved; a fresh destination is verified and published without
          replacement.
        </p>
        <p>
          Machine registry jobs, request envelopes, caches and exports are not migrated. History
          digests change; the complete report preserves old-to-new head mappings. Register a
          successful destination separately in a fresh registry. No daemon is needed for these
          tools.
        </p>
      </section>
      <section className="wg-admin-card" aria-label="Saved offline jobs">
        <h3>
          <Icon name="history" />
          Saved offline jobs
        </h3>
        <p className="wg-hint">
          Reopen a prepared or previously run helper to inspect its original plan, status and
          report. Opening a record does not run it.
        </p>
        <Button onClick={() => jobs.load((signal) => client.list(offset, signal))}>
          List saved offline jobs
        </Button>
        {jobs.state.kind !== "idle" && (
          <Button onClick={jobs.dismiss}>Hide saved offline jobs</Button>
        )}
        <Message state={jobs.state} />
        {jobs.value && (
          <>
            {jobs.value.items.map((job) => (
              <article key={job.plan.intention_id} className="wg-admin-job">
                <p>
                  <code>{job.plan.intention_id}</code> · {job.plan.action.kind} · {job.state.status}{" "}
                  · revision {job.revision}
                </p>
                <Button
                  onClick={() => {
                    void props.controller
                      .adoptLocal(job)
                      .then((accepted) => {
                        if (accepted) props.controller.select(job.plan.intention_id);
                      })
                      .catch((error: unknown) => setUnexpected({ error }));
                  }}
                >
                  Open saved offline helper
                </Button>
              </article>
            ))}
            {jobs.value.items.length === 0 && <p>No offline jobs in this page.</p>}
            <Button
              disabled={jobs.value.next_offset === null}
              onClick={() => {
                if (jobs.value?.next_offset !== null && jobs.value?.next_offset !== undefined)
                  setOffset(jobs.value.next_offset);
              }}
            >
              Next saved helper page
            </Button>
            <Button onClick={() => setOffset("0")}>First saved helper page</Button>
          </>
        )}
      </section>
    </div>
  );
}
function Journals(props: AdministrationFeatureProps) {
  const management = useManagementPresentation();
  const client = useMemo(
    () => createAdministrationClient(props.selection.client),
    [props.selection.client],
  );
  const companion = useMemo(
    () => createCompanion(props.selection.client),
    [props.selection.client],
  );
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.get);
  const [offset, setOffset] = useState("0"),
    [selected, setSelected] = useState<Identifier | null>(null),
    [after, setAfter] = useState<string | null>(null),
    [issue, setIssue] = useState("");
  const [unexpected, setUnexpected] = useState<{ readonly error: unknown } | null>(null);
  const ops = useQuery<
    Awaited<ReturnType<typeof client.operations>> extends HttpResult<infer T> ? T : never
  >(`operations:${offset}`);
  const journals = useQuery<JsonObject>(`journals:${state.tools.directory}:${after ?? ""}`);
  const journal = useQuery<JsonObject>(`journal:${state.tools.journalPath}`);
  const copy = useClipboardCopy(state.tools, {
    unavailable: "Clipboard unavailable; command remains selectable.",
    copied: "External exact-retry command copied.",
  });
  let command = "";
  try {
    if (state.tools.socket !== "" && state.tools.journalPath !== "")
      command = retryCommand(state.tools.socket, state.tools.journalPath);
  } catch (error: unknown) {
    if (!(error instanceof DraftInputError)) throw error;
  }
  if (unexpected !== null) throw unexpected.error;
  const reload = (id: Identifier) => {
    setIssue("");
    void companion
      .inspect(id)
      .then(async (result) => {
        if (!result.ok) {
          setIssue(failureText(result.failure));
          return;
        }
        const adopted = await props.operations.adopt(result.data);
        if (!adopted.ok) setIssue(failureText(adopted.failure));
        else setSelected(result.data.preparation.intention_id);
      })
      .catch((error: unknown) => setUnexpected({ error }));
  };
  return (
    <div className="wg-admin-export-layout">
      <section className="wg-admin-card" aria-label="Saved operations">
        <h3>
          <Icon name="saved" />
          Companion-owned saved operations
        </h3>
        <p>
          All operations in this companion state root are listed, including their original endpoint
          generation and writer. Reloading does not execute or change their identities. Use the
          original receipt or explicit exact retry after inspection.
        </p>
        <Button onClick={() => ops.load((signal) => client.operations(offset, signal))}>
          List companion saved operations
        </Button>
        {ops.state.kind !== "idle" && (
          <Button onClick={ops.dismiss}>Hide saved operation list</Button>
        )}
        <Message state={ops.state} />
        {ops.value && (
          <>
            {ops.value.items.map((row) => {
              const id = field(row, "operation_id", d.identifier);
              return (
                <article className="wg-admin-job" key={id}>
                  <p>
                    <code>{id}</code> · {field(row, "method", c.text)} ·{" "}
                    {field(row, "state_kind", c.text)} · {field(row, "connection_id", d.identifier)}{" "}
                    generation {field(row, "generation", d.decimal)}
                  </p>
                  <Button onClick={() => reload(id)}>Reload saved operation {id}</Button>
                </article>
              );
            })}
            <Button
              disabled={ops.value.next_offset === null}
              onClick={() => {
                if (ops.value?.next_offset !== null && ops.value?.next_offset !== undefined)
                  setOffset(ops.value.next_offset);
              }}
            >
              Next saved operation page
            </Button>
          </>
        )}
        {issue && <p role="alert">{issue}</p>}
        {selected && (
          <OperationPanel
            intention={selected}
            operations={props.operations}
            processing={props.selection.client.processing}
          />
        )}
      </section>
      <section className="wg-admin-card" aria-label="Saved request files">
        <h3>
          <Icon name="resources" />
          Find saved request files
        </h3>
        <p>
          Find request files saved on the machine running the UI service. These files record what
          was requested, but do not prove it was sent or saved successfully. Duplicate and
          conflicting requests are identified within each returned page. The retry command below is
          for you to run in a terminal; this screen never runs it automatically.
        </p>
        <Field
          label="Journal directory on companion host"
          value={state.tools.directory}
          hint="Blank selects this companion's private request directory."
          onChange={(event) => {
            props.controller.editTools({ directory: event.target.value });
            setAfter(null);
          }}
        />
        <Button
          onClick={() =>
            journals.load((signal) =>
              client.journals(
                state.tools.directory === "" ? null : state.tools.directory,
                after,
                signal,
              ),
            )
          }
        >
          Inspect journal directory
        </Button>
        {journals.state.kind !== "idle" && (
          <Button onClick={journals.dismiss}>Hide directory results</Button>
        )}
        <Message state={journals.state} />
        {journals.value && (
          <>
            <p>
              Directory observation complete:{" "}
              {field(journals.value, "complete", c.boolean) ? "yes" : "no"}. Commit status remains
              unchecked.
            </p>
            {management && <JournalDirectorySummary value={journals.value} />}
            <Raw
              selection={props.selection}
              value={journals.value}
              label="Complete journal directory observation"
              identity={`journal-dir:${state.tools.directory}:${after ?? ""}`}
            />
            <Button
              disabled={field(journals.value, "next_after", c.nullable(c.text)) === null}
              onClick={() =>
                setAfter(field(journals.value ?? d.jsonNull(), "next_after", c.nullable(c.text)))
              }
            >
              Continue after returned filename
            </Button>
          </>
        )}
        <Field
          label="Exact saved request path on companion host"
          value={state.tools.journalPath}
          onChange={(event) => props.controller.editTools({ journalPath: event.target.value })}
        />
        <Button
          onClick={() => journal.load((signal) => client.journal(state.tools.journalPath, signal))}
        >
          Inspect exact saved request
        </Button>
        {journal.state.kind !== "idle" && (
          <Button onClick={journal.dismiss}>Hide request details</Button>
        )}
        <Message state={journal.state} />
        {journal.value && (
          <>
            <p>
              Original method <code>{field(journal.value, "method", c.text)}</code> ·{" "}
              {field(journal.value, "kind", c.text)} · commit{" "}
              {field(journal.value, "commit_status", c.text)} · transmission{" "}
              {field(journal.value, "transmission_status", c.text)}
            </p>
            <p>
              Envelope SHA256 <code>{field(journal.value, "envelope_hash", d.digest)}</code>. The
              receipt request hash below is a distinct identity. Upload plans expose their distinct
              finish identity and require original source bytes; publication and optional ticket
              linking remain separate.
            </p>
            <JournalAttribution value={journal.value} />
            <Raw
              selection={props.selection}
              value={journal.value}
              label="Exact saved request metadata"
              identity={`journal:${state.tools.journalPath}`}
            />
          </>
        )}
        <Field
          label="Explicit daemon socket for external retry"
          value={state.tools.socket}
          onChange={(event) => props.controller.editTools({ socket: event.target.value })}
        />
        <Button
          disabled={props.selection.connection === null}
          onClick={() => {
            if (props.selection.connection)
              props.controller.editTools({ socket: props.selection.connection.socket });
          }}
        >
          Use selected connection socket explicitly
        </Button>
        <p className="wg-hint">
          Confirm this is the intended daemon/namespace. The inspected journal never supplies or
          authenticates its original endpoint. Resolve old-version requests using their old binary.
        </p>
        {command !== "" && journal.value && (
          <>
            <pre aria-label="External exact retry command">{command}</pre>
            <Button
              onClick={() => {
                void copy.copy(command);
              }}
            >
              Copy external exact retry command
            </Button>
            <p role="status">{copy.notice}</p>
          </>
        )}
      </section>
    </div>
  );
}
function JournalAttribution({ value }: { readonly value: JsonObject }) {
  const mutation = field(value, "mutation", c.nullable(c.object));
  if (mutation === null) return <p>This request has no durable mutation receipt identity.</p>;
  const namespace = field(mutation, "namespace", c.object);
  const kind = field(namespace, "kind", c.text);
  const workspace = kind === "registry" ? null : field(namespace, "workspace_id", d.identifier);
  return (
    <dl className="wg-admin-identity">
      <dt>
        {field(value, "kind", c.text) === "upload_plan"
          ? "Upload finish receipt namespace"
          : "Receipt namespace"}
      </dt>
      <dd>
        {kind}
        {workspace === null ? "" : ` · workspace ${workspace}`}
      </dd>
      <dt>Original actor</dt>
      <dd>
        <code>{field(mutation, "actor_id", d.identifier)}</code>
      </dd>
      <dt>Original mutation</dt>
      <dd>
        <code>{field(mutation, "mutation_id", d.identifier)}</code>
      </dd>
      <dt>Original run</dt>
      <dd>{field(mutation, "run_id", c.nullable(d.identifier)) ?? "none"}</dd>
      <dt>Receipt request SHA256</dt>
      <dd>
        <code>{field(mutation, "request_hash", d.digest)}</code>
      </dd>
    </dl>
  );
}
export function AdministrationFeature(props: AdministrationFeatureProps) {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.get);
  const [tab, setTab] = useState<AdminSection>(props.hostOnly ? "offline" : "exports");
  const section = SECTIONS.find((item) => item.id === tab);
  const draft =
    state.drafts.find((item) => item.id === state.activeId && draftSection(item.kind) === tab) ??
    [...state.drafts].reverse().find((item) => draftSection(item.kind) === tab);
  const active =
    draft !== undefined &&
    (!props.hostOnly || draft.kind === "migrate_0_6_2" || draft.kind === "cleanup_stage")
      ? draft
      : undefined;
  return (
    <section className="wg-admin" aria-label="Administration">
      <header className="wg-admin-heading">
        <h2>{props.hostOnly ? "Local maintenance and recovery" : "Workspace maintenance"}</h2>
        <span>
          {props.hostOnly ? "No connected daemon required" : "Backup, restore & recovery"}
        </span>
      </header>
      <nav className="wg-admin-tabs" aria-label="Administration sections">
        {SECTIONS.filter((item) => !props.hostOnly || !item.needsDaemon).map((item) => (
          <Button
            key={item.id}
            data-section={item.id}
            onClick={() => setTab(item.id)}
            aria-pressed={tab === item.id}
          >
            <Icon name={item.icon} />
            {item.title}
          </Button>
        ))}
      </nav>
      <p className="wg-admin-intro">{section?.description}</p>
      <ManagementHelp key={tab} section={tab} />
      {state.notice && <p role="alert">{state.notice}</p>}
      {active && <Editor {...props} draft={active} />}
      {(tab === "exports" || tab === "restore") && props.selection.connection === null ? (
        <StatePanel kind="empty" title="Choose a daemon connection">
          Export and restore operate on the selected daemon; offline tools remain available.
        </StatePanel>
      ) : tab === "exports" ? (
        <Exports {...props} />
      ) : tab === "restore" ? (
        <Restores {...props} />
      ) : tab === "offline" ? (
        <Offline {...props} />
      ) : (
        <Journals {...props} />
      )}
      <Toolbar label="Retained administration drafts">
        {state.drafts
          .filter(
            (item) =>
              draftSection(item.kind) === tab &&
              (!props.hostOnly || item.kind === "migrate_0_6_2" || item.kind === "cleanup_stage"),
          )
          .map((item) => (
            <Button
              key={item.id}
              onClick={() => props.controller.select(item.id)}
              aria-pressed={state.activeId === item.id}
            >
              {LABELS[item.kind]} · {item.id.slice(-8)}
            </Button>
          ))}
      </Toolbar>
    </section>
  );
}
