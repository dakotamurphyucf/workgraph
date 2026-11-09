import * as d from "../../../core/protocol/decoders";
import type { EventRecord, BlobRef } from "./types";
const blob = (value: BlobRef) =>
  d.jsonObject([
    ["digest", d.jsonString(value.digest)],
    ["size_bytes", d.jsonString(value.size_bytes)],
  ]);
export function eventJson(record: EventRecord) {
  const event = record.event,
    nullable = (value: string | null) => (value === null ? d.jsonNull() : d.jsonString(value)),
    content = (value: BlobRef) =>
      d.jsonObject([
        ["kind", d.jsonString("blob")],
        ["blob", blob(value)],
      ]);
  return d.jsonObject([
    [
      "event_ref",
      d.jsonObject([
        ["session_id", d.jsonString(record.event_ref.session_id)],
        ["sequence", d.jsonString(record.event_ref.sequence)],
      ]),
    ],
    ["identity_hash", d.jsonString(record.identity_hash)],
    ["actor_id", d.jsonString(record.actor_id)],
    ["run_id", nullable(record.run_id)],
    [
      "event",
      d.jsonObject([
        ["client_id", d.jsonString(event.client_id)],
        ["role", d.jsonString(event.role)],
        ["kind", d.jsonString(event.kind)],
        ["phase", d.jsonString(event.phase)],
        ["correlation", nullable(event.correlation)],
        ["provenance", event.provenance],
        ["payload", content(event.payload.blob)],
        [
          "searchable_text",
          event.searchable_text === null ? d.jsonNull() : content(event.searchable_text.blob),
        ],
        [
          "resource_versions",
          d.jsonArray(
            event.resource_versions.map((value) =>
              d.jsonObject([
                ["resource_id", d.jsonString(value.resource_id)],
                ["revision", d.jsonString(value.revision)],
              ]),
            ),
          ),
        ],
        ["attachments", d.jsonArray(event.attachments.map(blob))],
      ]),
    ],
  ]);
}
