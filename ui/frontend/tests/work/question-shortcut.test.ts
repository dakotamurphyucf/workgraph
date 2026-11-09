import { expect, it, vi } from "vitest";
import { askAboutTicket } from "../../src/features/work/actions/ask-ticket";
import { createRequestsController } from "../../src/features/discussions/requests/controller";
import { createOperationController } from "../../src/core/state/operations";
import type { HttpClient } from "../../src/core/protocol/http";
import { createTestProcessor } from "../core/processing-harness";
import { context, target } from "./actions-fixtures";

it("question shortcut uses actual ticket membership and keeps writer without sending or choosing recipients", () => {
  const processing = createTestProcessor();
  const unexpected = vi.fn((): Promise<never> =>
    Promise.reject(new Error("No transport expected")),
  );
  const client: HttpClient = { processing, request: unexpected };
  const operations = createOperationController(
    {
      connections: unexpected,
      read: unexpected,
      prepare: unexpected,
      inspect: unexpected,
      act: unexpected,
    },
    processing,
  );
  const controller = createRequestsController({ http: client, operations });
  const navigate = vi.fn(),
    selection = target(client),
    ctx = { ...context(client), navigate };
  try {
    expect(ctx.route.projectId).not.toBe(selection.ticket.value.ticket.project_id);
    askAboutTicket(controller, {
      ...selection,
      context: ctx,
      detail: null,
      intent: null,
      clearIntent: () => undefined,
    });
    const draft = controller.get().drafts[0];
    expect(draft?.input).toMatchObject({
      method: "request.ask",
      destination: { kind: "new", ticketId: "target" },
      fields: { resolverId: "", recipients: [] },
    });
    expect(draft?.context.writer).toEqual(ctx.writer);
    expect(navigate.mock.calls[0]?.[0]).toMatchObject({
      view: "discussions",
      projectId: selection.ticket.value.ticket.project_id,
      requests: { kind: "requests", generation: "1" },
    });
    expect(controller.get().selectedDraftId).toBe(draft?.id);
    expect(operations.list()).toHaveLength(0);
    expect(unexpected).not.toHaveBeenCalled();
  } finally {
    controller.dispose();
    operations.dispose();
    processing.dispose();
  }
});
