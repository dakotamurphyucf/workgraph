import { parseJsonText, type JsonValue } from "../../src/core/json";
import * as d from "../../src/core/protocol/decoders";
import { object as objectCodec, type Codec } from "../../src/core/protocol/codec";
import type { HttpClient } from "../../src/core/protocol/http";
import type { ReadResponse } from "../../src/core/protocol/types";
import type { FeatureContext } from "../../src/app/types";
import { ticketReadCodec } from "../../src/features/work/read-model.codec";
import { commandDefinition } from "../../src/features/work/actions/commands";
import { captureAction, initialInputs } from "../../src/features/work/actions/model";
import type {
  AuxiliaryCapture,
  FormInput,
  WorkCommand,
  WorkDraft,
  WorkTarget,
} from "../../src/features/work/actions/types";

/** Synthetic fixed protocol fixtures only. Arbitrary payloads are never routed through JSON.parse. */
export function json(value: unknown): JsonValue {
  const parsed = parseJsonText(JSON.stringify(value));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value.value;
}
export function decode<T>(codec: Codec<T>, value: unknown): T {
  const result = codec.decode(json(value));
  if (!result.ok) throw new Error(`${result.issue.path.join(".")}: ${result.issue.expected}`);
  return result.value;
}
export function response(data: unknown, revision = "100"): ReadResponse {
  return {
    response: { data: json(data), meta: decode(objectCodec, { workspace_revision: revision }) },
    pagination: null,
  };
}
export function context(client: HttpClient): FeatureContext {
  return {
    client,
    connection: decode(d.connectionProfile, {
      id: "local",
      generation: "1",
      label: "Synthetic",
      socket: "/tmp/synthetic.sock",
    }),
    profileState: "current",
    route: {
      view: "work",
      connectionId: "local",
      workspaceId: "demo",
      projectId: "list-project",
      entityId: "target",
    },
    writer: { actorId: "author", runId: "run-one" },
    navigate: () => undefined,
  };
}
export function target(client: HttpClient, claimed = false): WorkTarget {
  const ctx = context(client),
    record = {
      ticket_id: "target",
      display_key: "SYN-1",
      title: "Synthetic target",
      description: "Original instructions",
      acceptance_criteria: "Original acceptance",
      revision: "9007199254740993",
      membership_revision: "9007199254740992",
      status: claimed ? "in_progress" : "todo",
      status_id: null,
      priority: "2",
      archived: false,
      assignee_id: null,
      project_id: "actual-project",
      milestone_id: null,
      parent_ticket_id: null,
      prerequisite_ticket_ids: ["other"],
      related_ticket_ids: ["other"],
      label_ids: [],
      hold: null,
      claim: claimed
        ? {
            actor_id: "author",
            run_id: "run-one",
            token: "9007199254740993",
            lease: {
              epoch: "9007199254740993",
              revision: "3",
              duration_ms: "60000",
              last_unix_ms: "1000",
              deadline_unix_ms: "61000",
            },
          }
        : null,
    };
  return {
    scope: {
      connection: ctx.connection,
      workspaceId: decode(d.identifier, "demo"),
      projectId: decode(d.identifier, "list-project"),
    },
    ticket: {
      id: "synthetic-ticket-capture",
      value: decode(ticketReadCodec, { ticket: record }),
      revision: decode(d.decimal, "100"),
      response: response({ ticket: record }),
      partial: false,
      controls: [],
    },
  };
}
export function draft(client: HttpClient, method: WorkCommand, claimed = false): WorkDraft {
  const selection = target(client, claimed),
    capture = captureAction(
      context(client),
      method,
      commandDefinition(method).target === "ticket" ? selection : null,
    );
  return {
    id: decode(d.identifier, `draft-${method.replaceAll(".", "-")}`),
    method,
    capture,
    inputs: initialInputs(method, capture),
    auxiliary: {},
    phase: { kind: "editing" },
    issue: null,
    unexpected: null,
    editRevision: 0,
  };
}
function auxiliary(method: string, params: unknown, data: unknown): AuxiliaryCapture {
  return {
    id: `synthetic-${method}`,
    kind: "present",
    method,
    params: decode(objectCodec, params),
    response: response(data),
  };
}
/** One complete valid generated-form submission per command; all optional fields populated. */
export function validDraft(client: HttpClient, method: WorkCommand): WorkDraft {
  const initial = draft(
      client,
      method,
      [
        "ticket.renew_lease",
        "ticket.release",
        "ticket.recover",
        "ticket.amendment.acknowledge",
      ].includes(method),
    ),
    inputs: Record<string, FormInput> = { ...initial.inputs };
  for (const field of commandDefinition(method).fields) {
    if (field.kind === "scalar") {
      let text =
        field.initial ??
        (field.type === "identifier"
          ? field.name.replaceAll("_", "-")
          : field.type === "counter"
            ? "1"
            : field.type === "boolean"
              ? "false"
              : field.type === "enum"
                ? (field.choices?.[0] ?? "")
                : "Synthetic form value");
      if (field.name === "_revision_source") text = "new";
      if (field.name === "confirmed") text = "yes";
      if (field.name === "source_kind") text = "text";
      if (field.name === "label_ids") text = "label-one\nlabel-two";
      if (field.name === "related_id" || field.name === "prerequisite_id") text = "other";
      if (field.name === "resource_digest") text = "a".repeat(64);
      inputs[field.name] = { kind: "scalar", presence: "value", text };
    } else if (field.kind === "paths")
      inputs[field.name] = {
        kind: "paths",
        rows: [{ worktreeId: "tree", kind: "subtree", path: "src/work", mode: "exclusive" }],
      };
    else if (field.kind === "amendments")
      inputs[field.name] = { kind: "amendments", rows: [{ amendmentId: "older", revision: "2" }] };
    else
      inputs[field.name] = {
        kind: "pins",
        rows: (
          [
            "resource",
            "event",
            "commit",
            "checksum",
            "comment",
            "amendment",
            "contract",
            "decision",
          ] as const
        ).map((kind) => ({
          kind,
          identity: "evidence",
          revision: "2",
          digest: "a".repeat(64),
          source: "synthetic-evidence",
        })),
      };
  }
  const amendment = auxiliary(
      "ticket.amendment.get",
      { workspace_id: "demo", amendment_id: "amendment-id", max_bytes: "1048576" },
      { head_revision: "9", item: { ticket_id: "target" } },
    ),
    related = auxiliary(
      "ticket.read",
      { workspace_id: "demo", ticket_id: "other", at_revision: "100", max_bytes: "1048576" },
      {
        ticket: {
          ticket_id: "other",
          revision: "17",
          project_id: "other-project",
          membership_revision: "4",
        },
      },
    ),
    policy = auxiliary(
      "ticket.hierarchy.get",
      { workspace_id: "demo", ticket_id: "target" },
      {
        ticket_id: "target",
        policy: null,
        effective: { descendant_prerequisites: "independent", child_completion: "all_done" },
      },
    );
  return { ...initial, inputs, auxiliary: { amendment, related, policy } };
}
