import { Dialog } from "../../../components/Dialog";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { useSyncExternalStore } from "react";
import { Button, Field, Select, Toolbar } from "../../../components/Primitives";
import { OperationPanel } from "../../connections/shared";
import { ManagementPresentation } from "../../connections/management-presentation";
import { ReferencePicker } from "../../discussions/ReferencePicker";
import type { FeatureContext } from "../../../app/types";
import type { OperationController } from "../../../core/state/operations";
import type { ResourceDraftController, ResourceEditInput, ResourceEditDraft } from "./drafts";
import { ResourceSection } from "./ResourceDesign";
function editorTitle(draft: ResourceEditDraft): string {
  switch (draft.kind) {
    case "text":
      return draft.base ? "Edit document" : "New document";
    case "metadata":
      return "Edit resource details";
    case "archive":
      return "Archive or restore resource";
    case "link":
      return "Link resource to work";
    case "unlink":
      return "Remove a resource link";
  }
}
export function ResourceEditor({
  context,
  controller,
  operations,
}: {
  readonly context: FeatureContext;
  readonly controller: ResourceDraftController;
  readonly operations: OperationController;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.get);
  const draft = state.drafts.find((d) => d.id === state.selectedId);
  if (state.unexpected) throw state.unexpected.error;
  if (draft?.unexpected) throw draft.unexpected.error;
  const edit = (input: ResourceEditInput) => {
    if (draft) controller.edit(draft.id, input);
  };
  return (
    <section aria-label="Resource editors" className="rs-editors">
      {state.issue && <p role="alert">{state.issue}</p>}
      {state.drafts.length > 0 && (
        <details className="rs-draft-list">
          <summary>Unfinished editors · {state.drafts.length}</summary>
          <p>
            Resume work from this browser session. Closing a window keeps its draft; discarding
            removes the editor, not a saved resource.
          </p>
          <div className="rs-draft-rows">
            {state.drafts.map((entry) => (
              <div key={entry.id}>
                <span>
                  <strong>
                    {entry.input.title || entry.input.resourceId || "Untitled resource"}
                  </strong>
                  <small>
                    {editorTitle(entry)} ·{" "}
                    {entry.phase === "editing"
                      ? "Unsaved changes"
                      : entry.phase === "saving"
                        ? "Saving…"
                        : "Operation recorded"}
                  </small>
                </span>
                <Button onClick={() => controller.choose(entry.id)}>Resume</Button>
                <Button
                  disabled={entry.phase === "saving"}
                  onClick={() => controller.discard(entry.id)}
                >
                  {operations.get(entry.id) ? "Close editor" : "Discard"}
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}
      {draft && (
        <Dialog wide title={editorTitle(draft)} onClose={() => controller.choose(null)}>
          <div className="rs-editor-content">
            <div className="rs-writer">
              <ActorAvatar actor={draft.writer.actorId} />
              <span>
                Saving as <strong>{draft.writer.actorId}</strong> in{" "}
                <strong>{draft.scope.workspaceId}</strong>. This editor keeps that identity if you
                switch actors.
              </span>
            </div>
            <fieldset disabled={draft.phase !== "editing"}>
              {draft.kind === "text" && (
                <>
                  <ResourceSection
                    title="Document details"
                    description={
                      draft.base
                        ? "Saving creates a new version of this document. Previous versions remain available in History."
                        : "Create a shared document for notes, plans or findings. After saving, link it to the work it supports."
                    }
                  >
                    <div className="rs-fields">
                      <Field
                        label="Title"
                        hint="A clear name people will recognize in the resource library."
                        value={draft.input.title}
                        onChange={(e) => edit({ ...draft.input, title: e.target.value })}
                      />
                      <Field
                        label="Resource ID"
                        hint="A stable, unique ID. Use letters, numbers, hyphens or underscores."
                        readOnly={draft.base !== null}
                        value={draft.input.resourceId}
                        onChange={(e) => edit({ ...draft.input, resourceId: e.target.value })}
                      />
                      <Field
                        label="Filename"
                        hint="The download name, including an extension such as .md or .json."
                        value={draft.input.filename}
                        onChange={(e) => edit({ ...draft.input, filename: e.target.value })}
                      />
                      <Field
                        label="MIME type"
                        hint="Tells the viewer how to display the file. For Markdown, use text/markdown."
                        value={draft.input.mimeType}
                        onChange={(e) => edit({ ...draft.input, mimeType: e.target.value })}
                      />
                    </div>
                  </ResourceSection>
                  <ResourceSection
                    title="Write your document"
                    icon="work"
                    tone="green"
                    description="Markdown supports headings, lists, links and code blocks. This editor saves UTF-8 text up to 64 KiB; use Upload file for larger documents."
                  >
                    <label className="wg-field">
                      Document
                      <textarea
                        aria-label="Resource document"
                        rows={14}
                        value={draft.input.text}
                        onChange={(e) => edit({ ...draft.input, text: e.target.value })}
                      />
                    </label>
                    <p className="wg-hint">
                      {new TextEncoder().encode(draft.input.text).length.toLocaleString()} of 65,536
                      bytes
                    </p>
                  </ResourceSection>
                </>
              )}
              {draft.kind === "metadata" && (
                <ResourceSection
                  title="Change how this resource is described"
                  icon="settings"
                  description="Select the fields you want to change. Saving updates the resource details; the saved file and its version history stay intact."
                >
                  <div className="rs-fields">
                    {(
                      [
                        ["title", "Title"],
                        ["filename", "Filename"],
                        ["mimeType", "MIME type"],
                        ["description", "Description"],
                      ] as const
                    ).map(([key, label]) => (
                      <div className="rs-edit-choice" key={key}>
                        <label className="rs-check">
                          <input
                            type="checkbox"
                            checked={draft.input.changes[key]}
                            onChange={(e) =>
                              edit({
                                ...draft.input,
                                changes: { ...draft.input.changes, [key]: e.target.checked },
                              })
                            }
                          />
                          Change {label.toLowerCase()}
                        </label>
                        {key === "description" ? (
                          <label className="wg-field">
                            {label}
                            <textarea
                              aria-label={label}
                              disabled={!draft.input.changes[key]}
                              rows={4}
                              value={draft.input[key]}
                              onChange={(e) => edit({ ...draft.input, [key]: e.target.value })}
                            />
                          </label>
                        ) : (
                          <Field
                            label={label}
                            disabled={!draft.input.changes[key]}
                            value={draft.input[key]}
                            onChange={(e) => edit({ ...draft.input, [key]: e.target.value })}
                          />
                        )}
                        <p className="wg-hint">
                          {key === "description"
                            ? "Explain what this resource is for. An empty value clears the description."
                            : key === "filename"
                              ? "Changes the default filename for future downloads."
                              : key === "mimeType"
                                ? "Describes the file format; it does not convert the file contents."
                                : "Changes the display name in the library."}
                        </p>
                      </div>
                    ))}
                  </div>
                </ResourceSection>
              )}
              {(draft.kind === "link" || draft.kind === "unlink") && (
                <ResourceSection
                  title={
                    draft.kind === "link"
                      ? "Where does this resource belong?"
                      : "Which link should be removed?"
                  }
                  icon="workflow"
                  tone="purple"
                  description={
                    draft.kind === "link"
                      ? "A link makes this resource discoverable alongside a project, ticket or other record. It does not copy the file or create a ticket dependency."
                      : "Remove an association with a record. The resource, its versions and the linked record are kept."
                  }
                >
                  {draft.kind === "unlink" && (
                    <div className="rs-link-choices">
                      {draft.base?.value.metadata.targets.map((target) => (
                        <Button
                          key={JSON.stringify(target)}
                          aria-pressed={
                            draft.input.target.kind === target.kind &&
                            (target.kind === "workspace" || draft.input.target.id === target.id)
                          }
                          onClick={() =>
                            edit({
                              ...draft.input,
                              target: {
                                kind: target.kind,
                                id: target.kind === "workspace" ? "" : target.id,
                              },
                            })
                          }
                        >
                          {target.kind} ·{" "}
                          {target.kind === "workspace" ? draft.scope.workspaceId : target.id}
                        </Button>
                      ))}
                    </div>
                  )}
                  <div className="rs-fields">
                    <Select
                      label="Association type"
                      value={draft.input.target.kind}
                      onChange={(e) => {
                        const kind = e.target.value;
                        if (
                          kind === "workspace" ||
                          kind === "project" ||
                          kind === "milestone" ||
                          kind === "ticket" ||
                          kind === "resource"
                        )
                          edit({ ...draft.input, target: { kind, id: "" } });
                      }}
                    >
                      {["workspace", "project", "milestone", "ticket", "resource"].map((k) => (
                        <option key={k} value={k}>
                          {k[0]?.toUpperCase()}
                          {k.slice(1)}
                        </option>
                      ))}
                    </Select>
                    {draft.input.target.kind !== "workspace" ? (
                      <ReferencePicker
                        context={context}
                        endpoint={{
                          connectionId: draft.scope.connection.id,
                          generation: draft.scope.connection.generation,
                          workspaceId: draft.scope.workspaceId,
                        }}
                        kind={draft.input.target.kind}
                        label="Association ID"
                        value={draft.input.target.id}
                        disabled={draft.phase !== "editing"}
                        onChange={(id) =>
                          edit({ ...draft.input, target: { ...draft.input.target, id } })
                        }
                      />
                    ) : (
                      <p>
                        Link applies to the whole <strong>{draft.scope.workspaceId}</strong>{" "}
                        workspace.
                      </p>
                    )}
                  </div>
                </ResourceSection>
              )}
              {draft.kind === "archive" && (
                <ResourceSection
                  title="Choose where this resource appears"
                  icon="archive"
                  tone="orange"
                  description="Archiving hides a resource from the default library. Its content, previous versions and existing links remain available. Restore it whenever you need it again."
                >
                  <label className="rs-choice">
                    <input
                      type="radio"
                      name={`archive-${draft.id}`}
                      checked={draft.input.archived}
                      onChange={() => edit({ ...draft.input, archived: true })}
                    />
                    <span>
                      <strong>Archive resource</strong>
                      <small>Find it again using Include archived in the library.</small>
                    </span>
                  </label>
                  <label className="rs-choice">
                    <input
                      type="radio"
                      name={`archive-${draft.id}`}
                      checked={!draft.input.archived}
                      onChange={() => edit({ ...draft.input, archived: false })}
                    />
                    <span>
                      <strong>Keep in the active library</strong>
                      <small>Restore an archived resource so it appears in normal browsing.</small>
                    </span>
                  </label>
                </ResourceSection>
              )}
            </fieldset>
            {draft.issue && (
              <p role="status" className="rs-notice">
                {draft.issue}
              </p>
            )}
            <Toolbar label="Resource edit actions">
              <Button
                tone="primary"
                disabled={draft.phase !== "editing"}
                onClick={() => {
                  void controller.save(draft.id);
                }}
              >
                {draft.kind === "text"
                  ? "Save document"
                  : draft.kind === "archive"
                    ? draft.input.archived
                      ? "Archive resource"
                      : "Restore resource"
                    : "Save changes"}
              </Button>
              <Button
                disabled={draft.phase !== "editing"}
                onClick={() => {
                  void controller.save(draft.id, false);
                }}
              >
                Review before saving
              </Button>
              <Button
                disabled={draft.phase === "saving"}
                onClick={() => controller.discard(draft.id)}
              >
                {operations.get(draft.id) ? "Close editor; keep operation" : "Discard draft"}
              </Button>
            </Toolbar>
            <p className="wg-hint">
              Save applies your changes. Review prepares them for inspection before you apply them.
              Closing this window keeps the editor for this browser session.
            </p>
            {operations.get(draft.id) && (
              <ManagementPresentation value={true}>
                <OperationPanel
                  operations={operations}
                  intention={draft.id}
                  processing={context.client.processing}
                />
              </ManagementPresentation>
            )}
          </div>
        </Dialog>
      )}
    </section>
  );
}
