import { jsonField } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import { failureText } from "../../connections/failure";
import {
  conditionCodec,
  fields,
  pathCodec,
  policyCodec,
  poolCodec,
  choice,
  targetCodec,
} from "./codecs";
import { decodeContention, sameTarget } from "./contention";
import { createCoordinationClient, invocation, complete } from "./client";
import { command, counter, CoordinationInputError, identifier, target } from "./model";
import type { Preparation, Identifier } from "../../../core/protocol/types";
import type { CoordinationDraft, PathPolicy } from "./types";

export const pathPolicyCodec: c.Codec<PathPolicy> = {
  decode(value, path = []) {
    const result = fields({
      ticket_id: d.identifier,
      revision: d.positiveDecimal,
      require_reservations: c.boolean,
      declarations: c.array(
        c.record({ target: pathCodec, mode: choice(["shared", "exclusive"]) }),
        100,
      ),
    }).decode(value, path);
    return result.ok
      ? { ok: true, value: { ...result.value, paths: result.value.declarations } }
      : result;
  },
};
export const conditionRecord = fields({
  declaration: conditionCodec,
  satisfied: c.boolean,
  latest_signal: c.nullable(c.object),
});

export async function prepareCommand(
  draft: CoordinationDraft,
  api: ReturnType<typeof createCoordinationClient>,
  signal: AbortSignal,
): Promise<Preparation> {
  const input = draft.input;
  let revision = counter("0");
  let ticketId: Identifier | null = null;
  const found = async <T>(
    method: Parameters<typeof api.lookup<T>>[1],
    codec: c.Codec<T>,
    matches: (value: T) => boolean,
  ): Promise<T | null> => {
    const result = await api.lookup(draft.scope, method, codec, matches, signal);
    if (!result.ok) throw new CoordinationInputError(failureText(result.failure));
    return result.data.value;
  };
  switch (input.kind) {
    case "pool":
      revision =
        (await found("allocation.pools", poolCodec, (v) => v.name === input.name))?.revision ??
        revision;
      break;
    case "policy":
      ticketId = identifier(input.ticketId);
      revision =
        (await found("allocation.ticket_policies", policyCodec, (v) => v.ticket_id === ticketId))
          ?.revision ?? revision;
      break;
    case "paths":
      ticketId = identifier(input.ticketId);
      revision =
        (await found("ticket.paths.list", pathPolicyCodec, (v) => v.ticket_id === ticketId))
          ?.revision ?? revision;
      break;
    case "condition":
      ticketId = identifier(input.ticketId);
      revision =
        (
          await found(
            "condition.list",
            conditionRecord,
            (v) => v.declaration.condition_id === input.conditionId,
          )
        )?.declaration.revision ?? revision;
      break;
    case "signal":
      ticketId = input.declaration.value.ticket_id;
      break;
    case "holder-note":
      revision = counter(input.expectedRevision);
      break;
    case "waiter":
      revision = await waiterRevision(draft, api, signal);
      break;
    case "recover":
      if (input.recovery.kind === "ticket") ticketId = input.recovery.fence.ticketId;
      break;
    case "acquire":
    case "renew":
    case "release":
      break;
  }
  let projectId = draft.scope.projectId;
  if (ticketId !== null) {
    const response = await api.read(
      invocation(draft.scope, "ticket.read", [["ticket_id", d.jsonString(ticketId)]]),
      signal,
    );
    if (!response.ok) throw new CoordinationInputError(failureText(response.failure));
    const completeness = complete(response.data);
    if (!completeness.ok || !completeness.data)
      throw new CoordinationInputError(
        "Incomplete ticket capture cannot supply actual membership.",
      );
    const ticket = jsonField(response.data.response.data, "ticket"),
      actual = fields({ ticket_id: d.identifier, project_id: c.nullable(d.identifier) }).decode(
        ticket,
      );
    if (!actual.ok || actual.value.ticket_id !== ticketId)
      throw new CoordinationInputError("Ticket read changed the requested identity.");
    projectId = actual.value.project_id;
    if (
      input.kind === "recover" &&
      input.recovery.kind === "ticket" &&
      projectId !== input.recovery.fence.projectId
    )
      throw new CoordinationInputError(
        "Ticket membership differs from the captured recovery fence; capture it again explicitly.",
      );
  }
  const result = command(draft, revision);
  return Object.freeze({
    intention_id: draft.id,
    connection_id: draft.scope.connection.id,
    generation: draft.scope.connection.generation,
    context: Object.freeze({
      workspace_id: draft.scope.workspaceId,
      project_id: projectId,
      writer: draft.writer,
    }),
    method: result.method,
    params: result.params,
  });
}

/** include_inactive retains closed/expired waiter records. Holder notes differ:
 * expired/cleared notes are intentionally hidden and cannot prove absence. */
async function waiterRevision(
  draft: CoordinationDraft,
  api: ReturnType<typeof createCoordinationClient>,
  signal: AbortSignal,
): Promise<import("../../../core/protocol/types").Decimal> {
  if (draft.input.kind !== "waiter") throw new Error("waiterRevision requires waiter editor");
  const requested = target(draft.input.target),
    wantedRun = identifier(draft.input.targetRunId);
  const decodedTarget = targetCodec.decode(requested);
  if (!decodedTarget.ok) throw new CoordinationInputError("Malformed contention target.");
  let cursor: string | null = null,
    revision: string | null = null,
    found: import("../../../core/protocol/types").Decimal | null = null;
  const seen = new Set<string>();
  for (let count = 0; count < 100; count++) {
    const request = invocation(draft.scope, "reservation.contention", [
      ["target", requested],
      ["include_inactive", d.jsonBoolean(true)],
      ["limit", d.jsonString("100")],
      ["max_bytes", d.jsonString("1048576")],
      ...(cursor === null ? [] : [["cursor", d.jsonString(cursor)] as const]),
    ]);
    const result = await api.read(request, signal);
    if (!result.ok) throw new CoordinationInputError(failureText(result.failure));
    const check = decodeContention(draft.scope, request, result.data);
    if (!check.ok || check.data.incomplete)
      throw new CoordinationInputError(
        "Incomplete contention page cannot supply a waiter revision.",
      );
    const v = check.data;
    if (revision !== null && revision !== v.revision)
      throw new CoordinationInputError(
        "Contention continuation did not preserve a complete advancing capture.",
      );
    revision = v.revision;
    for (const item of v.items) {
      if (item.kind !== "waiter") continue;
      const row = item.record;
      if (row.run_id === wantedRun && sameTarget(row.target, decodedTarget.value)) {
        if (found !== null)
          throw new CoordinationInputError("Contention capture repeated this exact waiter.");
        if (row.actor_id !== draft.writer.actor_id)
          throw new CoordinationInputError("Stored waiter belongs to another actual actor.");
        found = row.revision;
      }
    }
    if (v.continuation === null) return found ?? counter("0");
    const next = jsonField(v.continuation.params, "cursor");
    if (next?.kind !== "string" || next.value === cursor || seen.has(next.value))
      throw new CoordinationInputError("Contention cursor repeated without progress.");
    cursor = next.value;
    seen.add(cursor);
  }
  throw new CoordinationInputError(
    "Waiter guard lookup exceeds 100 captured pages; absence was not inferred.",
  );
}
