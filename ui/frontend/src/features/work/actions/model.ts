import type { FeatureContext } from "../../../app/types";
import { jsonField, type JsonValue } from "../../../core/json";
import * as c from "../../../core/protocol/codec";
import * as d from "../../../core/protocol/decoders";
import type {
  Decimal,
  Identifier,
  JsonObject,
  OperationState,
  Preparation,
  PreparationSnapshot,
} from "../../../core/protocol/types";
import { commandDefinition } from "./commands";
import type {
  ActionCapture,
  AuxiliaryCapture,
  ClaimFence,
  FormField,
  FormInput,
  PinRow,
  ScalarInput,
  WorkCommand,
  WorkDraft,
  WorkTarget,
} from "./types";

export class ActionInputError extends Error {}
export const MAX_DRAFT_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_DRAFTS = 32;
/** ticket.create returns the created record directly, unlike ticket.read's wrapper. */
export function createdTicketId(
  preparation: Pick<PreparationSnapshot, "method" | "params">,
  state: OperationState,
): Identifier | null {
  if (preparation.method !== "ticket.create" || state.kind !== "committed") return null;
  const record = state.response.data;
  if (record.kind !== "object") return null;
  const id = d.identifier.decode(jsonField(record, "ticket_id"));
  if (!id.ok) return null;
  const requested = jsonField(preparation.params, "ticket_id");
  if (requested !== undefined && (requested.kind !== "string" || requested.value !== id.value))
    return null;
  return id.value;
}
const utf8 = new TextEncoder();
export function identity(prefix = "work"): Identifier {
  return validId(`${prefix}-${crypto.randomUUID()}`, "Generated identity");
}
export function validId(value: string, label: string): Identifier {
  const parsed = d.identifier.decode(d.jsonString(value));
  if (!parsed.ok)
    throw new ActionInputError(
      `${label} requires 1–96 ASCII letters, digits, underscores or hyphens.`,
    );
  return parsed.value;
}
export function counter(
  value: string,
  label: string,
  positive = false,
  maximum = "4611686018427387903",
): Decimal {
  const parsed = (positive ? d.positiveDecimal : d.decimal).decode(d.jsonString(value));
  if (!parsed.ok || BigInt(value) > BigInt(maximum))
    throw new ActionInputError(
      `${label} requires an exact ${positive ? "positive" : "nonnegative"} decimal counter up to ${maximum}.`,
    );
  return parsed.value;
}
function text(value: string, label: string, maxBytes: number, nonblank = false): string {
  if (utf8.encode(value).byteLength > maxBytes || (nonblank && value.trim() === ""))
    throw new ActionInputError(
      `${label} requires ${nonblank ? "nonblank text and " : ""}at most ${maxBytes} UTF-8 bytes.`,
    );
  // Worker admission additionally validates Unicode; never normalize the original source.
  return value;
}
export function object(value: JsonValue | undefined, label: string): JsonObject {
  if (value?.kind !== "object")
    throw new ActionInputError(`${label} is missing or malformed; load its complete record.`);
  return value;
}
export function readText(value: JsonValue | undefined, label: string): string {
  const result = c.text.decode(value);
  if (!result.ok)
    throw new ActionInputError(`${label} is missing or malformed; load its complete record.`);
  return result.value;
}
export function captureAction(
  context: FeatureContext,
  method: WorkCommand,
  selection: WorkTarget | null,
): ActionCapture {
  if (context.profileState !== "current")
    throw new ActionInputError(
      "Refresh the connection directory before capturing a new action. Existing drafts remain unchanged.",
    );
  const workspaceId = validId(context.route.workspaceId ?? "", "Workspace");
  const actorId = validId(context.writer.actorId ?? "", "Acting actor");
  const runId = context.writer.runId === null ? null : validId(context.writer.runId, "Acting run");
  const target = commandDefinition(method).target;
  const ticket = selection?.ticket ?? null;
  if (target === "ticket" && ticket === null)
    throw new ActionInputError("Read and select a complete ticket before capturing this action.");
  if (
    target === "ticket" &&
    (selection?.scope.connection.id !== context.connection.id ||
      selection.scope.connection.generation !== context.connection.generation ||
      selection.scope.workspaceId !== workspaceId)
  )
    throw new ActionInputError(
      "The selected ticket belongs to another captured endpoint or workspace; finish loading the current selection.",
    );
  return Object.freeze({
    connection: Object.freeze({ ...context.connection }),
    workspaceId,
    projectId:
      target === "ticket"
        ? (ticket?.value.ticket.project_id ?? null)
        : target === "workflow" || context.route.projectId === null
          ? null
          : validId(context.route.projectId, "Project"),
    writer: Object.freeze({ actorId, runId }),
    ticket: target === "ticket" ? ticket : null,
  });
}
const input = (text: string, presence: ScalarInput["presence"] = "value"): ScalarInput =>
  Object.freeze({ kind: "scalar", presence, text });
