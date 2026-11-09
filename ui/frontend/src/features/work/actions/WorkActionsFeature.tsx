import { ACTION_SUMMARY } from "./action-summaries";
import { QuickTicketActions } from "./QuickTicketActions";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { ActionExplanation } from "./ActionExplanation";
import { InspectorDisclosure } from "../views/InspectorParts";
import { ManagementPresentation } from "../../connections/management-presentation";
import { Icon } from "../../../components/Icon";
import { useState, useSyncExternalStore } from "react";
import { Dialog } from "../../../components/Dialog";
import { Button, Toolbar } from "../../../components/Primitives";
import { jsonField } from "../../../core/json";
import { routeHref } from "../../../app/navigation";
import { workbenchRoute } from "../destinations";
import type { Identifier } from "../../../core/protocol/types";
import type { WorkActionContext } from "../read-model.types";
import { WorkFeature } from "../views";
import { OperationPanel } from "../../connections/shared";
import { auxiliaryKey } from "./auxiliary";
import { COMMANDS, commandDefinition } from "./commands";
import { FormFields } from "./FormFields";
import { offeredAction } from "./intents";
import { createdTicketId, readText } from "./model";
import type { CommandGroup, WorkActionsFeatureProps, WorkDraft } from "./types";
import "./actions.css";

