import { describe, expect, it, vi } from "vitest";
import type {
  ContentWorkerClient,
  ContentPreview,
  RenderRequest,
  WorkOutcome,
} from "../../../src/content";
import { createTranscriptRenderLane } from "../../../src/features/history/transcript/render-lane";
const request = (key: string): RenderRequest => ({
  key,
  bytes: new TextEncoder().encode(key),
  hints: {},
  override: "auto",
  mode: "rendered",
  startLine: 0,
  rawOffset: 0,
});
const outcome: WorkOutcome<ContentPreview> = {
  ok: false,
  kind: "input",
  message: "Exact worker outcome",
};
describe("transcript preview admission", () => {
  it("serializes a full event window and removes canceled previews before admission", async () => {
    const started: string[] = [],
      pending: ((value: WorkOutcome<ContentPreview>) => void)[] = [];
    const client: ContentWorkerClient = {
      render: (r) => {
        started.push(r.key);
        return new Promise((resolve) => pending.push(resolve));
      },
      decodeJson: () => Promise.reject(new Error("unused")),
      dispose: () => {},
    };
    const lane = createTranscriptRenderLane(client);
    const cancel = new AbortController();
    const first = lane.render(request("first"));
    const canceled = lane.render(request("canceled"), cancel.signal);
    const remaining = Array.from({ length: 16 }, (_, i) => lane.render(request(String(i))));
    cancel.abort();
    expect(await canceled).toMatchObject({ ok: false, kind: "cancelled" });
    await vi.waitFor(() => expect(started).toEqual(["first"]));
    pending.shift()!(outcome);
    expect(await first).toEqual(outcome);
    for (let i = 0; i < 16; i++) {
      await vi.waitFor(() => expect(started).toHaveLength(i + 2));
      pending.shift()!(outcome);
      expect(await remaining[i]).toEqual(outcome);
    }
    expect(started).not.toContain("canceled");
    lane.dispose();
  });
  it("preserves unexpected exceptions and still admits the next job", async () => {
    const problem = new Error("worker defect");
    let count = 0;
    const client: ContentWorkerClient = {
      render: () => {
        if (count++ === 0) throw problem;
        return Promise.resolve(outcome);
      },
      decodeJson: () => Promise.reject(new Error("unused")),
      dispose: () => {},
    };
    const lane = createTranscriptRenderLane(client);
    const first = lane.render(request("first"));
    const next = lane.render(request("next"));
    await expect(first).rejects.toBe(problem);
    expect(await next).toEqual(outcome);
    lane.dispose();
  });
});
