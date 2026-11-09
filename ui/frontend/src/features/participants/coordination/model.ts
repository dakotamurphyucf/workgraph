import * as d from "../../../core/protocol/decoders";
import type { FeatureContext } from "../../../app/types";
import type { Decimal, Identifier, JsonObject, Preparation } from "../../../core/protocol/types";
import type { JsonValue } from "../../../core/json";
import { decimal64, normalizePath, pinCodec, text as textCodec } from "./codecs";
import type {
  AcquisitionInput,
  CoordinationDraft,
  CoordinationScope,
  HolderFence,
  PathTargetInput,
  ProofPinInput,
  ReservationTargetInput,
} from "./types";

export class CoordinationInputError extends Error {}
export const MAX_DRAFTS = 24;
export const identifier = (value: string): Identifier => {
  const result = d.identifier.decode(d.jsonString(value));
  if (!result.ok)
    throw new CoordinationInputError("Enter an actual ASCII identifier within 96 characters.");
  return result.value;
};
export function counter(value: string, maximum = 4611686018427387903n, minimum = 0n): Decimal {
  const result = d.decimal.decode(d.jsonString(value));
  if (!result.ok || BigInt(value) < minimum || BigInt(value) > maximum)
    throw new CoordinationInputError(
      `Enter canonical decimal digits from ${minimum} through ${maximum}.`,
    );
  return result.value;
}
export function unixMs(value: string): string {
  const result = decimal64.decode(d.jsonString(value));
  if (!result.ok)
    throw new CoordinationInputError(
      "Enter canonical nonnegative Unix milliseconds within signed int64.",
    );
  return result.value;
}
function text(value: string, maximum: number, nonblank = false): string {
  if (!textCodec(maximum, nonblank).decode(d.jsonString(value)).ok)
    throw new CoordinationInputError(
      `Enter ${nonblank ? "nonblank " : ""}text within ${maximum} UTF-8 bytes.`,
    );
  return value;
}
const string = (value: string): JsonValue => d.jsonString(value);
const object = d.jsonObject;
const array = d.jsonArray;
const strings = (values: readonly string[], convert: (value: string) => string, maximum = 100) => {
  const items = values.map(convert);
  if (items.length > maximum || new Set(items).size !== items.length)
    throw new CoordinationInputError(`Enter at most ${maximum} distinct rows.`);
  return array(items.map(string));
};
export function scope(context: FeatureContext): CoordinationScope {
  if (context.route.workspaceId === null)
    throw new CoordinationInputError("Choose the actual workspace first.");
  return Object.freeze({
    connection: Object.freeze({ ...context.connection }),
    workspaceId: identifier(context.route.workspaceId),
    projectId: context.route.projectId === null ? null : identifier(context.route.projectId),
  });
}
export function sameEndpoint(a: CoordinationScope, b: CoordinationScope): boolean {
  return (
    a.connection.id === b.connection.id &&
    a.connection.generation === b.connection.generation &&
    a.workspaceId === b.workspaceId
  );
}
export function capture(context: FeatureContext): {
  readonly scope: CoordinationScope;
  readonly writer: Preparation["context"]["writer"];
} {
  if (context.profileState !== "current")
    throw new CoordinationInputError(
      "Refresh the connection directory before creating a new draft.",
    );
  if (
    context.route.participant !== undefined &&
    context.route.participant.generation !== context.connection.generation
  )
    throw new CoordinationInputError(
      "Open the current endpoint explicitly before authoring. Retained-generation IDs will not be transplanted.",
    );
  if (context.writer.actorId === null)
    throw new CoordinationInputError("Select the actual acting writer first.");
  return Object.freeze({
    scope: scope(context),
    writer: Object.freeze({
      actor_id: identifier(context.writer.actorId),
      run_id: context.writer.runId === null ? null : identifier(context.writer.runId),
    }),
  });
}
export function path(input: PathTargetInput): JsonObject {
  const normalized = normalizePath(input.path, input.kind);
  if (normalized === null)
    throw new CoordinationInputError(
      "Use a relative logical path without parent escapes, backslashes, controls or globs. Only a subtree can name the worktree root.",
    );
  return object([
    ["worktree_id", string(identifier(input.worktreeId))],
    ["kind", string(input.kind)],
    ["path", string(normalized)],
  ]);
}
export function target(input: ReservationTargetInput): JsonObject {
  return input.kind === "named"
    ? object([
        ["kind", string("named")],
        ["reservation_id", string(identifier(input.reservationId))],
      ])
    : object([
        ["kind", string("path")],
        ["target", path(input.target)],
      ]);
}
export function pin(input: ProofPinInput): JsonObject {
  let value: JsonObject;
  switch (input.kind) {
    case "resource":
      value = object([
        ["kind", string(input.kind)],
        ["resource_id", string(identifier(input.resourceId))],
        ["revision", string(counter(input.version, undefined, 1n))],
        ["digest", string(input.digest)],
      ]);
      break;
    case "event":
      value = object([
        ["kind", string(input.kind)],
        ["session_id", string(identifier(input.sessionId))],
        ["sequence", string(counter(input.sequence, undefined, 1n))],
      ]);
      break;
    case "commit":
      value = object([
        ["kind", string(input.kind)],
        ["repository", string(input.repository)],
        ["object_id", string(input.objectId)],
      ]);
      break;
    case "checksum":
      value = object([
        ["kind", string(input.kind)],
        ["source", string(input.source)],
        ["digest", string(input.digest)],
      ]);
      break;
    case "comment":
    case "amendment":
    case "contract":
    case "decision":
      value = object([
        ["kind", string(input.kind)],
        [`${input.kind}_id`, string(identifier(input.id))],
        ["revision", string(counter(input.revision, undefined, 1n))],
      ]);
      break;
  }
  if (!pinCodec.decode(value).ok)
    throw new CoordinationInputError(
      "Provide the exact supported proof identity, positive version and lowercase digest/object ID.",
    );
  return value;
}
function proof(values: readonly ProofPinInput[], minimum = 0): JsonValue {
  if (values.length < minimum || values.length > 100)
    throw new CoordinationInputError(`Provide ${minimum}..100 exact proof pins.`);
  return array(values.map(pin));
}
function acquisition(value: AcquisitionInput): JsonValue {
  const maximum = 32;
  if (value.requests.length === 0 || value.requests.length > maximum)
    throw new CoordinationInputError(
      `One atomic ${value.kind} batch requires 1..${maximum} requests.`,
    );
  const keys = new Set<string>();
  return array(
    value.requests.map((row) => {
      const fields: (readonly [string, JsonValue])[] = [["mode", string(row.mode)]];
      if (row.durationMs !== "")
        fields.push(["lease_duration_ms", string(counter(row.durationMs, 86400000n, 1n))]);
      let key: string;
      if ("reservationId" in row) {
        key = identifier(row.reservationId);
        fields.push(["reservation_id", string(key)]);
      } else {
        const p = path(row.target);
        key = `${row.target.worktreeId}\u0000${row.target.kind}\u0000${normalizePath(row.target.path, row.target.kind)}`;
        fields.push(["target", p]);
      }
      if (keys.has(key))
        throw new CoordinationInputError("An atomic batch cannot repeat a target.");
      keys.add(key);
      return object(fields);
    }),
  );
}
function fenceFields(
  fence: HolderFence,
  owner: CoordinationDraft,
  recovery = false,
): (readonly [string, JsonValue])[] {
  if (!sameEndpoint(owner.scope, fence.reservation.scope))
    throw new CoordinationInputError("The holder belongs to another captured endpoint/workspace.");
  const holder = fence.holder;
  if (!fence.reservation.value.holders.includes(holder))
    throw new CoordinationInputError("Choose an actual holder from this reservation capture.");
  if (
    !recovery &&
    (owner.writer.actor_id !== holder.actor_id || owner.writer.run_id !== holder.run_id)
  )
    throw new CoordinationInputError(
      "Renew/release uses the original holder actor and run. Select that actual writer; an observed token alone is not ownership.",
    );
  const t = fence.reservation.value.target;
  return [
    [
      t.kind === "named" ? "reservation_id" : "target",
      t.kind === "named"
        ? string(t.reservation_id)
        : path({ worktreeId: t.target.worktree_id, kind: t.target.kind, path: t.target.path }),
    ],
    ["token", string(holder.token)],
  ];
}
export interface PreparedCommand {
  readonly method: string;
  readonly params: JsonObject;
  readonly ticketId: Identifier | null;
  readonly projectId: Identifier | null;
}
/** Guard revision comes from a complete, exact-target native read. Never derive
 * absence from a partial page or substitute the current selected endpoint. */
