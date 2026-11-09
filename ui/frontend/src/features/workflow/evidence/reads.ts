import * as d from "../../../core/protocol/decoders";
import type { JsonObject } from "../../../core/protocol/types";
import { EvidenceInputError, identifier } from "./model";
import type { EvidenceRead } from "./types";
export interface ReadInputs {
  readonly objectId: string;
  readonly version: string;
  readonly scopeKind: "ticket" | "project";
  readonly scopeId: string;
  readonly manifestId: string;
  readonly manifestRevision: string;
  readonly reviewerId: string;
  readonly offset: string;
  readonly revision: string;
  readonly limit: string;
  readonly maxBytes: string;
  readonly pendingOnly: boolean;
}
export const initialReadInputs: ReadInputs = {
  objectId: "",
  version: "",
  scopeKind: "ticket",
  scopeId: "",
  manifestId: "",
  manifestRevision: "",
  reviewerId: "",
  offset: "0",
  revision: "",
  limit: "20",
  maxBytes: "65536",
  pendingOnly: true,
};
export function paged(method: EvidenceRead): boolean {
  return (
    method.endsWith(".list") ||
    method.endsWith(".history") ||
    method === "acceptance.assertions" ||
    method === "condition.signals"
  );
}
export function objectKind(
  method: EvidenceRead,
): "contract" | "manifest" | "decision" | "condition" | null {
  for (const kind of ["contract", "manifest", "decision", "condition"] as const)
    if (method === `${kind}.get` || method === `${kind}.history` || method === `${kind}.signals`)
      return kind;
  return null;
}
/** Only bounded known selector strings are constructed on the main thread. */
export function readParams(
  method: EvidenceRead,
  workspaceId: string,
  ticketId: string,
  input: ReadInputs,
): JsonObject {
  const fields: (readonly [string, import("../../../core/json").JsonValue])[] = [
    ["workspace_id", d.jsonString(identifier(workspaceId))],
  ];
  const counter = (name: string, value: string, maximum?: string) => {
    const parsed = d.decimal.decode(d.jsonString(value));
    if (
      !parsed.ok ||
      (["max_bytes", "limit", "version"].includes(name) && value === "0") ||
      (maximum !== undefined &&
        (value.length > maximum.length || (value.length === maximum.length && value > maximum)))
    )
      throw new EvidenceInputError(`${name} is outside its canonical decimal bound.`);
    fields.push([name, d.jsonString(parsed.value)]);
  };
  counter("max_bytes", input.maxBytes, "1048576");
  const kind = objectKind(method);
  if (kind !== null) {
    fields.push([`${kind}_id`, d.jsonString(identifier(input.objectId))]);
    if (method.endsWith(".get") && kind !== "condition" && input.version !== "")
      counter("version", input.version);
  }
  if (
    [
      "acceptance.policy.effective",
      "acceptance.assertions",
      "review.policy.get",
      "review.submission.get",
      "review.submission.list",
      "review.list",
      "manifest.list",
      "reconciliation.list",
      "condition.list",
    ].includes(method)
  )
    fields.push(["ticket_id", d.jsonString(identifier(ticketId))]);
  if (method === "acceptance.policy.get")
    fields.push([
      "scope",
      d.jsonObject([
        ["kind", d.jsonString(input.scopeKind)],
        [
          `${input.scopeKind}_id`,
          d.jsonString(
            identifier(
              input.scopeId === "" && input.scopeKind === "ticket" ? ticketId : input.scopeId,
            ),
          ),
        ],
      ]),
    ]);
  if (method === "decision.list")
    fields.push([
      "target",
      d.jsonObject([
        ["kind", d.jsonString("ticket")],
        ["ticket_id", d.jsonString(identifier(ticketId))],
      ]),
    ]);
  if (method === "validation.list" && (input.manifestId !== "" || input.manifestRevision !== "")) {
    const revision = d.positiveDecimal.decode(d.jsonString(input.manifestRevision));
    if (!revision.ok)
      throw new EvidenceInputError("An exact manifest filter needs its positive revision.");
    fields.push([
      "manifest",
      d.jsonObject([
        ["manifest_id", d.jsonString(identifier(input.manifestId))],
        ["revision", d.jsonString(revision.value)],
      ]),
    ]);
  }
  if (method === "review.list" && input.reviewerId !== "")
    fields.push(["reviewer_id", d.jsonString(identifier(input.reviewerId))]);
  if (method === "reconciliation.list")
    fields.push(["pending_only", d.jsonBoolean(input.pendingOnly)]);
  if (paged(method)) {
    counter("offset", input.offset);
    counter("limit", input.limit, "100");
    if (input.revision !== "")
      counter(method.startsWith("condition.") ? "expected_revision" : "revision", input.revision);
    else if (input.offset !== "0")
      throw new EvidenceInputError(
        "A later page needs its exact namespace revision. Prefer the returned Next exact page control.",
      );
  }
  return d.jsonObject(fields);
}
