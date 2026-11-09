import { jsonField } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type { HttpResult } from "../../../core/protocol/http";
import type { ReadInvocation, ReadResponse } from "../../../core/protocol/types";
import { choice, decimal64, fields, holderCodec, targetCodec, text } from "./codecs";
import { complete, invalid } from "./client";
import type { ContentionPage, CoordinationScope } from "./types";

const note = fields({
  target: targetCodec,
  actor_id: d.identifier,
  run_id: d.identifier,
  token: d.positiveDecimal,
  revision: d.positiveDecimal,
  updated_unix_ms: decimal64,
  contents: c.nullable(
    fields({
      note: text(1024),
      expires_unix_ms: decimal64,
      expected_release_unix_ms: c.nullable(decimal64),
    }),
  ),
});
const waiter = fields({
  target: targetCodec,
  actor_id: d.identifier,
  run_id: d.identifier,
  revision: d.positiveDecimal,
  started_unix_ms: decimal64,
  updated_unix_ms: decimal64,
  expires_unix_ms: decimal64,
  note: text(1024),
  state: c.tagged<
    { readonly kind: "waiting" } | { readonly kind: "closed"; readonly reason: string }
  >("kind", {
    waiting: fields({ kind: c.literal("waiting") }),
    closed: fields({ kind: c.literal("closed"), reason: text(512, true) }),
  }),
});
export const contentionRow = c.tagged<import("./types").ContentionRow>("kind", {
  waiter: fields({
    kind: c.literal("waiter"),
    record: waiter,
    run_status: choice(["running", "waiting", "completed", "failed", "cancelled"]),
    phase: choice(["waiting", "closed", "expired", "run_terminal"]),
    elapsed_ms: c.nullable(decimal64),
    clock_regressed: c.boolean,
    advisory: c.literal(true),
  }),
  holder: fields({
    kind: c.literal("holder"),
    target: targetCodec,
    holder: holderCodec,
    note: c.nullable(note),
    note_clock_regressed: c.boolean,
    advisory: c.literal(true),
  }),
});

export function sameTarget(
  a: import("./types").ReservationTarget,
  b: import("./types").ReservationTarget,
): boolean {
  return a.kind === "named"
    ? b.kind === "named" && a.reservation_id === b.reservation_id
    : b.kind === "path" &&
        a.target.worktree_id === b.target.worktree_id &&
        a.target.kind === b.target.kind &&
        a.target.path === b.target.path;
}
/** Same lexical worktree and component overlap as the native path contract.
 * A subtree holder can legitimately be returned for a requested child file. */
export function overlaps(
  a: import("./types").ReservationTarget,
  b: import("./types").ReservationTarget,
): boolean {
  if (a.kind === "named" || b.kind === "named")
    return a.kind === "named" && b.kind === "named" && a.reservation_id === b.reservation_id;
  if (a.target.worktree_id !== b.target.worktree_id) return false;
  const contains = (parent: import("./types").PathTarget, child: import("./types").PathTarget) =>
    parent.path === child.path ||
    (parent.kind === "subtree" &&
      (parent.path === "." || child.path.startsWith(parent.path + "/")));
  return contains(a.target, b.target) || contains(b.target, a.target);
}
export function decodeContention(
  scope: CoordinationScope,
  request: ReadInvocation,
  response: ReadResponse,
): HttpResult<ContentionPage> {
  const target = targetCodec.decode(jsonField(request.params, "target")),
    workspace = jsonField(request.params, "workspace_id");
  if (
    request.method !== "reservation.contention" ||
    request.connection_id !== scope.connection.id ||
    request.generation !== scope.connection.generation ||
    workspace?.kind !== "string" ||
    workspace.value !== scope.workspaceId ||
    !target.ok
  )
    return invalid("Contention response changed its captured target.");
  const decoded = fields({
      workspace_revision: d.decimal,
      observed_unix_ms: decimal64,
      items: c.array(contentionRow, 100),
      cursor: c.nullable(text(2048, true)),
      has_more: c.boolean,
      needs_larger_budget: c.boolean,
      required_bytes: c.nullable(d.positiveDecimal),
    }).decode(response.response.data),
    metadata = fields({ workspace_revision: d.decimal }).decode(response.response.meta),
    completeness = complete(response);
  if (!decoded.ok || !metadata.ok || !completeness.ok)
    return invalid("Malformed contention capture or omission metadata.");
  const value = decoded.value,
    oldCursor = jsonField(request.params, "cursor");
  if (
    value.items.some((row) => {
      const actual = row.kind === "holder" ? row.target : row.record.target;
      if (!overlaps(target.value, actual)) return true;
      if (row.kind !== "holder" || row.note === null) return false;
      return (
        !sameTarget(row.target, row.note.target) ||
        row.note.actor_id !== row.holder.actor_id ||
        row.note.run_id !== row.holder.run_id ||
        row.note.token !== row.holder.token
      );
    })
  )
    return invalid("Contention row changed the requested overlap or actual holder-note ownership.");
  if (
    value.workspace_revision !== metadata.value.workspace_revision ||
    value.has_more !== (value.cursor !== null) ||
    value.needs_larger_budget !== (value.required_bytes !== null) ||
    (value.needs_larger_budget && (!value.has_more || value.items.length !== 0)) ||
    (!value.needs_larger_budget &&
      value.has_more &&
      (value.items.length === 0 ||
        (oldCursor?.kind === "string" && value.cursor === oldCursor.value)))
  )
    return invalid("Contention continuation/capture does not advance safely.");
  const continuation =
    value.cursor === null || value.needs_larger_budget
      ? null
      : Object.freeze({
          ...request,
          params: d.jsonObject([
            ...request.params.fields
              .filter((field) => field.name !== "cursor")
              .map((field) => [field.name, field.value] as const),
            ["cursor", d.jsonString(value.cursor)],
          ]),
        });
  return {
    ok: true,
    httpStatus: 200,
    data: Object.freeze({
      scope,
      target: target.value,
      invocation: request,
      response,
      revision: value.workspace_revision,
      observedUnixMs: value.observed_unix_ms,
      items: value.items,
      continuation,
      incomplete: !completeness.data || value.needs_larger_budget,
      warning: value.needs_larger_budget
        ? `This position needs ${value.required_bytes} bytes, beyond this 1 MiB view budget; it was not skipped. The capture remains incomplete.`
        : !completeness.data
          ? "Some fields were omitted; absence is not established."
          : null,
    }),
  };
}