function ActionPicker({
  target,
  props,
}: {
  readonly target: WorkActionContext;
  readonly props: WorkActionsFeatureProps;
}) {
  const [group, setGroup] = useState<CommandGroup>("ticket"),
    [expanded, setExpanded] = useState(false);
  const open = (selected: string) => {
    const definition = COMMANDS.find(
      (item) => item.method === selected && item.target === "ticket",
    );
    if (definition === undefined) return;
    const id = props.controller.open(target.context, definition.method, {
      scope: target.scope,
      ticket: target.ticket,
    });
    if (id !== null) {
      target.clearIntent();
      setExpanded(false);
    }
  };
  const intent = target.intent;
  const offered = intent === null ? null : offeredAction(intent, target.ticket.value.ticket);
  return (
    <div className="work-action-menu">
      <Button onClick={() => setExpanded(true)}>Actions</Button>
      {(expanded || target.intent !== null) && (
        <Dialog
          title={`Actions · ${target.ticket.value.ticket.display_key}`}
          description={target.ticket.value.ticket.title}
          onClose={() => {
            setExpanded(false);
            target.clearIntent();
          }}
        >
          <section
            className="work-action-picker work-dialog-content"
            aria-label="Selected ticket actions"
          >
            <p className="work-message-author">
              <ActorAvatar actor={target.context.writer.actorId} />
              Acting as {target.context.writer.actorId ?? "no actor selected"} ·{" "}
              {target.ticket.value.ticket.project_id ?? "Workspace ticket"}
            </p>
            {intent && (
              <div className="work-action-intent">
                <p>
                  Offered for <code>{target.ticket.value.ticket.ticket_id}</code>:{" "}
                  {intent.kind === "status"
                    ? `lifecycle ${intent.status}`
                    : `${intent.target} readiness`}
                  . No status has changed.
                </p>
                {offered !== null && (
                  <>
                    {offered.kind === "checks" && (
                      <p className="wg-hint">
                        Readiness and completion are computed from captured checks. Review blockers
                        and their sources; choosing Ready never claims ownership.
                      </p>
                    )}
                    <Button
                      requiresActor={offered.kind !== "checks"}
                      disabled={target.context.profileState !== "current"}
                      onClick={() => {
                        if (offered.kind === "checks") {
                          props.readController.setPresentation({ tab: offered.tab });
                          target.clearIntent();
                          setExpanded(false);
                          return;
                        }
                        const id = props.controller.open(target.context, offered.method, {
                          scope: target.scope,
                          ticket: target.ticket,
                        });
                        if (id !== null) {
                          setExpanded(false);
                          if (intent.kind === "status")
                            props.controller.edit(id, "status", {
                              kind: "scalar",
                              presence: "value",
                              text: intent.status,
                            });
                          else if (offered.holdReason !== null)
                            props.controller.edit(id, "reason", {
                              kind: "scalar",
                              presence: offered.holdReason === "clear" ? "null" : "value",
                              text: "",
                            });
                          target.clearIntent();
                        }
                      }}
                    >
                      {offered.label}
                    </Button>
                  </>
                )}
                <Button tone="quiet" onClick={target.clearIntent}>
                  Dismiss offer
                </Button>
              </div>
            )}
            <p className="work-section-help">
              Choose what you want to change. Each action opens an explained form; nothing is saved
              until you review and apply it.
            </p>
            <div className="work-action-groups" aria-label="Action group">
              {(
                [
                  ["ticket", "Ticket edits"],
                  ["relationships", "Links"],
                  ["guardrails", "Rules & instructions"],
                  ["ownership", "Ownership"],
                ] as const
              ).map(([key, label]) => (
                <Button key={key} aria-pressed={group === key} onClick={() => setGroup(key)}>
                  {label}
                </Button>
              ))}
            </div>
            <div className="work-action-cards" aria-label="Ticket actions">
              {COMMANDS.filter((item) => item.target === "ticket" && item.group === group).map(
                (item) => (
                  <Button
                    key={item.method}
                    requiresActor
                    disabled={target.context.profileState !== "current"}
                    onClick={() => open(item.method)}
                  >
                    <strong>{item.title}</strong>
                    <span>{ACTION_SUMMARY[item.method]}</span>
                  </Button>
                ),
              )}
            </div>
          </section>
        </Dialog>
      )}
    </div>
  );
}
function DraftEditor({
  draft,
  props,
}: {
  readonly draft: WorkDraft;
  readonly props: WorkActionsFeatureProps;
}) {
  const [unexpected, setUnexpected] = useState<{ readonly error: unknown } | null>(null);
  if (draft.unexpected !== null) throw draft.unexpected.error;
  if (unexpected !== null) throw unexpected.error;
  const definition = commandDefinition(draft.method),
    locked = draft.phase.kind === "captured" || draft.phase.kind === "capturing",
    key = auxiliaryKey(draft),
    loaded = key === null ? undefined : draft.auxiliary[key];
  const operation = props.operations.get(draft.id)?.operation;
  let createdRoute = null;
  if (
    draft.method === "ticket.create" &&
    operation?.state.kind === "committed" &&
    operation.preparation.context.workspace_id !== null
  ) {
    const id = createdTicketId(operation.preparation, operation.state);
    if (id !== null) {
      createdRoute = workbenchRoute(
        operation.connection,
        operation.preparation.context.workspace_id,
        id,
      );
    }
  }
  const run = (promise: Promise<void>) => {
    void promise.catch((error: unknown) => setUnexpected({ error }));
  };
  const fillable = [
    "ticket.paths.put",
    "ticket.hierarchy.put",
    "ticket.amendment.publish",
    "label.put",
    "status.put",
  ].includes(draft.method);
  const workflow = loaded?.method === "label.list" || loaded?.method === "status.list";
  const directory = workflow
    ? jsonField(
        loaded.response.response.data.kind === "object"
          ? loaded.response.response.data
          : { kind: "object", fields: [] },
        "items",
      )
    : undefined;
  const settled = operation?.state.kind === "committed" || operation?.state.kind === "observed";
  const fields = (
    <FormFields
      fields={definition.fields}
      secondaryFields={
        draft.method === "ticket.create"
          ? ["ticket_id", "project_id", "milestone_id", "parent_ticket_id"]
          : []
      }
      secondaryLabel="Placement and optional ID"
      values={draft.inputs}
      disabled={locked}
      change={(name, value) => props.controller.edit(draft.id, name, value)}
    />
  );
  const reviewPanel =
    props.operations.get(draft.id) === undefined ? null : (
      <OperationPanel
        key={draft.id}
        operations={props.operations}
        intention={draft.id}
        applyLabel="Apply action"
        resultActions={
          createdRoute && (
            <p>
              <a href={routeHref(createdRoute)} onClick={() => props.controller.select(null)}>
                Open created ticket
              </a>
            </p>
          )
        }
        processing={props.context.client.processing}
      />
    );
  return (
    <>
      {locked && reviewPanel}
      <p className="work-action-author">
        <ActorAvatar actor={draft.capture.writer.actorId} /> Acting as{" "}
        <strong>{draft.capture.writer.actorId}</strong>
        {draft.capture.ticket ? ` · ${draft.capture.ticket.value.ticket.title}` : ""}
      </p>

      {!locked && <ActionExplanation draft={draft} />}
      {draft.issue && (
        <p role="alert" className="wg-error">
          {draft.issue}
        </p>
      )}
      {draft.phase.kind === "loading" && (
        <p role="status">Loading {draft.phase.method} for this captured editor…</p>
      )}
      <form
        aria-label={`${definition.title} form`}
        onSubmit={(event) => {
          event.preventDefault();
          run(props.controller.review(draft.id));
        }}
      >
        {locked ? (
          <details>
            <summary>
              {settled ? "Created or updated fields" : "Fields included in this action"}
            </summary>
            {fields}
          </details>
        ) : (
          fields
        )}
        {key !== null && !locked && (
          <div className="work-action-load">
            <Toolbar label="Referenced record controls">
              <Button disabled={locked} onClick={() => run(props.controller.load(draft.id))}>
                {draft.method === "label.put"
                  ? "Browse existing labels"
                  : draft.method === "status.put"
                    ? "Browse existing statuses"
                    : "Load referenced record"}
              </Button>
              {fillable && (
                <Button
                  disabled={locked || loaded === undefined}
                  onClick={() => props.controller.fill(draft.id)}
                >
                  Use loaded values
                </Button>
              )}
              {workflow && (
                <>
                  <Button
                    disabled={locked}
                    onClick={() => run(props.controller.load(draft.id, "next"))}
                  >
                    Next directory page
                  </Button>
                  <Button
                    disabled={locked}
                    onClick={() => run(props.controller.load(draft.id, "retry"))}
                  >
                    Retry directory page
                  </Button>
                </>
              )}
            </Toolbar>
            <p className="wg-hint">
              Browse existing records, then choose one to edit. Loading alone does not change your
              fields. Use loaded values explicitly, or keep Create a new record selected for a new
              ID.
            </p>
            {loaded !== undefined && directory?.kind === "array" && (
              <div className="work-action-directory">
                <h3>Choose a record to edit</h3>
                {directory.items.length === 0 && <p>No records in this page.</p>}
                {directory.items.map((item) => {
                  if (item.kind !== "object")
                    throw new Error("Validated directory row is not an object.");
                  const field = loaded.method === "label.list" ? "label_id" : "status_id",
                    id = readText(jsonField(item, field), field),
                    name = readText(jsonField(item, "name"), "Name"),
                    revision = readText(jsonField(item, "revision"), "Revision");
                  return (
                    <div key={id}>
                      <span>
                        <strong>{name}</strong>
                        <br />
                        <code>{id}</code> · revision {revision}
                      </span>
                      <Button
                        disabled={locked}
                        onClick={() => {
                          props.controller.edit(draft.id, field, {
                            kind: "scalar",
                            presence: "value",
                            text: id,
                          });
                          props.controller.fill(draft.id);
                        }}
                      >
                        Use {id}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {!locked && (
          <div className="wg-form-actions">
            <Button type="submit" tone="primary">
              Review action
            </Button>
          </div>
        )}
      </form>
      {!locked && reviewPanel}
      <Toolbar label="Editor lifetime controls">
        <Button onClick={() => props.controller.select(null)}>Hide editor; keep draft</Button>
        <Button
          tone="quiet"
          disabled={draft.phase.kind === "capturing"}
          onClick={() => {
            props.controller.close(draft.id);
            props.controller.select(null);
          }}
        >
          {props.operations.get(draft.id) === undefined
            ? "Discard unsent draft"
            : "Close editor; keep saved action"}
        </Button>
      </Toolbar>
    </>
  );
}
export function WorkActionsFeature(props: WorkActionsFeatureProps) {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.get),
    [saved, setSaved] = useState<Identifier | null>(null),
    [workspaceMethod, setWorkspaceMethod] = useState(""),
    [metadataOpen, setMetadataOpen] = useState(false),
    [draftsOpen, setDraftsOpen] = useState(false);
  const operationKey = useSyncExternalStore(props.operations.subscribe, () =>
    props.operations
      .list()
      .map(
        (entry) =>
          `${entry.preparation.intention_id}:${entry.operation?.revision ?? "none"}:${entry.phase.kind}`,
      )
      .join("\n"),
  );
  const intentions = props.operations
    .list()
    .filter((entry) => COMMANDS.some((item) => item.method === entry.preparation.method));
  // The stable string snapshot subscribes to launch intentions without manufacturing a fresh array each read.
  void operationKey;
  if (state.unexpected !== null) throw state.unexpected.error;
  const selected = state.drafts.find((draft) => draft.id === state.selectedId),
    canCapture =
      props.context.profileState === "current" && props.context.route.workspaceId !== null;
  const openWorkspace = () => {
    const method = COMMANDS.find(
      (item) => item.method === workspaceMethod && item.target === "workflow",
    );
    if (method !== undefined) {
      const draft = props.controller.open(props.context, method.method, null);
      if (draft !== null) setMetadataOpen(false);
    }
  };
  const creationControls = (
    <Toolbar label="Work creation and captured drafts">
      <Button
        tone="primary"
        requiresActor
        disabled={!canCapture}
        title={
          canCapture
            ? "Create a ticket"
            : "Select an acting actor and a workspace to create tickets"
        }
        onClick={() => props.controller.open(props.context, "ticket.create", null)}
      >
        New ticket
      </Button>
      {(state.drafts.length > 0 || intentions.length > 0) && (
        <Button onClick={() => setDraftsOpen(true)}>
          Drafts & saved actions <span className="wg-badge">{state.drafts.length}</span>
        </Button>
      )}
      <Button tone="quiet" onClick={() => setMetadataOpen(true)}>
        Labels & statuses
      </Button>
    </Toolbar>
  );
  return (
    <div className="work-actions-feature">
      {draftsOpen && (
        <Dialog
          title="Drafts and saved actions"
          description="Pick up an edit you set aside, or inspect the outcome of a saved action."
          wide
          onClose={() => setDraftsOpen(false)}
        >
          <div className="work-dialog-content">
            <section className="work-action-explanation">
              <h3>Your edits stay with their original target</h3>
              <p>
                Closing an editor hides it without saving or discarding. Drafts stay in this browser
                session and keep the original ticket and actor, even if you switch pages. Prepared
                actions have a saved request for inspecting their outcome.
              </p>
            </section>
            <section className="work-draft-list">
              <h3>Resume an editor</h3>
              {state.drafts.length === 0 && <p>No unfinished editors.</p>}
              {state.drafts.map((draft) => (
                <Button
                  key={draft.id}
                  onClick={() => {
                    props.controller.select(draft.id);
                    setDraftsOpen(false);
                  }}
                >
                  <ActorAvatar actor={draft.capture.writer.actorId} />
                  <span>
                    <strong>{commandDefinition(draft.method).title}</strong>
                    <small>
                      {draft.capture.ticket?.value.ticket.display_key ?? "Workspace"} ·{" "}
                      {draft.capture.writer.actorId} · {draft.capture.workspaceId} ·{" "}
                      {draft.phase.kind}
                    </small>
                  </span>
                  <Icon name="chevron" />
                </Button>
              ))}
            </section>
            <section className="work-draft-list">
              <h3>Saved actions</h3>
              <p>
                Check whether an action was prepared, applied or needs recovery. Opening an action
                does not send it again.
              </p>
              {intentions.length === 0 && <p>No actions prepared in this browser session.</p>}
              {intentions.map((entry) => (
                <Button
                  key={entry.preparation.intention_id}
                  onClick={() => {
                    props.controller.select(null);
                    setSaved(entry.preparation.intention_id);
                    setDraftsOpen(false);
                  }}
                >
                  <Icon name="history" />
                  <span>
                    <strong>{entry.preparation.method}</strong>
                    <small>
                      {entry.operation?.state.kind.replaceAll("_", " ") ??
                        "Preparation not confirmed"}
                    </small>
                  </span>
                  <Icon name="chevron" />
                </Button>
              ))}
            </section>
          </div>
        </Dialog>
      )}
      {metadataOpen && (
        <Dialog
          title="Labels and statuses"
          description="Organize ticket labels and add named statuses within the workspace."
          onClose={() => setMetadataOpen(false)}
        >
          <div className="work-dialog-content">
            <section className="work-action-explanation">
              <h3>Organize your workspace</h3>
              <p>
                Labels help you categorize tickets. Custom statuses give names to stages of work.
                Definitions are shared across this workspace; editing one does not move or relabel
                tickets.
              </p>
            </section>
            <div className="work-metadata-choices" role="group" aria-label="Metadata type">
              {COMMANDS.filter((item) => item.target === "workflow").map((item) => (
                <Button
                  key={item.method}
                  aria-pressed={workspaceMethod === item.method}
                  onClick={() => setWorkspaceMethod(item.method)}
                >
                  <Icon name={item.method === "label.put" ? "facts" : "work"} />
                  <strong>{item.method === "label.put" ? "Labels" : "Statuses"}</strong>
                  <span>
                    {item.method === "label.put"
                      ? "Reusable tags and descriptions to group related work."
                      : "Named workflow stages mapped to a lifecycle category."}
                  </span>
                </Button>
              ))}
            </div>

            <div className="wg-form-actions">
              <Button
                tone="primary"
                requiresActor
                disabled={!canCapture || workspaceMethod === ""}
                onClick={openWorkspace}
              >
                Open metadata form
              </Button>
            </div>
          </div>
        </Dialog>
      )}
      {state.issue && (
        <p role="alert" className="wg-error">
          {state.issue}
        </p>
      )}
      <WorkFeature
        toolbarActions={creationControls}
        context={props.context}
        controller={props.readController}
        renderAdmissionActions={(target) => (
          <Button
            requiresActor
            disabled={target.context.profileState !== "current"}
            onClick={() =>
              props.controller.open(target.context, "ticket.start", {
                scope: target.scope,
                ticket: target.ticket,
              })
            }
          >
            Start work
          </Button>
        )}
        renderQuickActions={(target) => (
          <QuickTicketActions
            key={target.ticket.value.ticket.ticket_id}
            target={target}
            props={props}
          />
        )}
        renderActions={(target) => (
          <>
            <ActionPicker target={target} props={props} />
          </>
        )}
        renderProgress={(target) => (
          <>
            {props.renderProgress?.(target)}
            {props.renderInspectorSections && (
              <InspectorDisclosure
                title="Review and evidence"
                description="Check completion requirements, supporting results and independent reviews for this ticket."
                icon="check"
                tone="green"
              >
                {props.renderInspectorSections(target)}
              </InspectorDisclosure>
            )}
          </>
        )}
        {...(props.renderCollection === undefined
          ? {}
          : { renderCollection: props.renderCollection })}
      />
      {selected && (
        <Dialog
          key={selected.id}
          title={commandDefinition(selected.method).title}
          wide
          onClose={() => props.controller.select(null)}
        >
          <div className="work-dialog-content" data-method={selected.method}>
            <ManagementPresentation value={true}>
              <DraftEditor draft={selected} props={props} />
            </ManagementPresentation>
          </div>
        </Dialog>
      )}
      {saved !== null && selected === undefined && (
        <Dialog
          key={`saved-${saved}`}
          title="Saved ticket action"
          wide
          onClose={() => setSaved(null)}
        >
          <p className="wg-hint">
            Captured intentions in this browser session; only native-prepared operations have
            durable journals. Closing an editor does not erase this identity.
          </p>
          <div className="work-dialog-content">
            <ManagementPresentation value={true}>
              <OperationPanel
                key={saved}
                operations={props.operations}
                intention={saved}
                processing={props.context.client.processing}
              />
            </ManagementPresentation>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export type {
  WorkActionsFeatureProps,
  WorkActionsController,
  WorkActionsOptions,
  WorkTarget,
} from "./types";
