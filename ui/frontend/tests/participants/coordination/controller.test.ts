import { afterEach, describe, expect, it } from "vitest";
import * as d from "../../../src/core/protocol/decoders";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import { createCoordinationController } from "../../../src/features/participants/coordination/controller";
import { harness, ok, text } from "../runs/harness";
import { decode, deferred, json, response } from "../runs/fixtures";
import type { ReadResponse } from "../../../src/core/protocol/types";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanup.splice(0).reverse()) done();
});
const empty = () =>
  response(
    { items: [], next_offset: null, omitted: "0" },
    { query_scope: "runs", query_revision: "9" },
  );
function setup(
  read?: (method: string, signal: AbortSignal | undefined) => Promise<HttpResult<ReadResponse>>,
) {
  const base = harness({
    read: (method, _params, signal) => read?.(method, signal) ?? Promise.resolve(ok(empty())),
  });
  const http: HttpClient = {
    processing: base.http.processing,
    request: <T>(request: HttpRequest<T>): Promise<HttpResult<T>> => {
      if (request.method === "GET" && request.path.startsWith("/reservation-waits?")) {
        const parsed = request.codec.decode(
          json({ items: [], offset: "0", remaining: "0", next_offset: null }),
        );
        if (!parsed.ok) throw new Error(parsed.issue.expected);
        return Promise.resolve(ok(parsed.value));
      }
      return base.http.request(request);
    },
  };
  const controller = createCoordinationController({ http, operations: base.operations });
  cleanup.push(controller.dispose);
  return { ...base, http, controller, context: { ...base.context, client: http } };
}
describe("Coordination retained intentions and owned reads", () => {
  it("copies inputs and writer before deferred guards; coalesces one review and keeps original endpoint", async () => {
    const pending = deferred<HttpResult<ReadResponse>>();
    let queries = 0;
    const h = setup(() => {
      queries++;
      return pending.promise;
    });
    const input = { kind: "pool" as const, name: "compiler", limit: "2" };
    h.controller.open(h.context, input);
    const id = h.controller.get().selectedDraftId!;
    input.name = "changed";
    input.limit = "9";
    const reviewing = h.controller.review(id),
      second = h.controller.review(id);
    Reflect.set(h.context, "writer", { actorId: "another", runId: null });
    pending.resolve(ok(empty()));
    await Promise.all([reviewing, second]);
    expect(queries).toBe(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.context.writer).toEqual({ actor_id: "author", run_id: "run" });
    expect(text(h.sent[0]?.params, "name")).toBe("compiler");
    expect(text(h.sent[0]?.params, "limit")).toBe("2");
    expect(h.controller.get().drafts[0]?.phase.kind).toBe("registered");
    h.controller.edit(id, { kind: "pool", name: "later", limit: "3" });
    expect(h.controller.get().drafts[0]?.input).toMatchObject({ name: "compiler" });
  });
  it("retains invalid source for explicit repair and never calls mutation before ordinary Review", async () => {
    const h = setup();
    h.controller.open(h.context, { kind: "pool", name: "compiler", limit: "0" });
    const id = h.controller.get().selectedDraftId!;
    expect(h.sent).toHaveLength(0);
    await h.controller.review(id);
    expect(h.sent).toHaveLength(0);
    expect(h.controller.get().drafts[0]?.phase.kind).toBe("editing");
    expect(h.controller.get().drafts[0]?.issue).not.toBeNull();
    h.controller.edit(id, { kind: "pool", name: "compiler", limit: "2" });
    await h.controller.review(id);
    expect(h.sent).toHaveLength(1);
  });
  it("uses actual ticket project membership and rejects a substituted identity", async () => {
    let wrong = false;
    const h = setup((method) =>
      Promise.resolve(
        ok(
          method === "ticket.read"
            ? response(
                { ticket: { ticket_id: wrong ? "other" : "task", project_id: "actual-project" } },
                { workspace_revision: "9" },
              )
            : empty(),
        ),
      ),
    );
    const open = () =>
      h.controller.open(h.context, {
        kind: "paths",
        ticketId: "task",
        requireReservations: true,
        paths: [],
      });
    open();
    await h.controller.review(h.controller.get().selectedDraftId!);
    expect(h.sent[0]?.context.project_id).toBe("actual-project");
    wrong = true;
    open();
    await h.controller.review(h.controller.get().selectedDraftId!);
    expect(h.sent).toHaveLength(1);
    expect(h.controller.get().drafts.at(-1)?.issue).toMatch(/identity/);
  });
  it("does not republish a superseded same-target read rejection and retains current unexpected failure", async () => {
    let rejectOld: (error: Error) => void = () => {
      throw new Error("not started");
    };
    let first = true;
    const h = setup(() => {
      if (first) {
        first = false;
        return new Promise((_resolve, reject) => {
          rejectOld = reject;
        });
      }
      return Promise.resolve(ok(empty()));
    });
    h.controller.select(h.context);
    h.controller.tab("allocation");
    h.controller.refresh();
    await new Promise((done) => setTimeout(done, 0));
    rejectOld(new Error("obsolete"));
    await new Promise((done) => setTimeout(done, 0));
    expect(h.controller.get().unexpected).toBeNull();
    expect(h.controller.get().page.kind).toBe("ready");
  });
  it("does not transplant an exact retained participant link into current coordination reads", () => {
    const h = setup();
    h.controller.select({
      ...h.context,
      route: {
        ...h.context.route,
        participant: { kind: "run", generation: decode(d.positiveDecimal, "1") },
        entityId: "old-run",
      },
    });
    expect(h.controller.get().scope).toBeNull();
    expect(h.calls).toHaveLength(0);
    expect(h.controller.get().issue).toMatch(/older endpoint/);
  });
});