export function initialInputs(
  method: WorkCommand,
  capture: ActionCapture,
): Readonly<Record<string, FormInput>> {
  const fields: Record<string, FormInput> = {};
  const ticket = capture.ticket?.value.ticket;
  for (const field of commandDefinition(method).fields) {
    if (field.kind === "scalar")
      fields[field.name] = input(
        field.initial ?? (field.type === "boolean" ? "false" : ""),
        field.optional ? "omit" : field.nullable ? "null" : "value",
      );
    else fields[field.name] = Object.freeze({ kind: field.kind, rows: Object.freeze([]) });
  }
  if (method === "ticket.create" && capture.projectId !== null)
    fields.project_id = input(capture.projectId);
  if (ticket !== undefined) {
    if (method === "ticket.update") {
      fields.title = input(ticket.title, "omit");
      fields.description = input(ticket.description, "omit");
      fields.status = input(ticket.status, "omit");
    }
    if (method === "ticket.metadata") {
      fields.priority = input(ticket.priority, "omit");
      fields.assignee_id = input(ticket.assignee_id ?? "", "omit");
      fields.label_ids = input(ticket.label_ids.join("\n"), "omit");
      fields.acceptance_criteria = input(ticket.acceptance_criteria, "omit");
      fields.status_id = input(ticket.status_id ?? "", "omit");
    }
    if (method === "ticket.move")
      for (const [key, value] of [
        ["project_id", ticket.project_id],
        ["milestone_id", ticket.milestone_id],
        ["parent_ticket_id", ticket.parent_ticket_id],
      ] as const)
        fields[key] = input(value ?? "", value === null ? "null" : "value");
    if (method === "ticket.archive") fields.archived = input(ticket.archived ? "false" : "true");
    if (method === "ticket.hold")
      fields.reason = input(ticket.hold?.reason ?? "", ticket.hold === null ? "value" : "null");
  }
  if (method === "ticket.recover") fields.recovery_id = input(identity("recovery"));
  if (method === "ticket.amendment.publish") fields.amendment_id = input(identity("amendment"));
  return Object.freeze(fields);
}
export function scalarInput(draft: WorkDraft, name: string): ScalarInput {
  const value = draft.inputs[name];
  if (value?.kind !== "scalar") throw new ActionInputError(`Missing scalar field ${name}.`);
  return value;
}
export function scalarText(draft: WorkDraft, name: string): string {
  return scalarInput(draft, name).text;
}
export function inputBytes(inputs: Readonly<Record<string, FormInput>>): number {
  let bytes = 0;
  for (const [name, value] of Object.entries(inputs)) {
    bytes += utf8.encode(name).byteLength;
    if (value.kind === "scalar")
      bytes += utf8.encode(value.text).byteLength + value.presence.length;
    else
      for (const row of value.rows)
        for (const field of Object.values(row)) {
          if (typeof field !== "string")
            throw new ActionInputError("Editor row values must be text.");
          bytes += utf8.encode(field).byteLength;
        }
  }
  return bytes;
}
export function freezeInput(value: FormInput): FormInput {
  return value.kind === "scalar"
    ? Object.freeze({ ...value })
    : (Object.freeze({
        kind: value.kind,
        rows: Object.freeze(value.rows.map((row) => Object.freeze({ ...row }))),
      }) as FormInput);
}
export function claimFence(capture: ActionCapture): ClaimFence | null {
  const ticket = capture.ticket?.value.ticket;
  if (ticket === undefined || ticket.claim === null) return null;
  const raw = object(jsonField(ticket.raw, "claim"), "Claim"),
    lease = object(jsonField(raw, "lease"), "Claim lease");
  const token = counter(readText(jsonField(raw, "token"), "Claim token"), "Claim token", true);
  const epoch = counter(readText(jsonField(lease, "epoch"), "Lease epoch"), "Lease epoch", true);
  if (token !== epoch || token !== ticket.claim.token)
    throw new ActionInputError("Claim token and lease epoch disagree; refresh the ticket.");
  const millis = (v: JsonValue | undefined, label: string): string => {
    const s = readText(v, label);
    if (!/^(0|[1-9][0-9]*)$/u.test(s) || BigInt(s) > 9223372036854775807n)
      throw new ActionInputError(`Invalid ${label}.`);
    return s;
  };
  const deadline = jsonField(lease, "deadline_unix_ms");
  return Object.freeze({
    actorId: ticket.claim.actor_id,
    runId: ticket.claim.run_id,
    token,
    leaseRevision: counter(
      readText(jsonField(lease, "revision"), "Lease revision"),
      "Lease revision",
      true,
    ),
    deadlineUnixMs: deadline?.kind === "null" ? null : millis(deadline, "Lease deadline"),
    lastUnixMs: millis(jsonField(lease, "last_unix_ms"), "Lease clock"),
  });
}
function scalarValue(
  field: Extract<FormField, { kind: "scalar" }>,
  value: ScalarInput,
): JsonValue | undefined {
  if (value.presence === "omit") {
    if (!field.optional) throw new ActionInputError(`${field.label} cannot be omitted.`);
    return undefined;
  }
  if (value.presence === "null") {
    if (!field.nullable) throw new ActionInputError(`${field.label} cannot be cleared with null.`);
    return d.jsonNull();
  }
  switch (field.type) {
    case "identifier":
      return d.jsonString(validId(value.text, field.label));
    case "counter":
      return d.jsonString(counter(value.text, field.label, field.positive, field.maximum));
    case "boolean":
      if (value.text !== "true" && value.text !== "false")
        throw new ActionInputError(`${field.label} must be true or false.`);
      return d.jsonBoolean(value.text === "true");
    case "enum":
      if (!field.choices?.includes(value.text))
        throw new ActionInputError(`Choose an explicit ${field.label}.`);
      return d.jsonString(value.text);
    case "text":
    case "multiline":
      return d.jsonString(text(value.text, field.label, field.maxBytes ?? 65536, field.nonblank));
  }
}
function digest(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value))
    throw new ActionInputError("A pin requires an exact lowercase SHA-256 digest.");
  return value;
}
function pin(row: PinRow): JsonObject {
  const fields: [string, JsonValue][] = [["kind", d.jsonString(row.kind)]];
  const put = (name: string, value: string) => fields.push([name, d.jsonString(value)]);
  switch (row.kind) {
    case "resource":
      put("resource_id", validId(row.identity, "Resource pin"));
      put("revision", counter(row.revision, "Resource pin version", true));
      put("digest", digest(row.digest));
      break;
    case "event":
      put("session_id", validId(row.identity, "Session pin"));
      put("sequence", counter(row.revision, "Event sequence", true));
      break;
    case "commit":
      if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/u.test(row.digest))
        throw new ActionInputError(
          "Commit object ID must be 40 or 64 lowercase hexadecimal characters.",
        );
      put("repository", text(row.source, "Repository", 1024, true));
      put("object_id", row.digest);
      break;
    case "checksum":
      put("source", text(row.source, "Checksum source", 1024, true));
      put("digest", digest(row.digest));
      break;
    case "comment":
    case "amendment":
    case "contract":
    case "decision":
      put(`${row.kind}_id`, validId(row.identity, `${row.kind} pin`));
      put("revision", counter(row.revision, "Pinned revision", true));
      break;
  }
  return d.jsonObject(fields);
}
function collectionValue(
  field: Exclude<FormField, { kind: "scalar" }>,
  value: FormInput,
): JsonValue {
  if (value.kind !== field.kind) throw new ActionInputError(`Invalid ${field.label}.`);
  if (value.rows.length > field.maxRows)
    throw new ActionInputError(`${field.label} permits at most ${field.maxRows} rows.`);
  if (value.kind === "pins") return d.jsonArray(value.rows.map(pin));
  if (value.kind === "amendments")
    return d.jsonArray(
      value.rows.map((row) =>
        d.jsonObject([
          ["amendment_id", d.jsonString(validId(row.amendmentId, "Superseded amendment"))],
          ["revision", d.jsonString(counter(row.revision, "Superseded revision", true))],
        ]),
      ),
    );
  const seen = new Set<string>();
  return d.jsonArray(
    value.rows.map((row) => {
      text(row.path, "Logical path", 4096, true);
      if (
        row.path.startsWith("/") ||
        ["\\", "*", "?", "[", "]"].some((character) => row.path.includes(character)) ||
        Array.from(row.path).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        row.path.split("/").includes("..")
      )
        throw new ActionInputError(
          "Logical paths must be relative, without parent components, escapes or glob metacharacters.",
        );
      const path =
        row.path
          .split("/")
          .filter((part) => part !== "" && part !== ".")
          .join("/") || ".";
      if (path === "." && row.kind === "file")
        throw new ActionInputError("An exact file cannot name the worktree root.");
      const worktree = validId(row.worktreeId, "Worktree"),
        key = JSON.stringify([worktree, row.kind, path]);
      if (seen.has(key))
        throw new ActionInputError("Each logical path target may appear only once.");
      seen.add(key);
      return d.jsonObject([
        [
          "target",
          d.jsonObject([
            ["worktree_id", d.jsonString(worktree)],
            ["kind", d.jsonString(row.kind)],
            ["path", d.jsonString(path)],
          ]),
        ],
        ["mode", d.jsonString(row.mode)],
      ]);
    }),
  );
}
export function auxiliaryData(draft: WorkDraft, key: string): JsonObject | null {
  const capture = draft.auxiliary[key];
  if (capture === undefined)
    throw new ActionInputError("Load the actual referenced record before capturing this action.");
  return object(capture.response.response.data, "Loaded record");
}
function auxiliaryMatches(
  capture: AuxiliaryCapture | undefined,
  field: string,
  value: string,
): void {
  if (
    capture === undefined ||
    readText(jsonField(capture.params, field), "Loaded selector") !== value
  )
    throw new ActionInputError(
      "The identifier changed after its record was loaded; load it again.",
    );
}
function ownClaim(draft: WorkDraft): ClaimFence {
  const claim = claimFence(draft.capture);
  if (
    claim === null ||
    claim.actorId !== draft.capture.writer.actorId ||
    claim.runId !== draft.capture.writer.runId
  )
    throw new ActionInputError(
      "This action requires the exact captured claim owner and run. Choosing an actor does not transfer ownership.",
    );
  return claim;
}
/** Builds only each current method's supported fields. Membership is provenance, never an invented guard. */
export function preparation(draft: WorkDraft): Preparation {
  const definition = commandDefinition(draft.method),
    fields: [string, JsonValue][] = [];
  const put = (name: string, value: string) => fields.push([name, d.jsonString(value)]);
  const set = (name: string, value: JsonValue) => {
    const previous = fields.findIndex((field) => field[0] === name);
    if (previous >= 0) fields.splice(previous, 1);
    fields.push([name, value]);
  };
  const ticket = draft.capture.ticket?.value.ticket;
  put("workspace_id", draft.capture.workspaceId);
  put("actor_id", draft.capture.writer.actorId);
  if (draft.capture.writer.runId !== null) put("run_id", draft.capture.writer.runId);
  if (definition.target === "ticket" && draft.method !== "ticket.amendment.withdraw") {
    if (ticket === undefined) throw new ActionInputError("No captured ticket.");
    put("ticket_id", ticket.ticket_id);
  }
  for (const field of definition.fields) {
    if (
      field.name.startsWith("_") ||
      [
        "source_kind",
        "source_body",
        "resource_id",
        "resource_revision",
        "resource_digest",
        "confirmed",
      ].includes(field.name)
    )
      continue;
    const input = draft.inputs[field.name];
    if (input === undefined) throw new ActionInputError(`Missing ${field.label}.`);
    if (field.kind === "scalar") {
      if (input.kind !== "scalar") throw new ActionInputError(`Invalid ${field.label}.`);
      const value = scalarValue(field, input);
      if (value !== undefined) fields.push([field.name, value]);
    } else fields.push([field.name, collectionValue(field, input)]);
  }
  const guard = () => {
    if (ticket === undefined) throw new ActionInputError("No captured ticket revision.");
    put("expected_revision", ticket.revision);
  };
  switch (draft.method) {
    case "ticket.create":
      break;
    case "ticket.update":
      if (ticket?.claim !== null)
        throw new ActionInputError(
          "Release the claim or publish an instruction amendment before editing claimed instructions.",
        );
      guard();
      break;
    case "ticket.metadata": {
      const labels = scalarInput(draft, "label_ids");
      if (labels.presence === "value") {
        const values = labels.text
          .split(/\r?\n/u)
          .map((value) => value.trim())
          .filter((value) => value !== "");
        if (values.length > 65536 || new Set(values).size !== values.length)
          throw new ActionInputError(
            "Use at most 65536 distinct label IDs, one per line; the full request must fit 4 MiB.",
          );
        set("label_ids", d.jsonArray(values.map((value) => d.jsonString(validId(value, "Label")))));
      }
      if (ticket?.claim !== null && scalarInput(draft, "status_id").presence === "value")
        throw new ActionInputError("Release the claim before changing named status.");
      guard();
      break;
    }
    case "ticket.move":
    case "ticket.archive":
    case "ticket.hold":
    case "ticket.reopen":
    case "ticket.claim":
    case "ticket.start":
    case "ticket.reassign":
    case "dependency.waive":
      guard();
      break;
    case "ticket.renew_lease": {
      const claim = ownClaim(draft);
      if (claim.deadlineUnixMs === null)
        throw new ActionInputError(
          "The captured claim is indefinite and has no timed lease to renew.",
        );
      put("token", claim.token);
      put("expected_lease_revision", claim.leaseRevision);
      break;
    }
    case "ticket.release":
      put("token", ownClaim(draft).token);
      break;
    case "ticket.recover": {
      const claim = claimFence(draft.capture);
      if (claim === null || claim.deadlineUnixMs === null)
        throw new ActionInputError(
          "Recovery requires an exact timed claim; expiry is checked by the daemon.",
        );
      if (scalarText(draft, "confirmed") !== "yes")
        throw new ActionInputError(
          "Confirm the prior execution has actually been stopped or isolated before recovery.",
        );
      guard();
      put("old_actor_id", claim.actorId);
      set("old_run_id", claim.runId === null ? d.jsonNull() : d.jsonString(claim.runId));
      put("token", claim.token);
      put("expected_lease_revision", claim.leaseRevision);
      break;
    }
    case "dependency.add":
    case "dependency.remove":
      break;
    case "related.add":
    case "related.remove": {
      auxiliaryMatches(draft.auxiliary.related, "ticket_id", scalarText(draft, "related_id"));
      const data = auxiliaryData(draft, "related");
      const other = object(data === null ? undefined : jsonField(data, "ticket"), "Related ticket");
      if (
        readText(jsonField(other, "ticket_id"), "Related ticket ID") !==
        scalarText(draft, "related_id")
      )
        throw new ActionInputError("Loaded related ticket identity differs.");
      guard();
      put(
        "related_expected_revision",
        counter(
          readText(jsonField(other, "revision"), "Related ticket revision"),
          "Related ticket revision",
          true,
        ),
      );
      break;
    }
    case "ticket.paths.put": {
      const data =
        scalarText(draft, "_revision_source") === "new" ? null : auxiliaryData(draft, "policy");
      put(
        "expected_revision",
        data === null
          ? "0"
          : counter(
              readText(jsonField(data, "revision"), "Path policy revision"),
              "Path policy revision",
              true,
            ),
      );
      break;
    }
    case "ticket.hierarchy.put": {
      const data = auxiliaryData(draft, "policy");
      if (data === null) throw new ActionInputError("Hierarchy snapshot is missing.");
      const policy = jsonField(data, "policy");
      put(
        "expected_revision",
        policy?.kind === "null"
          ? "0"
          : counter(
              readText(
                jsonField(object(policy, "Hierarchy policy"), "revision"),
                "Hierarchy revision",
              ),
              "Hierarchy revision",
              true,
            ),
      );
      break;
    }
    case "ticket.amendment.publish":
    case "ticket.amendment.withdraw":
    case "ticket.amendment.acknowledge": {
      const id = validId(scalarText(draft, "amendment_id"), "Amendment"),
        aux = draft.auxiliary.amendment;
      if (
        aux !== undefined &&
        (draft.method !== "ticket.amendment.publish" ||
          scalarText(draft, "_revision_source") === "loaded")
      )
        auxiliaryMatches(aux, "amendment_id", id);
      const data =
        draft.method === "ticket.amendment.publish" &&
        scalarText(draft, "_revision_source") === "new"
          ? null
          : auxiliaryData(draft, "amendment");
      if (data !== null) {
        const item = object(jsonField(data, "item"), "Complete amendment item");
        if (readText(jsonField(item, "ticket_id"), "Amendment ticket") !== ticket?.ticket_id)
          throw new ActionInputError("This amendment belongs to another ticket.");
      }
      if (data === null && draft.method !== "ticket.amendment.publish")
        throw new ActionInputError("An existing complete amendment must be loaded.");
      put(
        "expected_revision",
        data === null
          ? "0"
          : counter(
              readText(jsonField(data, "head_revision"), "Amendment head revision"),
              "Amendment head revision",
              true,
            ),
      );
      if (draft.method === "ticket.amendment.publish") {
        const kind = scalarText(draft, "source_kind");
        if (kind === "text")
          set(
            "source",
            d.jsonObject([
              ["kind", d.jsonString("text")],
              [
                "body",
                d.jsonString(
                  text(scalarText(draft, "source_body"), "Instruction text", 65536, true),
                ),
              ],
            ]),
          );
        else if (kind === "resource")
          set(
            "source",
            d.jsonObject([
              ["kind", d.jsonString("resource")],
              [
                "pin",
                d.jsonObject([
                  [
                    "resource_id",
                    d.jsonString(validId(scalarText(draft, "resource_id"), "Resource")),
                  ],
                  [
                    "revision",
                    d.jsonString(
                      counter(scalarText(draft, "resource_revision"), "Resource version", true),
                    ),
                  ],
                  ["digest", d.jsonString(digest(scalarText(draft, "resource_digest")))],
                ]),
              ],
            ]),
          );
        else
          throw new ActionInputError(
            "Choose text or an exact resource pin as the instruction source.",
          );
      }
      if (draft.method === "ticket.amendment.acknowledge") put("token", ownClaim(draft).token);
      break;
    }
    case "label.put":
    case "status.put": {
      const key = draft.method === "label.put" ? "label_id" : "status_id";
      if (scalarText(draft, "_revision_source") === "new") put("expected_revision", "0");
      else {
        const data = auxiliaryData(draft, "workflow");
        if (data === null) throw new ActionInputError("Workflow directory is missing.");
        const items = jsonField(data, "items");
        if (items?.kind !== "array") throw new ActionInputError("Workflow page is malformed.");
        const item = items.items.find(
          (value) =>
            value.kind === "object" &&
            jsonField(value, key)?.kind === "string" &&
            readText(jsonField(value, key), key) === scalarText(draft, key),
        );
        if (item === undefined)
          throw new ActionInputError(
            "This identifier is not in the loaded directory page. Load the next page or create an explicit new draft with revision zero.",
          );
        put(
          "expected_revision",
          counter(
            readText(
              jsonField(object(item, "Workflow record"), "revision"),
              "Workflow record revision",
            ),
            "Workflow record revision",
            true,
          ),
        );
      }
      break;
    }
  }
  if (
    draft.method === "ticket.start" &&
    scalarInput(draft, "attempt_id").presence === "value" &&
    draft.capture.writer.runId === null
  )
    throw new ActionInputError("Starting an attempt requires a captured registered run.");
  if (
    draft.method === "ticket.reassign" &&
    scalarInput(draft, "claimant_id").presence === "null" &&
    scalarInput(draft, "claimant_run_id").presence !== "omit"
  )
    throw new ActionInputError("Clearing the claimant requires omitting the claimant run.");
  return Object.freeze({
    intention_id: draft.id,
    connection_id: draft.capture.connection.id,
    generation: draft.capture.connection.generation,
    context: Object.freeze({
      workspace_id: draft.capture.workspaceId,
      project_id: draft.capture.projectId,
      writer: Object.freeze({
        actor_id: draft.capture.writer.actorId,
        run_id: draft.capture.writer.runId,
      }),
    }),
    method: draft.method,
    params: d.jsonObject(fields),
  });
}
