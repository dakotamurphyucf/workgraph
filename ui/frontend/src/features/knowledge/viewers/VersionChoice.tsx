import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Field, Select } from "../../../components/Primitives";
import type { HttpClient } from "../../../core/protocol/http";
import { createReadSlot } from "../../../core/state/read-slot";
import type { Decimal } from "../../../core/protocol/types";
import { failureText } from "../../connections/failure";
import { createResourcesClient } from "../resources/client";
import type { ResourcePin, ResourceVersion } from "../resources/types";
import { resourceSize } from "../resources/presentation";

/** Read-only version suggestions retain their planning capture and exact endpoint.
 * Manual entry stays available when suggestions cannot be loaded. */
export function VersionChoice({
  http,
  pin,
  value,
  onChange,
}: {
  readonly http: HttpClient;
  readonly pin: ResourcePin;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const [slot] = useState(() => createReadSlot<readonly ResourceVersion[]>());
  const state = useSyncExternalStore(slot.subscribe, slot.get);
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([
    pin.connection.id,
    pin.connection.generation,
    pin.connection.socket,
    pin.workspaceId,
    pin.resourceId,
  ]);
  useEffect(() => {
    const api = createResourcesClient(http);
    void slot
      .load(key, async (signal) => {
        const rows = new Map<Decimal, ResourceVersion>();
        let revision: Decimal | undefined, offset: Decimal | undefined;
        while (!signal.aborted) {
          const result = await api.history(
            pin,
            pin.resourceId,
            { ...(revision ? { atRevision: revision } : {}), ...(offset ? { offset } : {}) },
            signal,
          );
          if (!result.ok) return result;
          const page = result.data;
          if (page.partial || (revision !== undefined && page.queryRevision !== revision))
            return {
              ok: false,
              failure: {
                kind: "input",
                message: "Version choices are incomplete. Retry or enter a version number.",
              },
            };
          revision = page.queryRevision;
          for (const row of page.value.items) {
            if (rows.has(row.revision))
              return {
                ok: false,
                failure: { kind: "input", message: "Version choices repeated a record." },
              };
            rows.set(row.revision, row);
          }
          if (page.value.next_offset === null) {
            if (page.value.remaining !== "0")
              return {
                ok: false,
                failure: {
                  kind: "input",
                  message: "Some versions were omitted. Retry or enter a version number.",
                },
              };
            return { ok: true, httpStatus: 200, data: [...rows.values()] };
          }
          if (
            page.value.items.length === 0 ||
            BigInt(page.value.next_offset) <= BigInt(offset ?? "0")
          )
            return {
              ok: false,
              failure: { kind: "input", message: "Version choices did not advance." },
            };
          offset = page.value.next_offset;
        }
        return { ok: false, failure: { kind: "aborted" } };
      })
      .catch(() => {
        /* The slot exposes unexpected errors at the feature boundary. */
      });
    return () => slot.clear();
    // The immutable endpoint identity above owns the request, not a new wrapper object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [http, slot, key, retry]);
  if (state.kind === "unexpected_error") throw state.error;
  const rows = state.kind === "ready" && state.key === key ? state.value : [];
  return (
    <div className="rs-version-choices">
      <Select
        label="Choose a saved version"
        value={rows.some((row) => row.revision === value) ? value : ""}
        onChange={(e) => {
          if (e.target.value) onChange(e.target.value);
        }}
      >
        <option value="">
          {state.kind === "loading" ? "Loading versions…" : "Choose a version to compare"}
        </option>
        {rows.map((row) => (
          <option key={row.revision} value={row.revision}>
            Version {row.revision} · {row.filename} · {resourceSize(row.size_bytes)}
          </option>
        ))}
      </Select>
      <Field
        label="Right content version"
        hint="You can also enter an exact version number."
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {state.kind === "failed" && (
        <p role="status">
          {failureText(state.failure)}{" "}
          <Button onClick={() => setRetry((n) => n + 1)}>Retry version list</Button>
        </p>
      )}
    </div>
  );
}
