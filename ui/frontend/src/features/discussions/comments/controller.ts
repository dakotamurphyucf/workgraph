import { jsonField } from "../../../core/json";
import { createCompanion } from "../../../core/protocol/client";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { HttpResult } from "../../../core/protocol/http";
import { createReadSlot } from "../../../core/state/read-slot";
import { comment } from "../threads/codecs";

import type {
  CommentCapture,
  CommentController,
  CommentOptions,
  CommentReader,
  CommentSelection,
} from "./types";
const invalid = (message: string): HttpResult<never> => ({
  ok: false,
  failure: { kind: "protocol", message, issue: undefined },
});
export const commentKey = (selection: CommentSelection) =>
  JSON.stringify([
    selection.connectionId,
    selection.generation,
    selection.workspaceId,
    selection.commentId,
    selection.revision,
  ]);
export function createCommentReader({ http }: CommentOptions): CommentReader {
  const companion = createCompanion(http);
  return async (input, signal) => {
    const selection = Object.freeze({ ...input });
    const profile = await http.request({
      path: `/connections/${encodeURIComponent(selection.connectionId)}/generations/${selection.generation}`,
      method: "GET",
      codec: d.connectionProfile,
      signal,
    });
    if (!profile.ok) return profile;
    if (
      profile.data.id !== selection.connectionId ||
      profile.data.generation !== selection.generation
    )
      return invalid("Pinned comment endpoint identity changed.");
    if (signal.aborted) return { ok: false, failure: { kind: "aborted" } };
    const result = await companion.read(
      {
        connection_id: selection.connectionId,
        generation: selection.generation,
        lane: "visible",
        method: "comment.history",
        params: d.jsonObject([
          ["workspace_id", d.jsonString(selection.workspaceId)],
          ["comment_id", d.jsonString(selection.commentId)],
          ["include_archived", d.jsonBoolean(true)],
          ["offset", d.jsonString(String(BigInt(selection.revision) - 1n))],
          ["limit", d.jsonString("1")],
          ["max_bytes", d.jsonString("65536")],
        ]),
      },
      signal,
    );
    if (!result.ok) return result;
    const decoded = c
        .record({
          items: c.array(comment, 1),
          offset: d.decimal,
          remaining: d.decimal,
          next_offset: c.nullable(d.decimal),
        })
        .decode(result.data.response.data),
      revision = d.decimal.decode(jsonField(result.data.response.meta, "workspace_revision"));
    if (
      !decoded.ok ||
      !revision.ok ||
      decoded.value.offset !== String(BigInt(selection.revision) - 1n) ||
      decoded.value.items.length !== 1 ||
      (decoded.value.remaining === "0"
        ? decoded.value.next_offset !== null
        : decoded.value.next_offset !== String(BigInt(decoded.value.offset) + 1n))
    )
      return invalid(
        "The exact comment revision is unavailable or omitted. Current text was not substituted.",
      );
    const record = decoded.value.items[0];
    if (
      record === undefined ||
      record.id !== selection.commentId ||
      record.revision !== selection.revision
    )
      return invalid("Comment history changed the requested identity or revision.");
    const budget = jsonField(result.data.response.meta, "budget"),
      truncated = c.boolean.decode(jsonField(budget ?? d.jsonNull(), "truncated")),
      fields = d.decimal.decode(jsonField(budget ?? d.jsonNull(), "omitted_fields")),
      items = d.decimal.decode(jsonField(budget ?? d.jsonNull(), "omitted_items"));
    const partial =
      !truncated.ok ||
      !fields.ok ||
      !items.ok ||
      truncated.value ||
      fields.value !== "0" ||
      items.value !== "0";
    return {
      ok: true,
      httpStatus: result.httpStatus,
      data: {
        selection,
        connection: profile.data,
        comment: record,
        planningRevision: revision.value,
        partial,
        response: result.data,
      },
    };
  };
}
export function createCommentStore(read: CommentReader): CommentController {
  const slot = createReadSlot<CommentCapture>();
  return {
    get: slot.get,
    subscribe: slot.subscribe,
    async select(input) {
      const selection = Object.freeze({ ...input });
      try {
        await slot.load(commentKey(selection), (signal) => read(selection, signal));
      } catch {
        /* Owned failures stay in the read state; superseded failures have no owner. */
      }
    },
    cancel: slot.clear,
    dispose: slot.dispose,
  };
}
export function createCommentController(options: CommentOptions): CommentController {
  return createCommentStore(createCommentReader(options));
}
