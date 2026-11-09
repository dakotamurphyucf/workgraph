import { useEffect, useState, useSyncExternalStore } from "react";
import { Badge, Button, Field, Panel, Select, Toolbar } from "../../../components/Primitives";
import type { FeatureContext } from "../../../app/types";
import { ResourceSection } from "./ResourceDesign";
import { resourceSize } from "./presentation";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { ReferencePicker } from "../../discussions/ReferencePicker";
import type { ResourceUploadController, UploadPhase } from "./upload-types";
import { resourceRoute } from "./navigation";
import { jsonField } from "../../../core/json";
function phaseLabel(phase: UploadPhase): string {
  switch (phase.kind) {
    case "local_save_incomplete":
      return "Local save incomplete; not safe to replace";
    case "prepared_unsent":
      return "Ready to publish";
    case "running":
      return "Uploading";
    case "outcome_unknown":
      return "Outcome unknown — check or retry this upload";
    case "rejected":
      return "Rejected";
    case "published":
      return phase.link.kind === "committed"
        ? "Published and linked to ticket"
        : phase.link.kind === "not_requested"
          ? "Published"
          : "Published; ticket link needs attention";
  }
}
export function ResourceUploads({
  context,
  controller,
}: {
  readonly context: FeatureContext;
  readonly controller: ResourceUploadController;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.get),
    draft = state.drafts.find((d) => d.id === state.selectedId),
    job = state.selectedJob;
  const [hiddenJob, setHiddenJob] = useState<string | null>(null);
  const observedId =
    job?.phase.kind === "running" && hiddenJob !== job.intention_id ? job.intention_id : null;
  useEffect(() => {
    if (observedId === null) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await controller.observe(observedId, abort.signal);
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [controller, observedId]);
  const inspect = (id: Parameters<ResourceUploadController["inspect"]>[0]) => {
    setHiddenJob(null);
    void controller.inspect(id);
  };
  if (state.unexpected) throw state.unexpected.error;
  if (draft?.unexpected) throw draft.unexpected.error;
  const published =
    job?.phase.kind === "published"
      ? job.phase
      : job?.phase.kind === "running"
        ? job.phase.previous
        : null;
  const rawConnection = job ? jsonField(job.plan, "connection") : undefined;
  const field = (name: string) => {
    const value = rawConnection === undefined ? undefined : jsonField(rawConnection, name);
    return value?.kind === "string" ? value.value : null;
  };
  const rawContext = job ? jsonField(job.plan, "context") : undefined,
    workspaceValue = rawContext === undefined ? undefined : jsonField(rawContext, "workspace_id"),
    workspace = workspaceValue?.kind === "string" ? workspaceValue.value : null;
  return (
    <section className="rs-uploads" aria-label="Native Resource transfers">
      <h3>Upload and manage files</h3>
      <p className="rs-intro">
        Add a file up to 64 MiB, or publish a new version of an existing resource. Files stay local
        to the connected Workgraph service.
      </p>
      <ol className="rs-upload-steps">
        <li>
          <strong>1 · Choose and stage</strong>
          <span>Select a file and copy it to temporary storage. Nothing is published yet.</span>
        </li>
        <li>
          <strong>2 · Prepare</strong>
          <span>Save the upload details so this exact operation can be recovered.</span>
        </li>
        <li>
          <strong>3 · Publish</strong>
          <span>Start the prepared upload to make the file available as a resource.</span>
        </li>
      </ol>
      {state.issue && <p role="alert">{state.issue}</p>}
      {state.drafts.length > 0 && (
        <Select
          label="Resume an upload draft"
          value={state.selectedId ?? ""}
          onChange={(e) =>
            controller.choose(state.drafts.find((d) => d.id === e.target.value)?.id ?? null)
          }
        >
          <option value="">Choose an unfinished upload</option>
          {state.drafts.map((d) => (
            <option key={d.id} value={d.id}>
              {d.input.resourceId || "new resource"} · {d.phase}
            </option>
          ))}
        </Select>
      )}
      {draft && (
        <ResourceSection
          title={draft.expectedRevision === "0" ? "Choose your file" : "Upload a new version"}
          description={
            draft.expectedRevision === "0"
              ? "Give this resource a recognizable name and a unique ID. You can link it to a ticket now or connect it to other work later."
              : "This saves new content to the existing resource. Its earlier versions and links remain available."
          }
          tone="blue"
        >
          <div className="rs-writer">
            <ActorAvatar actor={draft.writer.actorId} />
            <span>
              Uploading as <strong>{draft.writer.actorId}</strong> in{" "}
              <strong>{draft.scope.workspaceId}</strong>. This upload keeps that identity.
            </span>
          </div>
          <fieldset disabled={draft.phase !== "editing"} className="rs-upload-fields">
            <Field
              label="Upload resource ID"
              value={draft.input.resourceId}
              readOnly={draft.expectedRevision !== "0"}
              hint="A stable ID using letters, numbers, hyphens or underscores."
              onChange={(e) =>
                controller.edit(draft.id, { ...draft.input, resourceId: e.target.value })
              }
            />
            <Field
              label="Upload title"
              hint="The name shown in the resource library."
              value={draft.input.title}
              onChange={(e) => controller.edit(draft.id, { ...draft.input, title: e.target.value })}
            />
            <Field
              label="Upload filename"
              hint="The name used for downloads, including its extension."
              value={draft.input.filename}
              onChange={(e) =>
                controller.edit(draft.id, { ...draft.input, filename: e.target.value })
              }
            />
            <Field
              label="Upload MIME type"
              hint="Detected from the file when available. For example, application/pdf or text/markdown."
              value={draft.input.mimeType}
              onChange={(e) =>
                controller.edit(draft.id, { ...draft.input, mimeType: e.target.value })
              }
            />
            <ReferencePicker
              context={context}
              endpoint={{
                connectionId: draft.scope.connection.id,
                generation: draft.scope.connection.generation,
                workspaceId: draft.scope.workspaceId,
              }}
              kind="ticket"
              label="Link to ticket ID (optional)"
              value={draft.input.ticketId}
              disabled={draft.phase !== "editing"}
              onChange={(id) => controller.edit(draft.id, { ...draft.input, ticketId: id })}
            />
            <Field
              label="Complete source file"
              type="file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file)
                  controller.edit(
                    draft.id,
                    {
                      ...draft.input,
                      filename: file.name,
                      mimeType: file.type || "application/octet-stream",
                    },
                    file,
                  );
              }}
            />
          </fieldset>
          {draft.file && (
            <p className="rs-notice">
              {draft.file.name} · {resourceSize(String(draft.file.size))}
            </p>
          )}
          <p role="status" className="rs-notice">
            {draft.phase === "editing"
              ? "Ready to stage once a file is selected"
              : draft.phase === "staging"
                ? "Copying file to temporary storage…"
                : draft.phase === "interrupted"
                  ? "Staging interrupted — your selected file is retained for retry"
                  : draft.phase === "sealed"
                    ? "File staged and verified — ready to prepare"
                    : draft.phase === "preparing"
                      ? "Saving upload details…"
                      : "Upload prepared — inspect it below to publish"}{" "}
            · {resourceSize(String(draft.received))} staged
          </p>
          {draft.issue && <p role="alert">{draft.issue}</p>}
          <Toolbar label="Native upload editor actions">
            <Button
              disabled={!(draft.phase === "editing" || draft.phase === "interrupted")}
              onClick={() => {
                void controller.stage(draft.id);
              }}
            >
              Stage file
            </Button>
            <Button
              disabled={draft.phase !== "staging"}
              onClick={() => controller.cancelStaging(draft.id)}
            >
              Stop waiting for staging
            </Button>
            <Button
              disabled={draft.phase !== "sealed"}
              onClick={() => {
                void controller.prepare(draft.id);
              }}
            >
              Prepare upload
            </Button>
            <Button
              disabled={draft.phase === "staging" || draft.phase === "preparing"}
              onClick={() => controller.close(draft.id)}
            >
              Close upload editor
            </Button>
            {draft.phase === "prepared" && (
              <Button
                onClick={() => {
                  inspect(draft.id);
                }}
              >
                Review prepared upload
              </Button>
            )}
          </Toolbar>
          <p className="wg-hint">
            Staging and preparing do not publish the resource. Closing this editor keeps saved
            transfer files. Use Temporary files below to remove unprepared copies you no longer
            need.
          </p>
        </ResourceSection>
      )}
      <details
        className="rs-transfer-library"
        open={!draft || draft.phase === "prepared" || undefined}
      >
        <summary>Saved transfers and temporary files</summary>
        <p className="wg-hint">
          Resume an upload, check whether it completed, or clear files that were staged but never
          prepared. This inventory belongs to the connected UI service and can include other
          workspaces.
        </p>
        <Toolbar label="Native transfer inventory">
          <Button
            onClick={() => {
              void controller.inventory();
            }}
            disabled={state.loading}
          >
            Refresh transfer list
          </Button>
        </Toolbar>
        {state.loading && <p role="status">Loading saved transfers…</p>}
        {state.jobs && (
          <Panel title="Saved transfers">
            <p className="wg-hint">
              Prepared uploads can be resumed here. {state.jobs.remaining} more records are
              available beyond this page. Refresh to check for changes.
            </p>
            {state.jobs.items.length === 0 && (
              <p>
                No uploads in this saved list. Prepare a file above, or refresh the list to include
                newly prepared transfers.
              </p>
            )}
            {state.jobs.items.map((item) => (
              <p key={item.intention_id}>
                <Button
                  onClick={() => {
                    inspect(item.intention_id);
                  }}
                >
                  {item.intention_id}
                </Button>{" "}
                · {phaseLabel(item.phase)}
              </p>
            ))}
            {state.jobs.next_offset && (
              <Button
                onClick={() => {
                  void controller.inventory(state.jobs!.next_offset!);
                }}
              >
                Next saved uploads
              </Button>
            )}
          </Panel>
        )}
        {job && hiddenJob !== job.intention_id && (
          <Panel
            title="Selected transfer"
            actions={
              <Badge tone={job.phase.kind === "published" ? "accent" : "warning"}>
                {phaseLabel(job.phase)}
              </Badge>
            }
          >
            <Button tone="quiet" onClick={() => setHiddenJob(job.intention_id)}>
              Close transfer details
            </Button>
            <p className="wg-hint">
              Connection {field("id") ?? "unknown"} version {field("generation") ?? "unknown"} ·
              workspace {workspace ?? "unknown"} · local revision {job.revision}
            </p>
            {job.phase.kind === "outcome_unknown" || job.phase.kind === "rejected" ? (
              <p role="alert">
                {job.phase.problem.kind}: {job.phase.problem.message}
              </p>
            ) : null}
            {published && (
              <>
                <p>
                  File published: <strong>{published.publication.data.resource_id}</strong> saved
                  version
                  {published.publication.data.version.revision}.
                </p>
                {published.link.kind === "unresolved" && (
                  <p role="status">
                    Optional ticket link{" "}
                    {published.link.problem
                      ? `failed or remains unresolved: ${published.link.problem.kind}: ${published.link.problem.message}`
                      : "has no committed receipt yet"}
                    . The publication is independently committed. No new link or refreshed guard is
                    generated automatically.
                  </p>
                )}
                {field("id") && field("generation") && workspace && (
                  <Button
                    onClick={() =>
                      context.navigate(
                        resourceRoute({
                          connectionId: field("id")!,
                          generation: field("generation")!,
                          workspaceId: workspace,
                          resourceId: published.publication.data.resource_id,
                          content: {
                            version: published.publication.data.version.revision,
                            expectedDigest: published.publication.data.version.digest,
                          },
                        }),
                      )
                    }
                  >
                    Open published resource
                  </Button>
                )}
              </>
            )}
            {job.diagnostic && (
              <p role="status">
                Local cleanup/observation diagnostic: {job.diagnostic.kind}:{" "}
                {job.diagnostic.message}. This does not negate a previously verified publication.
              </p>
            )}
            <Toolbar label="Saved native upload actions">
              {job.phase.kind === "local_save_incomplete" && (
                <Button
                  onClick={() => {
                    void controller.finishSaving(job.intention_id);
                  }}
                >
                  Finish saving exact upload
                </Button>
              )}
              <Button
                onClick={() => {
                  inspect(job.intention_id);
                }}
              >
                Refresh transfer status
              </Button>
              <Button
                disabled={job.phase.kind !== "prepared_unsent"}
                onClick={() => {
                  void controller.act(job.intention_id, "start");
                }}
              >
                Publish file
              </Button>
              <Button
                disabled={
                  job.phase.kind !== "outcome_unknown" &&
                  !(job.phase.kind === "published" && job.phase.link.kind === "unresolved")
                }
                onClick={() => {
                  void controller.act(job.intention_id, "retry-exact");
                }}
              >
                Retry this saved upload
              </Button>
              <Button
                disabled={
                  job.phase.kind === "running" || job.phase.kind === "local_save_incomplete"
                }
                onClick={() => {
                  void controller.act(job.intention_id, "recover");
                }}
              >
                Check completion
              </Button>
            </Toolbar>
            <p className="wg-hint">
              Publish makes the prepared file available. Check completion only looks for a recorded
              result; it never publishes. If the outcome is unknown, retry this saved upload rather
              than creating another one. Closing the window does not cancel a started upload.
            </p>
          </Panel>
        )}
        {state.stages && (
          <Panel title="Temporary files">
            <p className="wg-hint">
              {state.stages.incoming_count} unprepared files ·{" "}
              {resourceSize(state.stages.retained_bytes)} stored. Cleanup removes only an unprepared
              temporary copy; it never deletes a published resource. Prepared or uncertain uploads
              retain their input for recovery.
            </p>
            {state.stages.items.length === 0 && <p>No staged inputs.</p>}
            {state.stages.items.map((item) => (
              <div key={item.stage_id} className="rs-stage">
                <code>{item.stage_id}</code> · {item.status} · {item.received}/{item.size_bytes}{" "}
                bytes · {item.source_retained ? "source retained" : "source cleaned"}
                {item.intention_id ? ` · saved ${item.intention_id}` : ""}
                {item.diagnostic && (
                  <p>
                    {item.diagnostic.kind}: {item.diagnostic.message}
                  </p>
                )}
                <Button
                  disabled={item.intention_id !== null || item.status === "abandoned"}
                  onClick={() => {
                    void controller.abandon(item.stage_id);
                  }}
                >
                  Remove temporary file
                </Button>
              </div>
            ))}
            {state.stages.next_offset && (
              <Button
                onClick={() => {
                  void controller.inventory(undefined, state.stages!.next_offset!);
                }}
              >
                Next staged inputs
              </Button>
            )}
          </Panel>
        )}
      </details>
    </section>
  );
}
