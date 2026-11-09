import { ActorAvatar } from "../../../components/ActorAvatar";
import { Icon } from "../../../components/Icon";
import { Dialog } from "../../../components/Dialog";
import { Button, Select } from "../../../components/Primitives";
import type { FeatureContext } from "../../../app/types";
import type { GraphRelationDraft, ProposedRelation } from "./types";

export function RelationComposer({
  draft,
  currentContext,
  currentCaptureId,
  close,
  hide,
  edit,
  review,
}: {
  readonly draft: GraphRelationDraft;
  readonly currentContext: FeatureContext;
  readonly currentCaptureId: string | null;
  readonly close: () => void;
  readonly hide: () => void;
  readonly edit: (patch: Partial<ProposedRelation>) => void;
  readonly review: () => void;
}) {
  const { kind, from, to } = draft.input,
    tickets = draft.tickets,
    source = tickets.find((ticket) => ticket.value.ticket.ticket_id === from),
    target = tickets.find((ticket) => ticket.value.ticket.ticket_id === to),
    label = (id: string) =>
      tickets.find((ticket) => ticket.value.ticket.ticket_id === id)?.value.ticket.display_key ??
      id;
  const changed =
    currentCaptureId !== draft.captureId ||
    currentContext.profileState !== "current" ||
    currentContext.writer.actorId !== draft.context.writer.actorId ||
    currentContext.writer.runId !== draft.context.writer.runId ||
    currentContext.connection.id !== draft.scope.connection.id ||
    currentContext.connection.generation !== draft.scope.connection.generation ||
    currentContext.route.workspaceId !== draft.scope.workspaceId;
  return (
    <Dialog
      title="Add relationship"
      description="Connect two tickets to order work, group tasks or attach useful context. Nothing changes until you review and apply the relationship."
      wide
      onClose={hide}
    >
      <div className="graph-draft-context">
        <ActorAvatar actor={draft.context.writer.actorId} />
        <strong>Editing as {draft.context.writer.actorId}</strong>
        <span>
          {draft.scope.connection.label} · workspace {draft.scope.workspaceId}
          {draft.context.writer.runId !== null && ` · run ${draft.context.writer.runId}`}
        </span>
        {changed && (
          <p className="graph-notice">
            The current capture, actor or scope differs. This draft still belongs to its captured
            identity and endpoints. Discard it and start a new draft to use the current context.
          </p>
        )}
      </div>
      <div className="workflow-intro" data-tone="purple">
        <Icon name="workflow" />
        <div>
          <h3>Choose how these tickets connect</h3>
          <p>
            A prerequisite sets the order of work. A parent groups smaller tasks. Related tickets
            provide context without blocking each other.
          </p>
        </div>
      </div>
      <form
        className="graph-relation-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (source && target && from !== to) review();
        }}
      >
        <Select
          label="Relationship kind"
          value={kind}
          onChange={(event) => {
            const value = (["prerequisite", "hierarchy", "related"] as const).find(
              (v) => v === event.target.value,
            );
            if (value) edit({ kind: value });
          }}
        >
          <option value="prerequisite">Prerequisite · orders work</option>
          <option value="hierarchy">Parent / child · groups work</option>
          <option value="related">Related · informational</option>
        </Select>
        <Select
          label={
            kind === "prerequisite"
              ? "Prerequisite"
              : kind === "hierarchy"
                ? "Parent"
                : "First related ticket"
          }
          value={from ?? ""}
          onChange={(event) =>
            edit({
              from:
                tickets.find((ticket) => ticket.value.ticket.ticket_id === event.target.value)
                  ?.value.ticket.ticket_id ?? null,
            })
          }
        >
          <option value="">Choose a ticket…</option>
          {tickets.map(({ value: { ticket } }) => (
            <option key={ticket.ticket_id} value={ticket.ticket_id}>
              {ticket.display_key} · {ticket.title} · {ticket.project_id ?? "no project"}
            </option>
          ))}
        </Select>
        <Select
          label={
            kind === "prerequisite"
              ? "Dependent · waits for prerequisite"
              : kind === "hierarchy"
                ? "Child · subtree will move"
                : "Second related ticket"
          }
          value={to ?? ""}
          onChange={(event) =>
            edit({
              to:
                tickets.find((ticket) => ticket.value.ticket.ticket_id === event.target.value)
                  ?.value.ticket.ticket_id ?? null,
            })
          }
        >
          <option value="">Choose a ticket…</option>
          {tickets.map(({ value: { ticket } }) => (
            <option key={ticket.ticket_id} value={ticket.ticket_id}>
              {ticket.display_key} · {ticket.title} · {ticket.project_id ?? "no project"}
            </option>
          ))}
        </Select>
        <div className="graph-proposed-sentence">
          {from && to
            ? kind === "prerequisite"
              ? `${label(to)} waits for prerequisite ${label(from)}.`
              : kind === "hierarchy"
                ? `${label(to)} becomes a child of ${label(from)}. Its descendant subtree moves atomically; project changes clear descendant milestones.`
                : `${label(from)} is related to ${label(to)}. Neither ticket must wait for the other.`
            : "Choose two different tickets to see a plain-language preview here."}
        </div>
        {source === target && source && (
          <p role="alert" className="wg-error">
            A ticket cannot relate to itself.
          </p>
        )}
        <p className="wg-hint">
          Newly loaded tickets cannot enter this draft. To add an off-view endpoint, discard this
          sheet, resolve its display key above the graph, then start a new draft. Server validation
          checks hidden, inherited, done and waived edges for cycles; related cycles are allowed.
        </p>
        <Button tone="primary" type="submit" disabled={!source || !target || from === to}>
          Review relationship
        </Button>
        <Button onClick={hide}>Hide; keep relationship draft</Button>
        <Button onClick={close}>Discard relationship draft</Button>
      </form>
    </Dialog>
  );
}
