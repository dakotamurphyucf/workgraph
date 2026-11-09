import { mergeCommentTimeline } from "../../src/features/work/progress/comment-timeline";
import { afterEach, describe, expect, it } from "vitest";
import { jsonField } from "../../src/core/json";
import type { HttpClient } from "../../src/core/protocol/http";
import * as d from "../../src/core/protocol/decoders";
import type { WorkActionContext } from "../../src/features/work/read-model.types";
import {
  captureProgress,
  EMPTY_HANDOFF,
  inputBytes,
  preparation,
  ProgressInputError,
} from "../../src/features/work/progress/model";
import type {
  Attempt,
  ProgressDraft,
  ProgressInput,
  TicketComment,
} from "../../src/features/work/progress/types";
import { createTestProcessor } from "../core/processing-harness";
import { context, decode, json, target } from "./actions-fixtures";
import { object as objectCodec } from "../../src/core/protocol/codec";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
function selection(claimed = true): WorkActionContext {
  const processing = createTestProcessor();
  disposals.push(() => processing.dispose());
  const client: HttpClient = {
    processing,
    request: () => Promise.reject(new Error("Pure model must not perform transport.")),
  };
  return {
    context: context(client),
    ...target(client, claimed),
    detail: null,
    intent: null,
    clearIntent: () => undefined,
  };
}
function draft(input: ProgressInput, selected = selection()): ProgressDraft {
  return {
    id: decode(d.identifier, "saved-intention"),
    capture: captureProgress(selected),
    input,
    guards: { handoff: undefined, attempt: undefined, comment: undefined, reads: [] },
    phase: { kind: "editing" },
    issue: null,
    unexpected: null,
    editRevision: 0,
  };
}
function attempt(): Attempt {
  return {
    id: decode(d.identifier, "original-attempt"),
    revision: decode(d.decimal, "9007199254740995"),
    runId: decode(d.identifier, "run-one"),
    ticketId: decode(d.identifier, "target"),
    token: decode(d.decimal, "9007199254740993"),
    state: "running",
    sessionIds: [],
    checkpoints: [],
    evidence: "",
    raw: decode(objectCodec, {}),
  };
}
function comment(ticketId = "target", authorId = "author"): TicketComment {
  return {
    id: decode(d.identifier, "comment"),
    revision: decode(d.decimal, "9007199254740996"),
    actorId: decode(d.identifier, authorId),
    authorId: decode(d.identifier, authorId),
    body: "original",
    kind: "comment",
    origin: "authored",
    replyToId: null,
    tombstone: false,
    sequence: decode(d.decimal, "5"),
    timestamp: "fixture time",
    raw: decode(objectCodec, { target: { kind: "ticket", id: ticketId } }),
  };
}
const progress: ProgressInput = {
  method: "ticket.progress",
  body: "Exact progress",
  kind: "progress",
  replyToId: "",
};
describe("captured participation and completion commands", () => {
  it("retains actual project/membership and original actor/run independently of the list filter", () => {
    const selected = selection(),
      value = draft(progress, selected);
    const moved = {
      ...selected,
      context: {
        ...selected.context,
        writer: { actorId: "other", runId: null },
        route: { ...selected.context.route, projectId: "another-filter" },
      },
    };
    expect(captureProgress(moved).writer.actorId).toBe("other");
    const frozen = preparation(value);
    expect(frozen.context.project_id).toBe("actual-project");
    expect(value.capture.ticket.value.ticket.membership_revision).toBe("9007199254740992");
    expect(frozen.context.writer).toEqual({ actor_id: "author", run_id: "run-one" });
    expect(jsonField(frozen.params, "token")).toEqual(d.jsonString("9007199254740993"));
    expect(jsonField(frozen.params, "project_id")).toBeUndefined();
  });
  it("requires exact optional run ownership for progress but permits an ordinary attributed comment", () => {
    const selected = selection();
    const observed = {
      ...selected,
      context: { ...selected.context, writer: { actorId: "author", runId: null } },
    };
    expect(() => preparation(draft(progress, observed))).toThrow(ProgressInputError);
    const posted = preparation(
      draft(
        {
          method: "comment.add",
          body: "Owner-independent comment",
          kind: "comment",
          replyToId: "",
        },
        observed,
      ),
    );
    expect(jsonField(posted.params, "run_id")).toBeUndefined();
    expect(jsonField(posted.params, "token")).toBeUndefined();
    expect(jsonField(posted.params, "target")).toEqual(json({ kind: "ticket", id: "target" }));
    expect(jsonField(posted.params, "ticket_id")).toBeUndefined();
  });
  it("refuses a ticket read from another endpoint generation or workspace", () => {
    const selected = selection();
    expect(() =>
      captureProgress({
        ...selected,
        context: {
          ...selected.context,
          connection: { ...selected.context.connection, generation: decode(d.decimal, "2") },
        },
      }),
    ).toThrow(/another endpoint/u);
    expect(() =>
      captureProgress({
        ...selected,
        scope: { ...selected.scope, workspaceId: decode(d.identifier, "other") },
      }),
    ).toThrow(/another endpoint/u);
  });
  it("requires a captured handoff guard; confirmed absence uses zero without inventing a claim", () => {
    const value = draft(
      {
        method: "handoff.set",
        fields: {
          ...EMPTY_HANDOFF,
          summary: "Handoff",
          nextSteps: "Next",
          evidence: "Observed evidence",
        },
      },
      selection(false),
    );
    expect(() => preparation(value)).toThrow(/Read the current handoff/u);
    const frozen = preparation({ ...value, guards: { ...value.guards, handoff: null } });
    expect(jsonField(frozen.params, "expected_revision")).toEqual(d.jsonString("0"));
    expect(jsonField(frozen.params, "token")).toBeUndefined();
    expect(jsonField(frozen.params, "covers_through")).toEqual(d.jsonString("0"));
  });
  it("keeps attempt outcome distinct from ticket completion and retains the original claim requirement", () => {
    const value = draft(
      {
        method: "attempt.finish",
        attemptId: "original-attempt",
        state: "failed",
        evidence: "Observed failure; process lifecycle external",
      },
      selection(true),
    );
    const guarded = { ...value, guards: { ...value.guards, attempt: attempt() } };
    const frozen = preparation(guarded);
    expect(frozen.method).toBe("attempt.finish");
    expect(jsonField(frozen.params, "expected_revision")).toEqual(d.jsonString("9007199254740995"));
    expect(jsonField(frozen.params, "ticket_id")).toBeUndefined();
    expect(jsonField(frozen.params, "token")).toBeUndefined();
    const unclaimed = captureProgress(selection(false));
    expect(() =>
      preparation({
        ...guarded,
        capture: unclaimed,
        input: {
          method: "attempt.finish",
          attemptId: "original-attempt",
          state: "completed",
          evidence: "complete",
        },
      }),
    ).toThrow(/current claim/u);
    expect(() => preparation({ ...guarded, capture: unclaimed })).toThrow(/current claim/u);
  });
  it("rejects guarded attempts from another run/ticket instead of reusing their revision", () => {
    const value = draft({
      method: "attempt.checkpoint",
      attemptId: "original-attempt",
      checkpointKind: "resource",
      targetId: "source",
      revision: "9",
    });
    for (const wrong of [
      { ...attempt(), ticketId: decode(d.identifier, "other") },
      { ...attempt(), runId: decode(d.identifier, "other-run") },
    ])
      expect(() => preparation({ ...value, guards: { ...value.guards, attempt: wrong } })).toThrow(
        /exact attempt/u,
      );
  });
  it("binds comment revisions to both original author and exact ticket", () => {
    const value = draft({ method: "comment.edit", commentId: "comment", body: "Exact edit" });
    const good = preparation({ ...value, guards: { ...value.guards, comment: comment() } });
    expect(jsonField(good.params, "expected_revision")).toEqual(d.jsonString("9007199254740996"));
    for (const wrong of [
      comment("other"),
      comment("target", "other"),
      { ...comment(), origin: "completion" as const },
    ])
      expect(() => preparation({ ...value, guards: { ...value.guards, comment: wrong } })).toThrow(
        ProgressInputError,
      );
  });
  it("uses one explicit finish request and excludes invalid nested handoff evidence/duplicate keys", () => {
    const value = draft({
      method: "ticket.finish",
      evidence: "Completion evidence",
      handoff: {
        ...EMPTY_HANDOFF,
        summary: "Done",
        nextSteps: "Review evidence",
        evidence: "Not a nested wire field",
        resourceIds: "source\nreport",
      },
    });
    const frozen = preparation(value),
      handoff = jsonField(frozen.params, "handoff");
    expect(new Set(frozen.params.fields.map((field) => field.name)).size).toBe(
      frozen.params.fields.length,
    );
    expect(handoff?.kind).toBe("object");
    if (handoff?.kind !== "object") throw new Error("Missing finish handoff");
    expect(jsonField(handoff, "evidence")).toBeUndefined();
    expect(jsonField(handoff, "resource_ids")).toEqual(json(["source", "report"]));
    expect(jsonField(frozen.params, "evidence")).toEqual(d.jsonString("Completion evidence"));
  });
  it("preserves exact decimal reopen guard and validates UTF-8 bytes instead of character counts", () => {
    const frozen = preparation(
      draft({ method: "ticket.reopen", reason: "Verified additional work" }),
    );
    expect(jsonField(frozen.params, "expected_revision")).toEqual(d.jsonString("9007199254740993"));
    expect(jsonField(frozen.params, "reason")).toEqual(d.jsonString("Verified additional work"));
    expect(() => preparation(draft({ method: "ticket.reopen", reason: " " }))).toThrow(/nonblank/u);
    const ascii: ProgressInput = { ...progress, body: "a" },
      unicode: ProgressInput = { ...progress, body: "é" };
    expect(inputBytes(unicode) - inputBytes(ascii)).toBe(1);
    expect(() => preparation(draft({ ...progress, body: "é".repeat(32769) }))).toThrow(
      /65536 UTF-8/u,
    );
    expect(() => preparation(draft({ ...progress, body: "  " }))).toThrow(/nonblank/u);
  });
});

describe("conversation timeline", () => {
  it("retains overlapping pages and prefers newer edits and tombstones", () => {
    const original = comment(),
      edited = { ...original, revision: decode(d.decimal, "9007199254740997"), body: "edited" },
      removed = { ...edited, revision: decode(d.decimal, "9007199254740998"), tombstone: true },
      other = { ...original, id: decode(d.identifier, "other"), sequence: decode(d.decimal, "6") };
    expect(mergeCommentTimeline([original, other], [edited], [original])).toEqual([edited, other]);
    expect(mergeCommentTimeline([removed], [edited])).toEqual([removed]);
  });
  it("orders exact counters chronologically without mutating earlier pages", () => {
    const newer = {
      ...comment(),
      id: decode(d.identifier, "new"),
      sequence: decode(d.decimal, "9007199254740994"),
    };
    const older = { ...comment(), sequence: decode(d.decimal, "9007199254740993") };
    const first = [newer];
    expect(mergeCommentTimeline(first, [older]).map((item) => item.id)).toEqual([
      older.id,
      newer.id,
    ]);
    expect(first).toEqual([newer]);
  });
});
