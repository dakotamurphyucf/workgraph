import type { JsonValue } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { JsonObject } from "../../../core/protocol/types";
import type {
  Board,
  Comment,
  DirectMessage,
  DiscussionLink,
  DiscussionScope,
  MessageBody,
  MessagePage,
  Page,
  Recipient,
  RelatedMessages,
  Thread,
} from "./types";
type Values<S> = { readonly [K in keyof S]: S[K] extends c.Codec<infer T> ? T : never };
const nullValue: c.Codec<null> = {
  decode: (value: JsonValue | undefined, path = []) =>
    value?.kind === "null" ? { ok: true, value: null } : c.mismatch(path, "null"),
};
/** Daemon records are projected without dropping their original raw fields.
 * Companion DTOs remain closed in the shared HTTP decoder. */
export function fields<S extends Readonly<Record<string, c.Codec<unknown>>>>(
  shape: S,
): c.Codec<Values<S>> {
  const names = new Set(Object.keys(shape)),
    codec = c.record(shape);
  return {
    decode(value, path = []) {
      if (value?.kind !== "object") return c.mismatch(path, "daemon record");
      return codec.decode(
        { kind: "object", fields: value.fields.filter((field) => names.has(field.name)) },
        path,
      );
    },
  };
}
function project<A, B>(codec: c.Codec<A>, map: (value: A, raw: JsonObject) => B): c.Codec<B> {
  return {
    decode(value, path = []) {
      if (value?.kind !== "object") return c.mismatch(path, "daemon record");
      const decoded = codec.decode(value, path);
      return decoded.ok ? { ok: true, value: Object.freeze(map(decoded.value, value)) } : decoded;
    },
  };
}
export function choice<const T extends string>(values: readonly T[]): c.Codec<T> {
  return {
    decode(value, path = []) {
      const decoded = c.text.decode(value, path);
      if (!decoded.ok) return decoded;
      const item = values.find((item) => item === decoded.value);
      return item === undefined ? c.mismatch(path, values.join(" | ")) : { ok: true, value: item };
    },
  };
}
export const scope: c.Codec<DiscussionScope> = c.tagged<DiscussionScope>("kind", {
  workspace: c.record({ kind: c.literal("workspace") }),
  project: c.record({ kind: c.literal("project"), id: d.identifier }),
});
export const link: c.Codec<DiscussionLink> = c.tagged<DiscussionLink>("kind", {
  workspace: c.record({ kind: c.literal("workspace") }),
  project: c.record({ kind: c.literal("project"), id: d.identifier }),
  milestone: c.record({ kind: c.literal("milestone"), id: d.identifier }),
  ticket: c.record({ kind: c.literal("ticket"), id: d.identifier }),
  resource: c.record({ kind: c.literal("resource"), id: d.identifier }),
});
export const recipient: c.Codec<Recipient> = c.tagged<Recipient>("kind", {
  actor: c.record({ kind: c.literal("actor"), id: d.identifier }),
  run: c.record({ kind: c.literal("run"), id: d.identifier }),
});
export const board: c.Codec<Board> = project(
  fields({ board_id: d.identifier, revision: d.positiveDecimal, title: c.text, scope }),
  (value, raw) => ({
    id: value.board_id,
    revision: value.revision,
    title: value.title,
    scope: value.scope,
    raw,
  }),
);
export const comment: c.Codec<Comment> = project(
  c.refine(
    fields({
      comment_id: d.identifier,
      target: link,
      author_id: d.identifier,
      created_at: c.text,
      reply_to_comment_id: c.nullable(d.identifier),
      kind: choice(["comment", "progress", "decision", "blocker", "evidence"]),
      origin: choice(["authored", "completion"]),
      revision: d.positiveDecimal,
      serial: d.positiveDecimal,
      sequence: d.positiveDecimal,
      actor_id: d.identifier,
      timestamp: c.text,
      body: c.text,
      tombstone: c.boolean,
    }),
    (value) => !value.tombstone || value.body === "",
    "tombstone with preserved provenance and empty current body",
  ),
  (value, raw) => ({
    id: value.comment_id,
    target: value.target,
    authorId: value.author_id,
    createdAt: value.created_at,
    replyToId: value.reply_to_comment_id,
    kind: value.kind,
    origin: value.origin,
    revision: value.revision,
    serial: value.serial,
    sequence: value.sequence,
    actorId: value.actor_id,
    timestamp: value.timestamp,
    body: value.body,
    tombstone: value.tombstone,
    raw,
  }),
);
export function page<T>(item: c.Codec<T>): c.Codec<Page<T>> {
  return project(
    c.refine(
      fields({
        items: c.array(item, 100),
        offset: d.decimal,
        remaining: d.decimal,
        next_offset: c.nullable(d.decimal),
      }),
      (value) =>
        value.remaining === "0"
          ? value.next_offset === null
          : value.next_offset === String(BigInt(value.offset) + BigInt(value.items.length)),
      "page cursor matching returned item count and remaining coverage",
    ),
    (value) => ({
      items: value.items,
      offset: value.offset,
      remaining: value.remaining,
      nextOffset: value.next_offset,
    }),
  );
}
const related: c.Codec<RelatedMessages> = project(
  fields({
    thread_id: d.identifier,
    thread_revision: d.positiveDecimal,
    discussion_serial: d.decimal,
    messages: page(comment),
  }),
  (value) => ({
    threadId: value.thread_id,
    threadRevision: value.thread_revision,
    discussionSerial: value.discussion_serial,
    messages: value.messages,
  }),
);
export const thread: c.Codec<Thread> = project(
  c.refine(
    fields({
      thread_id: d.identifier,
      revision: d.positiveDecimal,
      board_id: d.identifier,
      title: c.text,
      participants: c.array(d.identifier, 1000),
      mentions: c.array(d.identifier, 1000),
      links: c.array(link, 100),
      state: choice(["open", "awaiting_response", "resolved"]),
      closure_policy: choice(["manual", "when_all_requests_terminal"]),
      pinned: c.boolean,
      comment_ids: c.array(d.identifier, 100000),
      pinned_comment_ids: c.array(d.identifier, 100000),
      related: c.optional(related),
    }),
    (value) =>
      value.related === undefined ||
      (value.related.threadId === value.thread_id &&
        value.related.threadRevision === value.revision),
    "related messages belonging to this exact thread metadata revision",
  ),
  (value, raw) => ({
    id: value.thread_id,
    revision: value.revision,
    boardId: value.board_id,
    title: value.title,
    participants: value.participants,
    mentions: value.mentions,
    links: value.links,
    status: value.state,
    closurePolicy: value.closure_policy,
    pinned: value.pinned,
    commentIds: value.comment_ids,
    pinnedCommentIds: value.pinned_comment_ids,
    related: value.related,
    raw,
  }),
);
const body: c.Codec<MessageBody> = project(
  c.refine(
    fields({
      comment_id: d.identifier,
      revision: d.positiveDecimal,
      serial: d.positiveDecimal,
      actor_id: d.identifier,
      timestamp: c.text,
      body: c.text,
      tombstone: c.boolean,
      version_kind: c.literal("captured"),
    }),
    (value) => !value.tombstone || value.body === "",
    "captured body tombstone with empty body",
  ),
  (value, raw) => ({
    commentId: value.comment_id,
    revision: value.revision,
    serial: value.serial,
    actorId: value.actor_id,
    timestamp: value.timestamp,
    body: value.body,
    tombstone: value.tombstone,
    versionKind: value.version_kind,
    raw,
  }),
);
const causalBody = project(
  fields({ comment_id: d.identifier, revision: d.positiveDecimal }),
  (value) => ({ commentId: value.comment_id, revision: value.revision }),
);
const directMessage: c.Codec<DirectMessage> = project(
  c.refine(
    fields({
      notification_id: d.positiveDecimal,
      sequence: d.positiveDecimal,
      kind: c.literal("message_received"),
      scope,
      source: c.record({ kind: c.literal("message"), id: d.identifier }),
      source_revision: d.positiveDecimal,
      source_current_revision: d.positiveDecimal,
      ticket_ids: c.array(d.identifier, 1024),
      attribution: fields({
        actor_id: d.identifier,
        run_id: c.nullable(d.identifier),
        timestamp: c.text,
      }),
      body_source: c.nullable(body),
      causal_body: c.nullable(causalBody),
      request_status: nullValue,
    }),
    (value) =>
      BigInt(value.source_current_revision) >= BigInt(value.source_revision) &&
      (value.body_source === null ||
        (value.body_source.revision === "1" &&
          value.causal_body !== null &&
          value.body_source.commentId === value.causal_body.commentId &&
          value.body_source.revision === value.causal_body.revision)),
    "message source revision and initial pinned body association",
  ),
  (value, raw) => ({
    notificationId: value.notification_id,
    sequence: value.sequence,
    messageId: value.source.id,
    sourceRevision: value.source_revision,
    sourceCurrentRevision: value.source_current_revision,
    ticketIds: value.ticket_ids,
    actorId: value.attribution.actor_id,
    runId: value.attribution.run_id,
    timestamp: value.attribution.timestamp,
    body: value.body_source,
    causalBody: value.causal_body,
    raw,
  }),
);
export const messages: c.Codec<MessagePage> = project(
  c.refine(
    fields({
      consumer_id: d.identifier,
      recipient,
      after: d.decimal,
      through: d.decimal,
      next_after: d.decimal,
      remaining: d.decimal,
      exclude_self: c.boolean,
      items: c.array(directMessage, 100),
    }),
    (value) => {
      let previous = BigInt(value.after);
      const through = BigInt(value.through);
      if (previous > through) return false;
      for (const item of value.items) {
        const id = BigInt(item.notificationId);
        if (id <= previous || id > through) return false;
        previous = id;
      }
      return previous === BigInt(value.next_after);
    },
    "message notifications strictly increasing within captured interval",
  ),
  (value) => ({
    consumerId: value.consumer_id,
    recipient: value.recipient,
    after: value.after,
    through: value.through,
    nextAfter: value.next_after,
    remaining: value.remaining,
    items: value.items,
  }),
);
