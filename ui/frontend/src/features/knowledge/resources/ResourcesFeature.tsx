import { useActorGate } from "../../../components/ActorAccess";
import { Dialog } from "../../../components/Dialog";
import { Icon } from "../../../components/Icon";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { RecordedTime } from "../../discussions/RecordedTime";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Badge, Button, Field, StatePanel, Toolbar } from "../../../components/Primitives";
import { ContentViewer } from "../../../content";
import * as d from "../../../core/protocol/decoders";
import type { ConnectionProfile } from "../../../core/protocol/types";
import type { ReadState } from "../../../core/state/read-slot";
import { failureText } from "../../connections/failure";
import { ResourceSection } from "./ResourceDesign";
import { resourceSize, resourceKind } from "./presentation";
import type {
  ResourceCapture,
  ResourceRecord,
  ResourceScope,
  ResourceSelection,
  ResourcesFeatureProps,
} from "./types";
import type { ResourceDraftController } from "./drafts";
import { ResourceEditor } from "./ResourceEditor";
import { resourceRoute } from "./navigation";
import "./resources.css";
import { ResourceUploads } from "./ResourceUploads";
import type { ResourceUploadController } from "./upload-types";
function current<T>(value: ReadState<T>): T | undefined {
  return value.kind === "ready" ? value.value : value.kind === "idle" ? undefined : value.previous;
}
function ReadStatus<T>({ state }: { readonly state: ReadState<T> }) {
  if (state.kind === "unexpected_error") throw state.error;
  return state.kind === "loading" && state.previous === undefined ? (
    <p role="status">Loading captured records…</p>
  ) : state.kind === "failed" ? (
    <p role="alert">
      {failureText(state.failure)}
      {state.previous ? " Previous capture retained." : ""}
    </p>
  ) : null;
}
export function ResourcesFeature({
  context,
  controller,
  operations,
  drafts,
  uploads,
  renderContent,
}: ResourcesFeatureProps & {
  readonly drafts: ResourceDraftController;
  readonly uploads: ResourceUploadController;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.get);
  const generation = context.route.resource?.generation ?? context.connection.generation;
  const profileKey = JSON.stringify([context.route.connectionId, generation]);
  const [profile, setProfile] = useState<{
    readonly key: string;
    readonly value: ConnectionProfile | null;
    readonly issue: string | null;
    readonly unexpected?: { readonly error: unknown };
  } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void context.client
      .request({
        method: "GET",
        path: `/connections/${encodeURIComponent(context.connection.id)}/generations/${encodeURIComponent(generation)}`,
        codec: d.connectionProfile,
        signal: abort.signal,
      })
      .then((result) => {
        if (!abort.signal.aborted)
          setProfile({
            key: profileKey,
            value: result.ok ? result.data : null,
            issue: result.ok ? null : failureText(result.failure),
          });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setProfile({ key: profileKey, value: null, issue: null, unexpected: { error } });
      });
    return () => abort.abort();
  }, [context.client, context.connection.id, generation, profileKey]);
  const retained = profile?.key === profileKey ? profile : null;
  const workspace = context.route.workspaceId;
  const retainedValue = retained?.value;
  const scope = useMemo<ResourceScope | null>(() => {
    if (!retainedValue || !workspace) return null;
    const decoded = d.identifier.decode(d.jsonString(workspace));
    return decoded.ok ? { connection: retainedValue, workspaceId: decoded.value } : null;
  }, [retainedValue, workspace]);
  const project = context.route.projectId;
  useEffect(() => {
    if (!scope) return;
    const target = project === null ? undefined : d.identifier.decode(d.jsonString(project));
    if (target && !target.ok) return;
    void controller.directory(
      scope,
      target?.ok ? { target: { kind: "project", id: target.value } } : {},
    );
    return () => controller.cancelDownload();
  }, [controller, scope, project]);
  const entity = context.route.entityId,
    version = context.route.resource?.content?.version ?? null,
    expectedDigest = context.route.resource?.content?.expectedDigest ?? null;
  const directoryKey = JSON.stringify([profileKey, workspace, project]);
  const selectionKey = JSON.stringify([directoryKey, entity]);
  const [filter, setFilter] = useState({ key: directoryKey, text: "" });
  const filterText = filter.key === directoryKey ? filter.text : "";
  const [panel, setPanel] = useState<{ key: string; kind: "details" | "history" } | null>(null);
  const selectedPanel = panel?.key === selectionKey ? panel.kind : null;
  const [transfersOpen, setTransfersOpen] = useState(false);
  useEffect(() => {
    if (!scope || !entity) return;
    const id = d.identifier.decode(d.jsonString(entity)),
      v = version === null ? null : d.positiveDecimal.decode(d.jsonString(version)),
      sha = expectedDigest === null ? null : d.digest.decode(d.jsonString(expectedDigest));
    if (!id.ok || (v && !v.ok) || (sha && !sha.ok)) return;
    const selection: ResourceSelection = {
      ...scope,
      resourceId: id.value,
      content: v?.ok ? { version: v.value, expectedDigest: sha?.ok ? sha.value : null } : null,
    };
    void controller.select(selection);
  }, [controller, scope, entity, version, expectedDigest]);
  const [downloadIssue, setDownloadIssue] = useState<{
    readonly key: string;
    readonly message: string;
  } | null>(null);
  const [unexpected, setUnexpected] = useState<{
    readonly key: string;
    readonly error: unknown;
  } | null>(null);
  if (state.unexpected) throw state.unexpected.error;
  if (retained?.unexpected) throw retained.unexpected.error;
  const candidate = state.content;
  const ownsContent =
    scope !== null &&
    candidate.kind !== "idle" &&
    (() => {
      const target = candidate.kind === "verified" ? candidate.pin : candidate.selection;
      return (
        target.connection.id === scope.connection.id &&
        target.connection.generation === scope.connection.generation &&
        target.connection.socket === scope.connection.socket &&
        target.workspaceId === scope.workspaceId &&
        target.resourceId === entity &&
        (candidate.kind === "verified"
          ? version === null ||
            (candidate.pin.version === version &&
              (expectedDigest === null || candidate.pin.digest === expectedDigest))
          : (candidate.selection.content?.version ?? null) === version &&
            (candidate.selection.content?.expectedDigest ?? null) === expectedDigest)
      );
    })();
  const content = ownsContent ? candidate : { kind: "idle" as const },
    contentKey = content.kind === "verified" ? content.source.key : "";
  if (unexpected?.key === contentKey) throw unexpected.error;
  const directoryCandidate = current(state.directory);
  const list =
    scope &&
    directoryCandidate &&
    directoryCandidate.scope.connection.id === scope.connection.id &&
    directoryCandidate.scope.connection.generation === scope.connection.generation &&
    directoryCandidate.scope.connection.socket === scope.connection.socket &&
    directoryCandidate.scope.workspaceId === scope.workspaceId &&
    (project === null
      ? state.directoryTarget === null
      : state.directoryTarget?.kind === "project" && state.directoryTarget.id === project)
      ? directoryCandidate
      : undefined;
  const metadata = current(state.metadata),
    versions = ownsContent ? current(state.versions) : undefined;
  const matching = (capture: ResourceCapture<ResourceRecord> | undefined) =>
    capture &&
    scope &&
    capture.scope.connection.id === scope.connection.id &&
    capture.scope.connection.generation === scope.connection.generation &&
    capture.scope.workspaceId === scope.workspaceId &&
    capture.value.resource_id === entity
      ? capture
      : undefined;
  const selected = matching(metadata);
  const writable =
    scope !== null &&
    context.profileState === "current" &&
    scope.connection.generation === context.connection.generation &&
    scope.connection.socket === context.connection.socket;
  const allowNewAction = useActorGate();
  const open = (kind: Parameters<ResourceDraftController["open"]>[2]) => {
    if (!allowNewAction()) return;
    setPanel(null);
    if (scope) void drafts.open(context, scope, kind, selected);
  };
  const select = (resourceId: string, v: string | null = null, sha: string | null = null) => {
    if (scope)
      context.navigate({
        ...resourceRoute({
          connectionId: scope.connection.id,
          generation: scope.connection.generation,
          workspaceId: scope.workspaceId,
          resourceId,
          content: v === null ? null : { version: v, expectedDigest: sha },
        }),
        projectId: context.route.projectId,
      });
  };
  const download = () => {
    if (content.kind !== "verified") return;
    let url: string | null = null;
    try {
      url = URL.createObjectURL(content.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = content.pin.filename;
      a.click();
      const captured = url;
      setTimeout(() => URL.revokeObjectURL(captured), 1000);
      setDownloadIssue({
        key: contentKey,
        message: "Your complete, verified file is ready to download.",
      });
    } catch (error) {
      if (url) URL.revokeObjectURL(url);
      if (error instanceof DOMException)
        setDownloadIssue({ key: contentKey, message: `Download unavailable: ${error.message}` });
      else setUnexpected({ key: contentKey, error });
    }
  };
  return (
    <section
      className="rs-workspace"
      aria-label="Resources workspace"
      data-selected={entity !== null}
    >
      {state.updateIssue && (
        <p role="status" className="wg-hint">
          Latest content could not be loaded: {state.updateIssue} Showing the last verified version;
          updates will retry.
        </p>
      )}
      <header className="rs-heading">
        <h1>
          <Icon name="resources" /> Resources
        </h1>
        {list && (
          <span className="rs-page-count">{list.value.items.length} resources on this page</span>
        )}
        <Toolbar label="Resource directory actions">
          <Button
            disabled={!scope}
            onClick={() => {
              if (scope)
                void controller.directory(scope, {
                  ...(state.directoryTarget ? { target: state.directoryTarget } : {}),
                  includeArchived: state.includeArchived,
                });
            }}
          >
            <Icon name="refresh" /> Refresh library
          </Button>
          <Button
            tone="primary"
            requiresActor
            disabled={!writable}
            onClick={() => {
              if (scope) void drafts.open(context, scope, "text");
            }}
          >
            <Icon name="plus" /> New document
          </Button>
          <Button
            requiresActor
            disabled={!writable}
            onClick={() => {
              if (scope) {
                uploads.open(context, scope);
                setTransfersOpen(true);
                void uploads.inventory();
              }
            }}
          >
            <Icon name="resources" /> Upload file
          </Button>
          <Button
            tone="quiet"
            onClick={() => {
              setTransfersOpen(true);
              void uploads.inventory();
            }}
          >
            Transfers
          </Button>
        </Toolbar>
      </header>
      {!retained ? (
        <StatePanel kind="loading" title="Connecting to your resource library">
          Loading this workspace’s saved documents and files.
        </StatePanel>
      ) : retained.issue ? (
        <StatePanel kind="error" title="Exact resource connection unavailable">
          {retained.issue} Current-generation content was not substituted.
        </StatePanel>
      ) : !scope ? (
        <StatePanel kind="empty" title="Choose a workspace">
          Select a workspace to browse resources.
        </StatePanel>
      ) : (
        <>
          {generation !== context.connection.generation && (
            <p role="status">
              Viewing retained connection generation {generation}; new edits require the matching
              current profile.
            </p>
          )}
          <div className="rs-orientation">
            <Icon name="resources" />
            <div>
              <strong>Documents and files, connected to your work</strong>
              <p>
                Keep plans, research, code and evidence here. Link a resource to a project or
                ticket, browse earlier versions, or download the original file.
              </p>
            </div>
          </div>
          {!writable && (
            <p className="rs-notice">
              Creating or changing resources will open the actor chooser first. You can still browse
              and download.
            </p>
          )}
          <div className="rs-grid">
            <aside aria-label="Resource directory" className="rs-directory">
              <div className="rs-directory-controls">
                <h2>Resource library</h2>
                <Field
                  label="Find in this page"
                  placeholder="Search title, filename or ID…"
                  value={filterText}
                  onChange={(event) =>
                    setFilter({ key: directoryKey, text: event.currentTarget.value })
                  }
                />
                <p className="rs-scope">
                  {project ? `Project · ${project}` : "All workspace resources"}
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={state.includeArchived}
                    onChange={(e) => {
                      void controller.directory(scope, {
                        includeArchived: e.target.checked,
                        ...(state.directoryTarget ? { target: state.directoryTarget } : {}),
                      });
                    }}
                  />{" "}
                  Include archived
                </label>
              </div>
              <ReadStatus state={state.directory} />
              {list && (
                <>
                  <p className="rs-capture">
                    {list.partial
                      ? "Some details could not be loaded"
                      : `${list.value.items.length} resources on this page`}{" "}
                    · {list.value.remaining} more
                  </p>
                  <ul className="rs-list">
                    {list.value.items
                      .filter((item) =>
                        `${item.metadata.title} ${item.resource_id} ${item.metadata.filename}`
                          .toLocaleLowerCase()
                          .includes(filterText.toLocaleLowerCase()),
                      )
                      .map((item) => (
                        <li key={item.resource_id}>
                          <Button
                            className={item.resource_id === entity ? "rs-selected" : ""}
                            aria-pressed={item.resource_id === entity}
                            onClick={() => select(item.resource_id)}
                          >
                            <strong>
                              <Icon name="resources" />
                              {item.metadata.title || item.resource_id}
                            </strong>
                            <span className="rs-row-tags">
                              <span
                                data-kind={resourceKind(
                                  item.metadata.mime_type,
                                  item.metadata.filename,
                                )}
                              >
                                {resourceKind(item.metadata.mime_type, item.metadata.filename)}
                              </span>
                              <small>
                                v{item.current_version.revision} ·{" "}
                                {resourceSize(item.current_version.size_bytes)}
                              </small>
                              {item.metadata.archived && <Badge tone="warning">Archived</Badge>}
                            </span>
                            <span className="rs-row-footer">
                              <ActorAvatar actor={item.current_version.actor_id} />
                              <small>{item.current_version.actor_id}</small>
                              <RecordedTime value={item.current_version.timestamp} />
                            </span>
                          </Button>
                        </li>
                      ))}
                  </ul>
                  {list.value.items.length === 0 && (
                    <div className="rs-empty">
                      <Icon name="resources" />
                      <strong>No resources here yet</strong>
                      <p>
                        Create a document or upload a file, then link it to this project. Archived
                        resources appear when Include archived is selected.
                      </p>
                    </div>
                  )}
                  {filterText &&
                    !list.value.items.some((item) =>
                      `${item.metadata.title} ${item.resource_id} ${item.metadata.filename}`
                        .toLocaleLowerCase()
                        .includes(filterText.toLocaleLowerCase()),
                    ) && <p className="rs-capture">No matches on this loaded page.</p>}
                  <Toolbar label="Resource directory pages">
                    <Button
                      aria-label="Previous resources page"
                      disabled={
                        state.directoryPreviousOffsets.length === 0 ||
                        state.directory.kind === "loading"
                      }
                      onClick={() => {
                        void controller.previousDirectory();
                      }}
                    >
                      Previous
                    </Button>
                    <span className="wg-hint">
                      Page {state.directoryPreviousOffsets.length + 1}
                    </span>
                    <Button
                      aria-label="Next resources page"
                      disabled={
                        list.value.next_offset === null || state.directory.kind === "loading"
                      }
                      onClick={() => {
                        void controller.nextDirectory();
                      }}
                    >
                      Next
                    </Button>
                  </Toolbar>
                </>
              )}
            </aside>
            <section className="rs-reader" aria-label="Resource content">
              {entity !== null && (
                <Button
                  className="rs-directory-toggle"
                  tone="quiet"
                  onClick={() => {
                    const route = { ...context.route, entityId: null };
                    delete route.resource;
                    context.navigate(route);
                  }}
                >
                  ← All resources
                </Button>
              )}
              {!entity ? (
                <StatePanel kind="empty" title="Choose a resource">
                  Choose a document from the library to read it here. Resources keep a history of
                  saved versions, so you can revisit earlier work without losing the latest copy.
                </StatePanel>
              ) : (
                <>
                  <ReadStatus state={state.metadata} />
                  {selected && (
                    <header className="rs-document-heading">
                      <span className="rs-document-kind">
                        <Icon name="resources" />
                        {content.kind === "verified"
                          ? (content.source.hints.mime ?? content.pin.mimeType)
                          : selected.value.metadata.mime_type}
                      </span>
                      <h2>{selected.value.metadata.title || selected.value.resource_id}</h2>
                      <div className="rs-document-meta">
                        {content.kind === "verified" &&
                          selected.value.current_version.revision === content.pin.version && (
                            <>
                              <ActorAvatar actor={selected.value.current_version.actor_id} />
                              <span>{selected.value.current_version.actor_id}</span>
                              <RecordedTime value={selected.value.current_version.timestamp} />
                            </>
                          )}
                        <Badge tone={selected.value.metadata.archived ? "warning" : "accent"}>
                          {selected.value.metadata.archived ? "Archived" : "Published"}
                        </Badge>
                        <span>
                          {version === null
                            ? "Following latest content"
                            : `Pinned content v${version}`}
                        </span>
                        {content.kind === "verified" && (
                          <span>
                            Content v{content.pin.version} · {resourceSize(content.pin.sizeBytes)}
                          </span>
                        )}
                      </div>
                      {selected.value.metadata.description && (
                        <p className="rs-description">{selected.value.metadata.description}</p>
                      )}
                      {version !== null && (
                        <p className="rs-notice">
                          You’re viewing a saved version.{" "}
                          <Button tone="quiet" onClick={() => select(entity)}>
                            Return to latest version
                          </Button>
                        </p>
                      )}
                      <Toolbar label="Resource views">
                        <Button
                          aria-pressed={selectedPanel === null}
                          onClick={() => setPanel(null)}
                        >
                          Preview
                        </Button>
                        <Button
                          onClick={() => {
                            setPanel({ key: selectionKey, kind: "history" });
                            void controller.versions();
                          }}
                        >
                          <Icon name="history" /> History{" "}
                          <span>{selected.value.version_count}</span>
                        </Button>
                        <Button onClick={() => setPanel({ key: selectionKey, kind: "details" })}>
                          <Icon name="settings" /> Details & actions
                        </Button>
                      </Toolbar>
                    </header>
                  )}
                  {selected && selectedPanel === "details" && (
                    <Dialog wide title="Resource details & actions" onClose={() => setPanel(null)}>
                      <div className="rs-details-content">
                        <ResourceSection
                          title="About this resource"
                          description="A resource is a shared file or document. Its details describe it; its content versions preserve what was saved."
                        >
                          <dl className="rs-properties">
                            <div>
                              <dt>Resource ID</dt>
                              <dd>{selected.value.resource_id}</dd>
                            </div>
                            <div>
                              <dt>Filename</dt>
                              <dd>{selected.value.metadata.filename}</dd>
                            </div>
                            <div>
                              <dt>File format</dt>
                              <dd>{selected.value.metadata.mime_type}</dd>
                            </div>
                            <div>
                              <dt>Saved versions</dt>
                              <dd>{selected.value.version_count}</dd>
                            </div>
                          </dl>
                          <p>
                            {selected.value.metadata.description ||
                              "No description yet. Add one to help others understand when to use this resource."}
                          </p>
                          <Button
                            requiresActor
                            disabled={!writable || selected.partial}
                            onClick={() => open("metadata")}
                          >
                            <Icon name="settings" /> Edit details
                          </Button>
                        </ResourceSection>
                        <ResourceSection
                          title="Connected work"
                          description="Links place this resource alongside the work it supports. They do not duplicate its contents or block tickets."
                          icon="workflow"
                          tone="purple"
                        >
                          <div className="rs-link-choices">
                            {selected.value.metadata.targets.length === 0 ? (
                              <p>
                                No links yet. Connect this resource to a project, ticket or
                                milestone.
                              </p>
                            ) : (
                              selected.value.metadata.targets.map((t) => (
                                <span className="rs-link-chip" key={JSON.stringify(t)}>
                                  <Icon
                                    name={
                                      t.kind === "ticket"
                                        ? "work"
                                        : t.kind === "resource"
                                          ? "resources"
                                          : "workflow"
                                    }
                                  />
                                  <span>
                                    {t.kind}
                                    <strong>
                                      {t.kind === "workspace" ? scope.workspaceId : t.id}
                                    </strong>
                                  </span>
                                </span>
                              ))
                            )}
                          </div>
                          {project &&
                            !selected.value.metadata.targets.some(
                              (t) => t.kind === "project" && t.id === project,
                            ) && (
                              <p className="wg-hint">
                                This resource is not linked directly to the currently selected
                                project.
                              </p>
                            )}
                          <Toolbar label="Resource links">
                            <Button
                              requiresActor
                              disabled={!writable || selected.partial}
                              onClick={() => open("link")}
                            >
                              Add link
                            </Button>
                            <Button
                              disabled={
                                !writable ||
                                selected.partial ||
                                selected.value.metadata.targets.length === 0
                              }
                              onClick={() => open("unlink")}
                            >
                              Remove link
                            </Button>
                          </Toolbar>
                        </ResourceSection>
                        <ResourceSection
                          title="Content and availability"
                          description="Replacing a file creates a new saved version. Archiving hides it from the default library while keeping its content and history."
                          icon="history"
                          tone="green"
                        >
                          <Toolbar label="Selected resource actions">
                            <Button
                              requiresActor
                              disabled={!writable || selected.partial}
                              onClick={() => {
                                uploads.open(context, scope, selected);
                                setPanel(null);
                                setTransfersOpen(true);
                                void uploads.inventory();
                              }}
                            >
                              Upload new version
                            </Button>
                            <Button
                              onClick={() => {
                                setPanel({ key: selectionKey, kind: "history" });
                                void controller.versions();
                              }}
                            >
                              Published versions
                            </Button>
                            <Button
                              requiresActor
                              disabled={!writable || selected.partial}
                              onClick={() => open("archive")}
                            >
                              <Icon name="archive" />
                              {selected.value.metadata.archived
                                ? "Restore resource"
                                : "Archive resource"}
                            </Button>
                          </Toolbar>
                        </ResourceSection>
                      </div>
                    </Dialog>
                  )}
                  {selected?.partial && (
                    <p role="status" className="wg-hint">
                      Resource metadata is partial. Editing remains unavailable until a complete
                      metadata read.
                    </p>
                  )}
                  {selectedPanel === "history" && (
                    <Dialog wide title="Published versions" onClose={() => setPanel(null)}>
                      <ReadStatus state={state.versions} />
                      {versions && (
                        <>
                          <p className="rs-intro">
                            Each saved version is a snapshot of the file. Open one to read or
                            download it; this does not replace the latest version. Changes to the
                            title or description do not create a new content version.
                          </p>
                          {versions.value.items.map((v) => (
                            <div className="rs-version" key={v.revision}>
                              <ActorAvatar actor={v.actor_id} />
                              <div>
                                <Button
                                  onClick={() => {
                                    setPanel(null);
                                    select(entity, v.revision, v.digest);
                                  }}
                                >
                                  Open content v{v.revision}
                                </Button>{" "}
                                <p>
                                  {v.filename} · {resourceSize(v.size_bytes)} · {v.actor_id}
                                </p>
                                <RecordedTime value={v.timestamp} />
                              </div>
                            </div>
                          ))}
                          <Toolbar label="Published version pages">
                            <Button
                              aria-label="Previous versions page"
                              disabled={
                                state.versionPreviousOffsets.length === 0 ||
                                state.versions.kind === "loading"
                              }
                              onClick={() => {
                                void controller.previousVersions();
                              }}
                            >
                              Previous
                            </Button>
                            <span className="wg-hint">
                              Page {state.versionPreviousOffsets.length + 1}
                            </span>
                            <Button
                              aria-label="Next versions page"
                              disabled={
                                versions.value.next_offset === null ||
                                state.versions.kind === "loading"
                              }
                              onClick={() => {
                                void controller.nextVersions();
                              }}
                            >
                              Next
                            </Button>
                          </Toolbar>
                        </>
                      )}
                    </Dialog>
                  )}
                  {content.kind === "loading" && (
                    <StatePanel kind="loading" title="Opening your file">
                      <p>
                        {content.receivedBytes} / {content.totalBytes ?? "unknown"} bytes received.
                        The complete file is checked before it is displayed or downloaded.
                      </p>
                      <Button onClick={controller.cancelDownload}>Cancel download</Button>
                    </StatePanel>
                  )}
                  {content.kind === "failed" && (
                    <StatePanel kind="error" title="Could not open this file">
                      <p>
                        {content.message} {content.failure ? failureText(content.failure) : ""}
                      </p>
                      <Button
                        onClick={() => {
                          void controller.select(content.selection);
                        }}
                      >
                        Try again
                      </Button>
                    </StatePanel>
                  )}
                  {content.kind === "verified" && (
                    <div className="rs-publication">
                      <div className="rs-publication-tools">
                        <div className="rs-verified">
                          <Icon name="check" />
                          <span>File verified</span>
                          <span>{content.pin.filename}</span>
                        </div>
                        <Toolbar label="Verified publication actions">
                          <Button onClick={download}>Download verified file</Button>
                          <Button
                            requiresActor
                            disabled={
                              !writable ||
                              !selected ||
                              selected.partial ||
                              content.blob.size > 65536 ||
                              selected.value.current_version.revision !== content.pin.version
                            }
                            onClick={() => {
                              if (selected)
                                void drafts.open(context, scope, "text", selected, {
                                  blob: content.blob,
                                  version: content.pin.version,
                                });
                            }}
                          >
                            Edit document
                          </Button>
                        </Toolbar>
                      </div>

                      {content.blob.size > 65536 && (
                        <p className="wg-hint">
                          This file is larger than the 64 KiB text editor. Download it to edit
                          locally, then use Details & actions → Upload new version.
                        </p>
                      )}
                      {downloadIssue?.key === contentKey && (
                        <p role="status">{downloadIssue.message}</p>
                      )}
                      {renderContent ? (
                        renderContent({
                          pin: content.pin,
                          source: content.source,
                          blob: content.blob,
                        })
                      ) : (
                        <ContentViewer source={content.source} />
                      )}
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </>
      )}
      <ResourceEditor context={context} controller={drafts} operations={operations} />
      {transfersOpen && (
        <Dialog wide title="File transfers" onClose={() => setTransfersOpen(false)}>
          <ResourceUploads context={context} controller={uploads} />
        </Dialog>
      )}
    </section>
  );
}
