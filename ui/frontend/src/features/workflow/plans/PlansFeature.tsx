import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Badge, Button, StatePanel, Toolbar } from "../../../components/Primitives";
import { Dialog } from "../../../components/Dialog";
import { Icon } from "../../../components/Icon";
import { jsonField } from "../../../core/json";
import type { JsonObject } from "../../../core/protocol/types";
import { text } from "./schema";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { PlanGuide } from "./PlanGuide";
import { DraftEditor } from "./DraftEditor";
import { PlanInputError } from "./model";
import { DRAFT_CONTAINER_LIMITS } from "./container";
import type { PlansFeatureProps, PlansView } from "./types";
import "./plans.css";

export function PlansFeature({
  context,
  controller,
  operations,
  view,
  onView,
}: {
  readonly onView: (view: PlansView) => void;
} & PlansFeatureProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.get),
    [notice, setNotice] = useState(""),
    [removingId, setRemovingId] = useState<string | null>(null),
    [unexpected, setUnexpected] = useState<{ error: unknown } | null>(null),
    file = useRef<HTMLInputElement>(null);
  const scope = JSON.stringify([
      context.connection.id,
      context.connection.generation,
      context.route.workspaceId,
    ]),
    templatesMatch = state.templateScope === scope;
  const issue = (error: unknown) => {
    if (error instanceof PlanInputError || error instanceof DOMException) setNotice(error.message);
    else setUnexpected({ error });
  };
  const launch = (task: Promise<unknown>) => {
    void task.catch(issue);
  };
  useEffect(() => {
    if (
      view === "templates" &&
      context.profileState === "current" &&
      context.route.workspaceId !== null
    )
      void controller.loadTemplates(context);
    // Reads depend on exact connection/workspace, never the mutable acting identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, scope, controller, context.profileState]);
  if (unexpected) throw unexpected.error;
  if (state.unexpected) throw state.unexpected.error;
  const draft = state.drafts.find((draft) => draft.id === state.selectedId) ?? null;
  const editing = view === "drafts" && draft !== null;
  const removing = state.drafts.find((entry) => entry.id === removingId) ?? null;
  const exportDraft = (entry = draft) => {
    if (entry === null) return;
    launch(
      controller.exportDraft(entry.id).then((source) => {
        if (source === null) return;
        const url = URL.createObjectURL(new Blob([source], { type: "application/x-ndjson" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `${entry.id}.wg-plan.ndjson`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }),
    );
  };
  const imported = (selected: File) =>
    launch(
      (async () => {
        if (selected.size > DRAFT_CONTAINER_LIMITS.bytes)
          throw new PlanInputError("Recovery file exceeds 64 MiB; no editor was replaced.");
        const id = await controller.importDraft(await selected.text());
        if (id !== null) onView("drafts");
      })(),
    );
  const fresh = context.profileState === "current" && context.route.workspaceId !== null;
  return (
    <section className="plans-feature" aria-label="Workflow plans">
      <header className="plans-header">
        <div>
          <span className="work-eyebrow">WORKFLOW</span>
          <h2>{view === "templates" ? "Reusable templates" : "Workflow drafts"}</h2>
        </div>
      </header>
      {!editing && (
        <>
          <div className="workflow-intro" data-tone={view === "templates" ? "purple" : "blue"}>
            <Icon name={view === "templates" ? "resources" : "saved"} />
            <div>
              <h3>
                {view === "templates"
                  ? "Build once. Reuse the workflow."
                  : "Plan changes before they go live."}
              </h3>
              <p>
                {view === "templates"
                  ? "A template is a reusable blueprint for tickets, dependencies and review rules. Use a published version to prepare a new workflow, or author your own. Creating a draft does not change any tickets."
                  : "A draft is a private plan saved in this browser. Add the tickets and relationships you need, check the proposed changes, then explicitly apply them to Workgraph. You can leave this page and return without losing the draft."}
              </p>
            </div>
          </div>
          <ol className="workflow-steps">
            <li>
              <span>1</span>
              <div>
                <strong>{view === "templates" ? "Choose or author" : "Build your plan"}</strong>
                <p>
                  {view === "templates"
                    ? "Choose a saved template, or define a reusable set of tasks."
                    : "Start with a ticket, then add dependencies and rules."}
                </p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Review the changes</strong>
                <p>Workgraph checks each batch. A batch is a group of changes applied together.</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Apply when ready</strong>
                <p>
                  Saving a draft or a prepared action does not apply it. You choose when to publish.
                </p>
              </div>
            </li>
          </ol>
        </>
      )}
      {!editing && (
        <Toolbar label="Plan authoring actions">
          <Button
            tone="primary"
            requiresActor
            disabled={!fresh}
            onClick={() => {
              const id = controller.create(context);
              if (id !== null) onView("drafts");
            }}
          >
            New workflow draft
          </Button>
          <Button
            requiresActor
            disabled={!fresh}
            onClick={() =>
              launch(
                controller.createTemplateSource(context).then((id) => {
                  if (id !== null) onView("drafts");
                }),
              )
            }
          >
            Author template
          </Button>
          <Button onClick={() => file.current?.click()}>Import recovery file</Button>
          <input
            ref={file}
            type="file"
            accept=".ndjson,.jsonl,.wg-plan"
            hidden
            aria-label="Import workflow recovery file"
            onChange={(event) => {
              const selected = event.currentTarget.files?.[0];
              if (selected) imported(selected);
              event.currentTarget.value = "";
            }}
          />
        </Toolbar>
      )}
      {!fresh && (
        <p className="plan-notice" role="status">
          Select a current connection, workspace and acting actor to capture new drafts. Existing
          editors keep their original writer and endpoint.
        </p>
      )}
      {(notice || state.issue) && (
        <p role="alert" className="wg-error">
          {notice || state.issue}
        </p>
      )}
      <PlanGuide initial={view === "templates" ? "template" : "draft"} />
      {view === "templates" ? (
        <section className="plan-templates" aria-label="Registered templates">
          <header className="plan-editor-heading">
            <h3>Published templates</h3>
            <Button
              disabled={state.templateBusy || context.profileState !== "current"}
              onClick={() => launch(controller.loadTemplates(context))}
            >
              Refresh templates
            </Button>
          </header>
          {state.templateIssue && <p role="alert">{state.templateIssue}</p>}
          {state.templateBusy && state.templates.length === 0 && (
            <p role="status">Loading templates…</p>
          )}
          {templatesMatch && state.templateRevision && (
            <p className="wg-hint">{state.templates.length} published versions available.</p>
          )}
          {!templatesMatch ? (
            <p>No templates loaded for this workspace yet.</p>
          ) : state.templates.length === 0 && !state.templateBusy ? (
            <StatePanel kind="empty" title="No templates yet">
              <p>
                Choose Author template to describe a reusable workflow. Review the publication
                draft, then apply it to make the template available here.
              </p>
            </StatePanel>
          ) : (
            <div className="plan-template-list">
              {state.templates.map((pin) => (
                <article className="plan-template" key={`${pin.id}:${pin.version}`}>
                  <div>
                    <h3>{pin.id}</h3>
                    <Badge>Published version {pin.version}</Badge>
                    <TemplateSummary spec={pin.spec} />
                  </div>
                  <Button
                    requiresActor
                    disabled={!fresh}
                    onClick={() =>
                      launch(
                        controller.createInstance(context, pin).then((id) => {
                          if (id !== null) onView("drafts");
                        }),
                      )
                    }
                  >
                    Use template
                  </Button>
                </article>
              ))}
            </div>
          )}
          {templatesMatch && state.nextTemplateOffset !== null && (
            <Button
              disabled={state.templateBusy}
              onClick={() => launch(controller.loadTemplates(context, true))}
            >
              Load next template page
            </Button>
          )}
        </section>
      ) : (
        <div className="plan-library">
          {draft ? (
            <>
              <Toolbar label="Open draft navigation">
                <Button onClick={() => controller.select(null)}>← All saved drafts</Button>
                <Button onClick={() => exportDraft()}>Export draft</Button>
                <Button
                  disabled={draft.active === "preparing"}
                  onClick={() => setRemovingId(draft.id)}
                >
                  Remove draft…
                </Button>
              </Toolbar>
              <DraftEditor
                key={draft.id}
                draft={draft}
                context={context}
                controller={controller}
                operations={operations}
                launch={launch}
                onIssue={issue}
              />
            </>
          ) : (
            <section aria-label="Local workflow drafts" className="plan-library-list">
              <header className="plan-editor-heading">
                <div>
                  <h3>
                    Saved drafts <Badge>{state.drafts.length}</Badge>
                  </h3>
                  <p>
                    Open one to continue editing. Removing a draft only deletes its local copy from
                    this browser.
                  </p>
                </div>
              </header>
              {state.drafts.length === 0 ? (
                <StatePanel kind="empty" title="Your next workflow starts here">
                  <p>
                    Create a workflow draft above, use a template, or import an exported draft.
                    Nothing is published until you review and apply it.
                  </p>
                </StatePanel>
              ) : (
                state.drafts.map((entry) => (
                  <article key={entry.id} className="plan-library-row">
                    <span className="plan-library-icon">
                      <Icon name="saved" />
                    </span>
                    <div className="plan-library-description">
                      <h3>{entry.document?.title ?? "Source needs attention"}</h3>
                      <p>
                        <ActorAvatar actor={entry.capture.context.writer.actor_id} />
                        {entry.capture.context.writer.actor_id} ·{" "}
                        {entry.capture.context.workspace_id}
                      </p>
                      <small>
                        {entry.persisted === "saved"
                          ? "Saved in this browser"
                          : entry.persisted === "pending"
                            ? "Saving…"
                            : "Local save needs attention"}
                        {entry.frozen.some((stage) => stage.captured || stage.prepared) &&
                          " · Includes saved actions"}
                      </small>
                    </div>
                    <Toolbar label={`Actions for ${entry.document?.title ?? entry.id}`}>
                      <Button tone="primary" onClick={() => controller.select(entry.id)}>
                        Open draft
                      </Button>
                      <Button onClick={() => exportDraft(entry)}>Export</Button>
                      <Button
                        disabled={entry.active === "preparing"}
                        onClick={() => setRemovingId(entry.id)}
                      >
                        Remove…
                      </Button>
                    </Toolbar>
                  </article>
                ))
              )}
            </section>
          )}
        </div>
      )}
      {removing && (
        <Dialog
          title="Remove saved draft?"
          description="This removes the draft from this browser, including its automatic local recovery copy."
          onClose={() => setRemovingId(null)}
        >
          <div className="plan-remove-summary">
            <Icon name="saved" />
            <strong>{removing.document?.title ?? "Unparsed draft"}</strong>
          </div>
          <p>
            Existing tickets and published templates stay unchanged. Export a copy first if you
            might want to continue this draft later.
          </p>
          {removing.frozen.some((stage) => stage.captured || stage.prepared) && (
            <p className="plan-notice">
              This draft includes saved actions. Removing it does not cancel or undo those actions,
              and their Workgraph journals remain available in Administration for recovery. Keep an
              export if you need the draft’s links to them.
            </p>
          )}
          <Toolbar label="Remove saved draft actions">
            <Button onClick={() => setRemovingId(null)}>Keep draft</Button>
            <Button onClick={() => exportDraft(removing)}>Export a copy</Button>
            <Button
              tone="danger"
              disabled={removing.active === "preparing"}
              onClick={() => {
                controller.remove(removing.id);
                setRemovingId(null);
              }}
            >
              Remove saved draft
            </Button>
          </Toolbar>
        </Dialog>
      )}
      <details className="plan-recovery-help">
        <summary>Keeping your drafts safe</summary>
        <p>
          Automatic IndexedDB recovery belongs to this exact browser origin, including its port. A
          new ephemeral launcher port or another browser needs an exported recovery file. For
          recurring drafts, start the companion on a fixed port, for example{" "}
          <code>workgraph-ui --state-root /absolute/private/root --port 4180</code>.
        </p>
        <p>
          Source editing is bounded to 4 MiB per draft and 16 MiB across retained source/snapshots.
          Recovery files hold at most 64 MiB, with individually bounded 16 MiB worker frames; at
          most 32 editors and 32 explicit batches per plan. Export and remove old drafts to free
          local space. Removing a draft never deletes saved Workgraph action journals.
        </p>
        <p>
          Import/restore do not replay helpers, execute mutations, retry or recover automatically.
          Inspect exact saved operations and use their explicit actions. A receipt from a prior
          durable commit is the only source of later-stage bindings; preview IDs are provisional and
          unreserved. Native preflight validates expanded count/current domain guards, not
          whole-plan atomicity.
        </p>
      </details>
    </section>
  );
}

function TemplateSummary({ spec }: { readonly spec: JsonObject }) {
  const nodes = jsonField(spec, "nodes"),
    parameters = jsonField(spec, "parameters");
  return (
    <div className="plan-template-summary">
      <p>
        {nodes?.kind === "array" ? `${nodes.items.length} tasks` : "Reusable workflow"} · configure
        inputs before publishing
      </p>
      {nodes?.kind === "array" && (
        <ul>
          {nodes.items.slice(0, 6).map((node, index) => (
            <li key={index}>
              <Icon name="work" />
              <span>
                {text(jsonField(node, "title")) || text(jsonField(node, "alias")) || "Task"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {nodes?.kind === "array" && nodes.items.length > 6 && (
        <p>And {nodes.items.length - 6} more tasks.</p>
      )}
      {parameters?.kind === "array" && parameters.items.length > 0 && (
        <p>Inputs: {parameters.items.map((item) => text(item)).join(", ")}</p>
      )}
    </div>
  );
}
