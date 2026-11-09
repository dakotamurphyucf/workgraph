import { jsonField, type JsonValue } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import type { Identifier, Preparation } from "../../../core/protocol/types";
import type { WorkActionContext } from "../read-model.types";
import { ActionInputError, claimFence, counter, identity, validId } from "../actions/model";
import type {
  HandoffFields,
  ProgressCapture,
  ProgressCommand,
  ProgressDraft,
  ProgressInput,
} from "./types";

export { ActionInputError as ProgressInputError, identity };
export const MAX_DRAFTS = 24;
export const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const utf8 = new TextEncoder();
const text = (value: string, label: string, nonblank = false): string => {
  if ((nonblank && value.trim() === "") || utf8.encode(value).byteLength > 65536)
    throw new ActionInputError(
      `${label} requires ${nonblank ? "nonblank text and " : ""}at most 65536 UTF-8 bytes.`,
    );
  return value;
};
export const EMPTY_HANDOFF: HandoffFields = Object.freeze({
  summary: "",
  nextSteps: "",
  evidence: "",
  objective: "",
  completed: "",
  decisions: "",
  blockers: "",
  resourceIds: "",
  coversThrough: "0",
});

export function captureProgress(target: WorkActionContext): ProgressCapture {
  const { context, scope, ticket } = target;
  if (context.profileState !== "current")
    throw new ActionInputError(
      "Refresh the connection directory before opening a new composer. Existing drafts remain unchanged.",
    );
  const workspaceId = validId(context.route.workspaceId ?? "", "Workspace");
  if (
    scope.connection.id !== context.connection.id ||
    scope.connection.generation !== context.connection.generation ||
    scope.workspaceId !== workspaceId
  )
    throw new ActionInputError(
      "The selected ticket belongs to another endpoint or workspace; finish loading the current selection.",
    );
  return Object.freeze({
    connection: Object.freeze({ ...context.connection }),
    workspaceId,
    projectId: ticket.value.ticket.project_id,
    writer: Object.freeze({
      actorId: validId(context.writer.actorId ?? "", "Acting actor"),
      runId: context.writer.runId === null ? null : validId(context.writer.runId, "Acting run"),
    }),
    ticket,
    detail:
      target.detail?.value.ticket.ticket_id === ticket.value.ticket.ticket_id
        ? target.detail
        : null,
  });
}
export function initialInput(method: ProgressCommand): ProgressInput {
  switch (method) {
    case "ticket.progress":
    case "comment.add":
      return {
        method,
        body: "",
        kind: method === "ticket.progress" ? "progress" : "comment",
        replyToId: "",
      };
    case "comment.edit":
      return { method, commentId: "", body: "" };
    case "comment.tombstone":
      return { method, commentId: "" };
    case "handoff.set":
      return { method, fields: EMPTY_HANDOFF };
    case "attempt.start":
      return { method, attemptId: identity("attempt"), sessionIds: "" };
    case "attempt.checkpoint":
      return { method, attemptId: "", checkpointKind: "resource", targetId: "", revision: "" };
    case "attempt.finish":
      return { method, attemptId: "", state: "completed", evidence: "" };
    case "ticket.finish":
      return { method, evidence: "", handoff: null };
    case "ticket.complete":
      return { method, evidence: "" };
    case "ticket.reopen":
      return { method, reason: "" };
  }
}
export function freezeInput(input: ProgressInput): ProgressInput {
  return input.method === "handoff.set"
    ? Object.freeze({ ...input, fields: Object.freeze({ ...input.fields }) })
    : input.method === "ticket.finish" && input.handoff !== null
      ? Object.freeze({ ...input, handoff: Object.freeze({ ...input.handoff }) })
      : Object.freeze({ ...input });
}
export function inputBytes(input: ProgressInput): number {
  const handoff = (value: HandoffFields) => [
    value.summary,
    value.nextSteps,
    value.evidence,
    value.objective,
    value.completed,
    value.decisions,
    value.blockers,
    value.resourceIds,
    value.coversThrough,
  ];
  let texts: readonly string[];
  switch (input.method) {
    case "handoff.set":
      texts = handoff(input.fields);
      break;
    case "ticket.finish":
      texts = [input.evidence, ...(input.handoff === null ? [] : handoff(input.handoff))];
      break;
    case "ticket.progress":
    case "comment.add":
      texts = [input.body, input.kind, input.replyToId];
      break;
    case "comment.edit":
      texts = [input.commentId, input.body];
      break;
    case "comment.tombstone":
      texts = [input.commentId];
      break;
    case "attempt.start":
      texts = [input.attemptId, input.sessionIds];
      break;
    case "attempt.checkpoint":
      texts = [input.attemptId, input.checkpointKind, input.targetId, input.revision];
      break;
    case "attempt.finish":
      texts = [input.attemptId, input.state, input.evidence];
      break;
    case "ticket.complete":
      texts = [input.evidence];
      break;
    case "ticket.reopen":
      texts = [input.reason];
      break;
  }
  return texts.reduce((total, value) => total + utf8.encode(value).byteLength, input.method.length);
}
function identifiers(source: string, label: string, maximum: number): readonly Identifier[] {
  const values = source
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (values.length > maximum || new Set(values).size !== values.length)
    throw new ActionInputError(
      `${label} requires at most ${maximum} distinct resolved identifiers, one per line.`,
    );
  return values.map((value) => validId(value, label));
}
export function ownerToken(capture: ProgressCapture): string {
  const claim = claimFence(capture);
  if (
    claim === null ||
    claim.actorId !== capture.writer.actorId ||
    claim.runId !== capture.writer.runId
  )
    throw new ActionInputError(
      "This action requires the captured ticket's current claim, actor and exact optional run. Choose the owner or explicitly acquire ownership; assignment does not transfer the claim.",
    );
  return claim.token;
}
function handoffFields(fields: HandoffFields, nested: boolean): readonly [string, JsonValue][] {
  const result: [string, JsonValue][] = [
    ["summary", d.jsonString(text(fields.summary, "Handoff summary"))],
    ["next_steps", d.jsonString(text(fields.nextSteps, "Next steps"))],
    ["objective", d.jsonString(text(fields.objective, "Objective"))],
    ["completed", d.jsonString(text(fields.completed, "Completed work"))],
    ["decisions", d.jsonString(text(fields.decisions, "Decisions"))],
    ["blockers", d.jsonString(text(fields.blockers, "Blockers"))],
    [
      "resource_ids",
      d.jsonArray(
        identifiers(fields.resourceIds, "Linked resources", nested ? 100 : 65536).map(d.jsonString),
      ),
    ],
    ["covers_through", d.jsonString(counter(fields.coversThrough, "Inspected planning sequence"))],
  ];
  if (!nested) result.push(["evidence", d.jsonString(text(fields.evidence, "Handoff evidence"))]);
  return result;
}

