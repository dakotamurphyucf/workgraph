import { expect, type Page, type Request } from "@playwright/test";
interface Reads {
  readonly pending: Set<Request>;
  lastActivity: number;
}
const trackers = new WeakMap<Page, Reads>();
/** Register before navigation. Snapshotting historical Page.requests objects does
 * not reliably retain response-completion events, so track the real lifecycle. */
export function trackPageReads(page: Page): void {
  if (trackers.has(page)) return;
  const state: Reads = { pending: new Set(), lastActivity: Date.now() };
  trackers.set(page, state);
  const relevant = (request: Request) =>
    !(
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/ui-api/v1/live-observations"
    );
  const start = (request: Request) => {
    if (!relevant(request)) return;
    state.pending.add(request);
    state.lastActivity = Date.now();
  };
  const finish = (request: Request) => {
    if (state.pending.delete(request)) state.lastActivity = Date.now();
  };
  page.on("request", start);
  page.on("requestfinished", finish);
  page.on("requestfailed", finish);
  page.once("close", () => {
    page.off("request", start);
    page.off("requestfinished", finish);
    page.off("requestfailed", finish);
    trackers.delete(page);
  });
}
/** A healthy live page never becomes network-idle. Wait for ordinary requests
 * and response bodies plus 500ms quiet instead, excluding only live observation.
 * Failures remain checked by fixture diagnostics and visible UI assertions. */
export async function waitForPageReads(page: Page): Promise<void> {
  const state = trackers.get(page);
  if (!state) throw new Error("Register trackPageReads before navigating a test page");
  await expect
    .poll(
      () =>
        state.pending.size > 0
          ? [...state.pending].map((request) => request.url())
          : Date.now() - state.lastActivity >= 500
            ? []
            : ["settling"],
      { timeout: 15000, intervals: [50] },
    )
    .toEqual([]);
}
