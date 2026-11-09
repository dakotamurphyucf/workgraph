import type { HttpResult } from "../../core/protocol/http";
import type { Capture, Continuation, Page, Ticket } from "./read-model.types";

/** A complete logical collection from one native revision. Continuations remain
 * daemon-authored; failed or stale traversals never publish mixed-revision rows.
 * Partial text and byte-limit stops remain explicit in the returned capture. */
export async function readTicketCollection(
  first: Continuation,
  read: (request: Continuation) => Promise<HttpResult<Capture<Page<Ticket>>>>,
  signal: AbortSignal,
): Promise<HttpResult<Capture<Page<Ticket>>>> {
  let request = first;
  let initialOffset: Page<Ticket>["offset"] | undefined;
  let previous: Capture<Page<Ticket>> | undefined;
  const items: Ticket[] = [],
    ids = new Set<string>();
  let partial = false;
  while (!signal.aborted) {
    const result = await read(request);
    if (!result.ok) return result;
    const capture = result.data;
    initialOffset ??= capture.value.offset;
    if (
      previous &&
      (capture.revision !== previous.revision ||
        BigInt(capture.value.offset) !==
          BigInt(previous.value.offset) + BigInt(previous.value.items.length))
    ) {
      return {
        ok: false,
        failure: {
          kind: "protocol",
          message: "Ticket collection changed while loading. Refresh to read a consistent view.",
          issue: undefined,
        },
      };
    }
    for (const item of capture.value.items) {
      if (ids.has(item.ticket_id))
        return {
          ok: false,
          failure: {
            kind: "protocol",
            message: "Repeated ticket in a captured collection.",
            issue: undefined,
          },
        };
      ids.add(item.ticket_id);
      items.push(item);
    }
    partial ||= capture.partial;
    const control = capture.controls.find((value) => value.path === "/data");
    if (!control?.next)
      return {
        ...result,
        data: { ...capture, partial, value: { ...capture.value, offset: initialOffset, items } },
      };
    if (capture.value.items.length === 0)
      return {
        ok: false,
        failure: {
          kind: "protocol",
          message: "Ticket continuation did not advance.",
          issue: undefined,
        },
      };
    previous = capture;
    request = control.next;
  }
  return { ok: false, failure: { kind: "aborted" } };
}
