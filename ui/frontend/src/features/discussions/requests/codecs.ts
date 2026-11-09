import type { JsonValue } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { JsonObject } from "../../../core/protocol/types";
import { choice, comment, fields, link, page, recipient, scope } from "../threads/codecs";
import type {
  Attribution,
  CommentPin,
  CurrentRequest,
  InboxPage,
  ListedRequest,
  Notification,
  RequestRecord,
  RequestStatus,
  Responsibility,
  Subscription,
  Team,
  ThreadSummary,
} from "./types";
export { page } from "../threads/codecs";
export const notificationKinds = [
  "thread_changed",
  "message_received",
  "request_created",
  "request_acknowledged",
  "request_accepted",
  "request_reassigned",
  "request_resolved",
  "request_cancelled",
  "request_updated",
] as const;
export const requestKinds = [
  "clarification",
  "review",
  "help",
  "blocker_resolution",
  "handoff",
] as const;
function project<A, B>(codec: c.Codec<A>, map: (value: A, raw: JsonObject) => B): c.Codec<B> {
  return {
    decode(value, path = []) {
      if (value?.kind !== "object") return c.mismatch(path, "daemon record");
      const decoded = codec.decode(value, path);
      return decoded.ok ? { ok: true, value: Object.freeze(map(decoded.value, value)) } : decoded;
    },
  };
}
export const unixMs = c.refine(
  c.text,
  (value) =>
    /^(0|[1-9][0-9]{0,18})(?![\s\S])/u.test(value) && BigInt(value) <= 9223372036854775807n,
  "canonical nonnegative signed-int64 Unix milliseconds",
);
function boundedText(maximum: number, nonempty = false): c.Codec<string> {
  return c.refine(
    c.text,
    (value) =>
      new TextEncoder().encode(value).byteLength <= maximum && (!nonempty || value.trim() !== ""),
    `text within ${maximum} UTF-8 bytes`,
  );
}
export const attribution: c.Codec<Attribution> = project(
  fields({
    actor_id: d.identifier,
    run_id: c.nullable(d.identifier),
    timestamp: boundedText(128, true),
  }),
  (v) => ({ actorId: v.actor_id, runId: v.run_id, timestamp: v.timestamp }),
);
export const commentPin: c.Codec<CommentPin> = project(
  c.record({ comment_id: d.identifier, revision: d.positiveDecimal }),
  (v) => ({ id: v.comment_id, revision: v.revision }),
);
export const status: c.Codec<RequestStatus> = c.tagged<RequestStatus>("kind", {
  open: c.record({ kind: c.literal("open") }),
  resolved: c.record({ kind: c.literal("resolved"), attribution, answer: c.nullable(commentPin) }),
  cancelled: c.record({ kind: c.literal("cancelled"), attribution }),
});
export const responsibility: c.Codec<Responsibility> = c.tagged<Responsibility>("kind", {
  unaccepted: c.record({ kind: c.literal("unaccepted") }),
  accepted: c.record({ kind: c.literal("accepted"), recipient, attribution }),
});
const requestShape = {
  request_id: d.identifier,
  revision: d.positiveDecimal,
  thread_id: d.identifier,
  kind: choice(requestKinds),
  comment_id: d.identifier,
  comment_revision: d.positiveDecimal,
  correlation_id: c.nullable(boundedText(128)),
  reply_to_request_id: c.nullable(d.identifier),
  deadline_unix_ms: c.nullable(unixMs),
  priority: c.refine(d.decimal, (v) => BigInt(v) <= 4n, "priority0..4"),
  related_request_ids: c.array(d.identifier, 32),
  supersedes_request_ids: c.array(d.identifier, 32),
  resolver_id: d.identifier,
  created: attribution,
  deliveries: c.array(c.record({ recipient, acknowledged: c.nullable(attribution) }), 1000),
  responsibility,
  status,
};
const requestFields = fields(requestShape);
type RequestWire = typeof requestFields extends c.Codec<infer T> ? T : never;
function requestValue(v: RequestWire, raw: JsonObject): RequestRecord {
  return {
    id: v.request_id,
    revision: v.revision,
    threadId: v.thread_id,
    kind: v.kind,
    question: { id: v.comment_id, revision: v.comment_revision },
    correlationId: v.correlation_id,
    replyToId: v.reply_to_request_id,
    deadlineUnixMs: v.deadline_unix_ms,
    priority: v.priority,
    relatedIds: v.related_request_ids,
    supersedesIds: v.supersedes_request_ids,
    resolverId: v.resolver_id,
    created: v.created,
    deliveries: v.deliveries,
    responsibility: v.responsibility,
    status: v.status,
    raw,
  };
}
function requestInvariants(v: RequestWire): boolean {
  const recipients = v.deliveries.map(
    (delivery) => `${delivery.recipient.kind}:${delivery.recipient.id}`,
  );
  return (
    new Set(recipients).size === recipients.length &&
    new Set(v.related_request_ids).size === v.related_request_ids.length &&
    new Set(v.supersedes_request_ids).size === v.supersedes_request_ids.length &&
    (v.responsibility.kind !== "accepted" ||
      recipients.includes(`${v.responsibility.recipient.kind}:${v.responsibility.recipient.id}`))
  );
}
export const request: c.Codec<RequestRecord> = project(
  c.refine(
    requestFields,
    requestInvariants,
    "unique frozen recipients/relations and admitted responsibility",
  ),
  requestValue,
);
const summary: c.Codec<ThreadSummary> = project(
  c.refine(
    fields({
      thread_revision: d.positiveDecimal,
      title: boundedText(512),
      title_bytes: c.refine(
        d.decimal,
        (value) => BigInt(value) <= 512n,
        "original title bytes0..512",
      ),
      scope,
      links: c.array(link, 100),
      link_count: c.refine(d.decimal, (value) => BigInt(value) <= 100n, "original links0..100"),
    }),
    (v) =>
      BigInt(new TextEncoder().encode(v.title).byteLength) <= BigInt(v.title_bytes) &&
      BigInt(v.links.length) <= BigInt(v.link_count),
    "thread summary prefixes within original byte/link totals",
  ),
  (v) => ({
    revision: v.thread_revision,
    title: v.title,
    titleBytes: v.title_bytes,
    scope: v.scope,
    links: v.links,
    linkCount: v.link_count,
  }),
);
export const listedRequest: c.Codec<ListedRequest> = project(
  c.refine(
    fields({ ...requestShape, thread_summary: summary }),
    requestInvariants,
    "consistent listed request recipients and responsibility",
  ),
  (v, raw) => ({ ...requestValue(v, raw), threadSummary: v.thread_summary }),
);
const related = project(
  fields({
    thread_id: d.identifier,
    thread_revision: d.positiveDecimal,
    discussion_serial: d.decimal,
    messages: page(comment),
    request_revision: d.positiveDecimal,
    source_message: comment,
    source_message_version: c.literal("current"),
    source_message_reference: c.record({
      comment_id: d.identifier,
      revision: c.refine(c.raw, (v) => v.kind === "null", "null current-version reference"),
    }),
  }),
  (v) => ({
    threadId: v.thread_id,
    threadRevision: v.thread_revision,
    discussionSerial: v.discussion_serial,
    messages: v.messages,
    requestRevision: v.request_revision,
    currentQuestion: v.source_message,
    currentReferenceId: v.source_message_reference.comment_id,
  }),
);
export const currentRequest: c.Codec<CurrentRequest> = project(
  c.refine(
    fields({
      ...requestShape,
      thread_revision: d.positiveDecimal,
      question: comment,
      answer: c.nullable(comment),
      superseded_by_request_ids: c.array(d.identifier, 100000),
      related: c.optional(related),
    }),
    (v) =>
      requestInvariants(v) &&
      v.question.id === v.comment_id &&
      v.question.revision === v.comment_revision &&
      (v.status.kind === "resolved"
        ? v.status.answer === null
          ? v.answer === null
          : v.answer?.id === v.status.answer.id && v.answer.revision === v.status.answer.revision
        : v.answer === null) &&
      (v.related === undefined ||
        (v.related.threadId === v.thread_id &&
          v.related.threadRevision === v.thread_revision &&
          v.related.requestRevision === v.revision &&
          v.related.currentQuestion.id === v.comment_id &&
          v.related.currentReferenceId === v.comment_id)),
    "request pinned question/answer and labelled current expansion association",
  ),
  (v, raw) => ({
    ...requestValue(v, raw),
    threadRevision: v.thread_revision,
    questionBody: v.question,
    answerBody: v.answer,
    supersededByIds: v.superseded_by_request_ids,
    related: v.related ?? null,
  }),
);
export const team: c.Codec<Team> = project(
  fields({
    team_id: d.identifier,
    revision: d.positiveDecimal,
    title: boundedText(512, true),
    members: c.array(recipient, 1000),
  }),
  (v, raw) => ({ id: v.team_id, revision: v.revision, title: v.title, members: v.members, raw }),
);
export const subscription: c.Codec<Subscription> = project(
  fields({
    subscription_id: d.identifier,
    revision: d.positiveDecimal,
    recipient,
    filter: c.record({
      scope: c.nullable(scope),
      thread_id: c.nullable(d.identifier),
      kinds: c.array(choice(notificationKinds), 9),
    }),
    active: c.boolean,
  }),
  (v, raw) => ({
    id: v.subscription_id,
    revision: v.revision,
    recipient: v.recipient,
    filter: { scope: v.filter.scope, threadId: v.filter.thread_id, kinds: v.filter.kinds },
    active: v.active,
    raw,
  }),
);
const source = c.tagged<Notification["source"]>("kind", {
  thread: c.record({ kind: c.literal("thread"), id: d.identifier }),
  message: c.record({ kind: c.literal("message"), id: d.identifier }),
  request: c.record({ kind: c.literal("request"), id: d.identifier }),
});
const body = project(
  c.refine(
    fields({
      comment_id: d.identifier,
      revision: d.positiveDecimal,
      body: c.text,
      serial: d.positiveDecimal,
      actor_id: d.identifier,
      timestamp: boundedText(128, true),
      tombstone: c.boolean,
      version_kind: c.literal("captured"),
    }),
    (v) => !v.tombstone || v.body === "",
    "empty tombstone body",
  ),
  (v) => ({
    id: v.comment_id,
    revision: v.revision,
    body: v.body,
    serial: v.serial,
    actorId: v.actor_id,
    timestamp: v.timestamp,
    tombstone: v.tombstone,
  }),
);
export const notification: c.Codec<Notification> = project(
  c.refine(
    fields({
      notification_id: d.positiveDecimal,
      sequence: d.positiveDecimal,
      kind: choice(notificationKinds),
      scope,
      source,
      source_revision: d.positiveDecimal,
      source_current_revision: c.nullable(d.positiveDecimal),
      causal_body: c.nullable(commentPin),
      body_source: c.nullable(body),
      attribution,
      request_status: c.nullable(choice(["open", "resolved", "cancelled"])),
      ticket_ids: c.array(d.identifier, 100),
    }),
    (v) =>
      (v.causal_body === null
        ? v.body_source === null
        : v.body_source?.id === v.causal_body.id &&
          v.body_source.revision === v.causal_body.revision) &&
      (v.source_current_revision === null ||
        BigInt(v.source_current_revision) >= BigInt(v.source_revision)) &&
      (v.source.kind === "request" || v.request_status === null),
    "causal captured body and independent current source observation",
  ),
  (v, raw) => ({
    id: v.notification_id,
    sequence: v.sequence,
    kind: v.kind,
    scope: v.scope,
    source: v.source,
    sourceRevision: v.source_revision,
    currentSourceRevision: v.source_current_revision,
    causalBody: v.causal_body,
    capturedBody: v.body_source,
    attribution: v.attribution,
    currentRequestStatus: v.request_status,
    ticketIds: v.ticket_ids,
    raw,
  }),
);
export const inbox: c.Codec<InboxPage> = project(
  c.refine(
    fields({
      consumer_id: d.identifier,
      recipient,
      after: d.decimal,
      through: d.decimal,
      next_after: d.decimal,
      remaining: d.decimal,
      exclude_self: c.boolean,
      items: c.array(notification, 100),
    }),
    (v) => {
      if (BigInt(v.after) > BigInt(v.through)) return false;
      let last = BigInt(v.after);
      for (const item of v.items) {
        const id = BigInt(item.id);
        if (id <= last || id > BigInt(v.through)) return false;
        last = id;
      }
      return BigInt(v.next_after) === last;
    },
    "strictly ordered unread notification IDs inside the retained interval",
  ),
  (v, raw) => ({
    consumerId: v.consumer_id,
    recipient: v.recipient,
    after: v.after,
    through: v.through,
    nextAfter: v.next_after,
    remaining: v.remaining,
    excludeSelf: v.exclude_self,
    items: v.items,
    raw,
  }),
);
/** Decode only selected public fields; the original certified raw value remains
 * available and unknown daemon fields are never silently rewritten. */
export function decode<T>(codec: c.Codec<T>, value: JsonValue) {
  return codec.decode(value);
}