/** Produces the complete explicit command once. It does not merge current
 * selection, invent a revision, mutate a claim or perform any external action. */
export function preparation(draft: ProgressDraft): Preparation {
  const { capture, input, guards } = draft,
    ticket = capture.ticket.value.ticket;
  const fields: [string, JsonValue][] = [
    ["workspace_id", d.jsonString(capture.workspaceId)],
    ["actor_id", d.jsonString(capture.writer.actorId)],
  ];
  const put = (key: string, value: string) => fields.push([key, d.jsonString(value)]);
  if (capture.writer.runId !== null) put("run_id", capture.writer.runId);
  const target = () => put("ticket_id", ticket.ticket_id);
  const owner = () => put("token", ownerToken(capture));
  const attempt = () => {
    if (input.method !== "attempt.finish" && input.method !== "attempt.checkpoint")
      throw new Error("Attempt guard used for another method.");
    const value = guards.attempt;
    if (
      value === undefined ||
      value.id !== validId(input.attemptId, "Attempt") ||
      value.ticketId !== ticket.ticket_id ||
      value.runId !== capture.writer.runId
    )
      throw new ActionInputError(
        "Read this ticket's exact attempt under its captured run before reviewing it.",
      );
    if (value.state !== "running" && value.state !== "waiting")
      throw new ActionInputError(
        "The captured attempt is already terminal; read its evidence or start a new recorded attempt.",
      );
    put("attempt_id", value.id);
    put("expected_revision", value.revision);
    return value;
  };
  switch (input.method) {
    case "ticket.progress":
      target();
      owner();
      put("body", text(input.body, "Progress", true));
      put("kind", input.kind);
      break;
    case "comment.add":
      fields.push([
        "target",
        d.jsonObject([
          ["kind", d.jsonString("ticket")],
          ["id", d.jsonString(ticket.ticket_id)],
        ]),
      ]);
      put("body", text(input.body, "Comment", true));
      put("kind", input.kind);
      if (input.replyToId !== "") put("reply_to_id", validId(input.replyToId, "Reply comment"));
      break;
    case "comment.edit":
    case "comment.tombstone": {
      const comment = guards.comment;
      if (
        comment === undefined ||
        comment.id !== validId(input.commentId, "Comment") ||
        comment.authorId !== capture.writer.actorId
      )
        throw new ActionInputError(
          "Read the exact comment as its original author before changing it.",
        );
      const commentTarget = jsonField(comment.raw, "target");
      if (
        commentTarget?.kind !== "object" ||
        jsonField(commentTarget, "kind")?.kind !== "string" ||
        jsonField(commentTarget, "id")?.kind !== "string"
      )
        throw new ActionInputError(
          "The returned comment does not identify its exact ticket target.",
        );
      const kind = jsonField(commentTarget, "kind"),
        id = jsonField(commentTarget, "id");
      if (
        kind?.kind !== "string" ||
        kind.value !== "ticket" ||
        id?.kind !== "string" ||
        id.value !== ticket.ticket_id
      )
        throw new ActionInputError("The returned comment belongs to another ticket.");
      if (comment.tombstone)
        throw new ActionInputError(
          "This comment is already tombstoned; its history remains available.",
        );
      if (comment.origin !== "authored")
        throw new ActionInputError(
          "Completion evidence is immutable. Append an attributed correction reply instead of revising its historical record.",
        );
      put("comment_id", comment.id);
      put("expected_revision", comment.revision);
      if (input.method === "comment.edit") put("body", text(input.body, "Edited comment", true));
      break;
    }
    case "handoff.set":
      if (guards.handoff === undefined)
        throw new ActionInputError(
          "Read the current handoff or its confirmed absence before reviewing a replacement.",
        );
      if (guards.handoff !== null && guards.handoff.ticketId !== ticket.ticket_id)
        throw new ActionInputError("The returned handoff belongs to another ticket.");
      target();
      if (ticket.claim !== null) owner();
      put("expected_revision", guards.handoff?.revision ?? "0");
      fields.push(...handoffFields(input.fields, false));
      break;
    case "attempt.start":
      if (capture.writer.runId === null)
        throw new ActionInputError(
          "Choose the actual registered owning run before starting a recorded attempt.",
        );
      target();
      owner();
      put("target_run_id", capture.writer.runId);
      put("attempt_id", validId(input.attemptId, "New attempt"));
      fields.push([
        "session_ids",
        d.jsonArray(identifiers(input.sessionIds, "Conversation sessions", 100).map(d.jsonString)),
      ]);
      break;
    case "attempt.checkpoint": {
      const value = attempt();
      if (ownerToken(capture) !== value.token)
        throw new ActionInputError("The attempt's claim differs from this captured ticket claim.");
      fields.push([
        "checkpoint",
        d.jsonObject([
          ["kind", d.jsonString(input.checkpointKind)],
          [
            input.checkpointKind === "resource" ? "resource_id" : "ticket_id",
            d.jsonString(validId(input.targetId, "Checkpoint target")),
          ],
          ["revision", d.jsonString(counter(input.revision, "Pinned checkpoint version", true))],
        ]),
      ]);
      break;
    }
    case "attempt.finish": {
      const value = attempt();
      if (ownerToken(capture) !== value.token)
        throw new ActionInputError(
          "Attempt outcome requires this exact current claim. The daemon checks completed-outcome lease validity; failed/cancelled records remain distinct.",
        );
      put("state", input.state);
      put("evidence", text(input.evidence, "Attempt outcome evidence", true));
      break;
    }
    case "ticket.finish":
      target();
      owner();
      put("evidence", text(input.evidence, "Completion evidence", true));
      if (input.handoff !== null)
        fields.push(["handoff", d.jsonObject(handoffFields(input.handoff, true))]);
      break;
    case "ticket.complete":
      target();
      owner();
      put("evidence", text(input.evidence, "Completion evidence", true));
      break;
    case "ticket.reopen":
      target();
      put("expected_revision", ticket.revision);
      put("reason", text(input.reason, "Reopening reason", true));
      break;
  }
  if (new Set(fields.map(([name]) => name)).size !== fields.length)
    throw new Error("Progress command contains duplicate parameter fields.");
  return Object.freeze({
    intention_id: draft.id,
    connection_id: capture.connection.id,
    generation: capture.connection.generation,
    method: input.method,
    context: {
      workspace_id: capture.workspaceId,
      project_id: capture.projectId,
      writer: { actor_id: capture.writer.actorId, run_id: capture.writer.runId },
    },
    params: d.jsonObject(fields),
  });
}