export function command(draft: CoordinationDraft, expectedRevision: Decimal): PreparedCommand {
  const input = draft.input,
    fields: (readonly [string, JsonValue])[] = [
      ["workspace_id", string(draft.scope.workspaceId)],
      ["actor_id", string(draft.writer.actor_id)],
      ...(draft.writer.run_id === null ? [] : [["run_id", string(draft.writer.run_id)] as const]),
    ];
  let method: string,
    ticketId: Identifier | null = null,
    projectId = draft.scope.projectId;
  const add = (...items: (readonly [string, JsonValue])[]) => fields.push(...items);
  const revision = () => add(["expected_revision", string(expectedRevision)]);
  switch (input.kind) {
    case "pool":
      method = "allocation.pool_put";
      revision();
      add(
        ["name", string(text(input.name, 96, true))],
        ["limit", string(counter(input.limit, 10000n, 1n))],
      );
      break;
    case "policy":
      method = "allocation.ticket_policy_put";
      revision();
      ticketId = identifier(input.ticketId);
      add(
        ["ticket_id", string(ticketId)],
        ["required_capabilities", strings(input.capabilities, (value) => text(value, 96, true))],
        ["pools", strings(input.pools, (value) => text(value, 96, true))],
        [
          "allowed_actor_ids",
          input.actors.kind === "unrestricted"
            ? d.jsonNull()
            : strings(input.actors.ids, identifier),
        ],
      );
      if (input.actors.kind === "allow" && input.actors.ids.length === 0)
        throw new CoordinationInputError(
          "An actor allowlist needs at least one actual actor; choose unrestricted to clear it.",
        );
      break;
    case "paths":
      method = "ticket.paths.put";
      revision();
      ticketId = identifier(input.ticketId);
      if (input.paths.length > 100)
        throw new CoordinationInputError("Use at most 100 path declarations.");
      add(
        ["ticket_id", string(ticketId)],
        ["require_reservations", d.jsonBoolean(input.requireReservations)],
        [
          "declarations",
          array(
            input.paths.map((row) =>
              object([
                ["target", path(row.target)],
                ["mode", string(row.mode)],
              ]),
            ),
          ),
        ],
      );
      break;
    case "acquire":
      method =
        input.acquisition.kind === "named" ? "reservation.acquire" : "reservation.paths.acquire";
      add(
        ["target_run_id", string(identifier(input.targetRunId))],
        ["requests", acquisition(input.acquisition)],
      );
      break;
    case "renew":
    case "release": {
      const fence = input.fence;
      method = `reservation.${fence.reservation.value.target.kind === "path" ? "path." : ""}${input.kind}`;
      add(...fenceFields(fence, draft), ["target_run_id", string(fence.holder.run_id)]);
      if (input.kind === "renew") {
        if (fence.holder.lease.kind === "indefinite")
          throw new CoordinationInputError("Indefinite ownership does not need renewal.");
        add(["expected_lease_revision", string(fence.holder.lease.revision)]);
      }
      if (input.kind === "release" && fence.holder.origin.kind === "automatic")
        throw new CoordinationInputError(
          "Automatic path ownership is borrowed by ticket claims; release the owning claims rather than bypassing them.",
        );
      break;
    }
    case "condition":
      method = "condition.put";
      revision();
      ticketId = identifier(input.ticketId);
      add(
        ["condition_id", string(identifier(input.conditionId))],
        ["ticket_id", string(ticketId)],
        ["operation_id", string(identifier(input.operationId))],
        ["artifact", pin(input.artifact)],
        ["required", d.jsonBoolean(input.required)],
        ["label", string(text(input.label, 4096, true))],
        ["recipients", strings(input.recipients, identifier)],
      );
      break;
    case "signal": {
      method = "condition.signal";
      const declaration = input.declaration;
      if (!sameEndpoint(draft.scope, declaration.scope))
        throw new CoordinationInputError(
          "This condition declaration belongs to another captured target.",
        );
      const v = declaration.value;
      ticketId = v.ticket_id;
      add(
        ["signal_id", string(identifier(input.signalId))],
        ["condition_id", string(v.condition_id)],
        ["expected_revision", string(v.revision)],
        ["operation_id", string(v.operation_id)],
        ["artifact", encodePin(v.artifact)],
        ["evidence", proof(input.evidence, 1)],
        ["summary", string(text(input.summary, 65536, true))],
      );
      break;
    }
    case "recover": {
      const recovery = input.recovery;
      if (recovery.confirmation === "")
        throw new CoordinationInputError(
          "Record an actual outside observation: the previous owner is stopped or isolated. Expiry is not proof.",
        );
      add(
        ["recovery_id", string(identifier(recovery.recoveryId))],
        ["confirmation", string(recovery.confirmation)],
        ["reason", string(text(recovery.reason, recovery.kind === "ticket" ? 4096 : 65536, true))],
        ["evidence", proof(recovery.evidence)],
      );
      if (recovery.kind === "reservation") {
        const f = recovery.fence;
        method =
          f.reservation.value.target.kind === "path"
            ? "reservation.path.recover"
            : "reservation.recover";
        // Recovery uses a tagged target on both native endpoints.
        fenceFields(f, draft, true);
        add(
          ["target", encodeTarget(f.reservation.value.target)],
          ["expected_epoch", string(f.reservation.value.epoch)],
          ["old_actor_id", string(f.holder.actor_id)],
          ["old_run_id", string(f.holder.run_id)],
          ["token", string(f.holder.token)],
          ["expected_lease_revision", string(f.holder.lease.revision)],
        );
      } else {
        const f = recovery.fence;
        if (!sameEndpoint(draft.scope, f.scope))
          throw new CoordinationInputError("This ticket claim belongs to another captured target.");
        method = "ticket.recover";
        ticketId = f.ticketId;
        projectId = f.projectId;
        add(
          ["ticket_id", string(f.ticketId)],
          ["expected_revision", string(f.ticketRevision)],
          ["old_actor_id", string(f.actorId)],
          ["old_run_id", f.runId === null ? d.jsonNull() : string(f.runId)],
          ["token", string(f.token)],
          ["expected_lease_revision", string(f.lease.revision)],
          ["disposition", string(recovery.disposition)],
        );
      }
      break;
    }
    case "waiter": {
      method = "reservation.waiter.put";
      revision();
      if (draft.writer.run_id !== identifier(input.targetRunId))
        throw new CoordinationInputError(
          "An advisory waiter records the actual acting run; choose that writer run first.",
        );
      add(
        ["target", target(input.target)],
        ["target_run_id", string(identifier(input.targetRunId))],
        ["action", string(input.action.kind)],
      );
      if (input.action.kind === "close")
        add(["reason", string(text(input.action.reason, 512, true))]);
      else
        add(
          ["duration_ms", string(counter(input.action.durationMs, 300000n, 1n))],
          ["note", string(text(input.action.note, 1024))],
        );
      break;
    }
    case "holder-note": {
      method = "reservation.holder_note.put";
      add(["expected_revision", string(counter(input.expectedRevision))]);
      fenceFields(input.fence, draft);
      add(
        ["target", encodeTarget(input.fence.reservation.value.target)],
        ["target_run_id", string(input.fence.holder.run_id)],
        ["token", string(input.fence.holder.token)],
        ["action", string(input.action.kind)],
      );
      if (input.action.kind === "set")
        add(
          ["duration_ms", string(counter(input.action.durationMs, 300000n, 1n))],
          ["note", string(text(input.action.note, 1024))],
          [
            "expected_release_unix_ms",
            input.action.expectedReleaseUnixMs === ""
              ? d.jsonNull()
              : string(unixMs(input.action.expectedReleaseUnixMs)),
          ],
        );
      break;
    }
  }
  return Object.freeze({ method, params: object(fields), ticketId, projectId });
}
export function encodePin(value: import("./types").ProofPin): JsonObject {
  return object(Object.entries(value).map(([key, item]) => [key, string(item)] as const));
}
export function encodeTarget(value: import("./types").ReservationTarget): JsonObject {
  return value.kind === "named"
    ? object([
        ["kind", string("named")],
        ["reservation_id", string(value.reservation_id)],
      ])
    : object([
        ["kind", string("path")],
        [
          "target",
          path({
            worktreeId: value.target.worktree_id,
            kind: value.target.kind,
            path: value.target.path,
          }),
        ],
      ]);
}
