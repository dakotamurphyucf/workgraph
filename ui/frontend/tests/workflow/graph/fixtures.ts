import type { Identifier } from "../../../src/core/protocol/types";
import * as d from "../../../src/core/protocol/decoders";
import { ticketCodec } from "../../../src/features/work/read-model.codec";
import { graphRecord, hierarchyCodec } from "../../../src/features/workflow/graph/model";
import type { Capture } from "../../../src/features/work/read-model.types";
import type { GraphRecord, HierarchyPolicy } from "../../../src/features/workflow/graph/types";
import { decode, response } from "../../work/actions-fixtures";

export const id = (value: string): Identifier => decode(d.identifier, value);
export function rawTicket(ticketId: string, patch: Record<string, unknown> = {}) {
  return {
    ticket_id: ticketId,
    display_key: `SYN-${ticketId}`,
    title: `Synthetic ${ticketId}`,
    description: "Synthetic instructions",
    acceptance_criteria: "Synthetic acceptance",
    revision: "9007199254740993",
    membership_revision: "2",
    status: "todo",
    status_id: null,
    priority: "2",
    archived: false,
    assignee_id: null,
    project_id: "northstar",
    milestone_id: null,
    parent_ticket_id: null,
    prerequisite_ticket_ids: [],
    related_ticket_ids: [],
    label_ids: [],
    claim: null,
    hold: null,
    waivers: [],
    ...patch,
  };
}
export function record(ticketId: string, patch: Record<string, unknown> = {}): GraphRecord {
  const parsed = graphRecord(decode(ticketCodec, rawTicket(ticketId, patch)), {
    id: `capture-${ticketId}`,
    revision: decode(d.decimal, "100"),
  });
  if (!parsed.ok) throw new Error(parsed.issue.expected);
  return parsed.value;
}
export function policy(
  ticketId: string,
  inheritance: "independent" | "inherit",
  revision = "100",
): Capture<HierarchyPolicy> {
  const raw = {
    ticket_id: ticketId,
    policy: {
      ticket_id: ticketId,
      revision: "1",
      descendant_prerequisites: inheritance,
      child_completion: "all_done",
      reason: "Synthetic hierarchy policy",
    },
    effective: { descendant_prerequisites: inheritance, child_completion: "all_done" },
  };
  return {
    id: `policy-${ticketId}`,
    revision: decode(d.decimal, revision),
    value: decode(hierarchyCodec, raw),
    response: response(raw, revision),
    partial: false,
    controls: [],
  };
}
export function records(...values: readonly GraphRecord[]) {
  return new Map(values.map((value) => [value.ticket.ticket_id, value]));
}
