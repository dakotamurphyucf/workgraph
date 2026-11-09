import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "../../../components/Primitives";
import { ContentViewer, type ContentSource } from "../../../content";
import type { JsonValue } from "../../../core/json";
import type { HttpClient } from "../../../core/protocol/http";
import { createReadSlot } from "../../../core/state/read-slot";
import { failureText } from "../../connections/failure";
import type { EvidenceTarget } from "./types";
import { pinCodec, readPinnedResource } from "./pinned-resource";
interface ProofProps {
  readonly http: HttpClient;
  readonly target: EvidenceTarget;
  readonly value: JsonValue;
  readonly openEvidence?: (
    target: import("../../work/progress/types").TicketEvidenceTarget,
  ) => void;
}
export function PinnedResource(props: ProofProps) {
  const pin = pinCodec.decode(props.value);
  if (!pin.ok)
    return <p role="alert">This resource pin is malformed; no current content was substituted.</p>;
  const key = JSON.stringify([
    props.target.connection.id,
    props.target.connection.generation,
    props.target.workspaceId,
    pin.value.resource_id,
    pin.value.revision,
    pin.value.digest,
  ]);
  return <ProofReader key={key} {...props} pin={pin.value} identity={key} />;
}
function ProofReader({
  http,
  target,
  pin,
  openEvidence,
  identity: key,
}: ProofProps & {
  readonly pin: Extract<ReturnType<typeof pinCodec.decode>, { ok: true }>["value"];
  readonly identity: string;
}) {
  const slot = useMemo(() => createReadSlot<ContentSource>(), []),
    state = useSyncExternalStore(slot.subscribe, slot.get),
    [unexpected, setUnexpected] = useState<{ error: unknown } | null>(null);
  useEffect(() => () => slot.dispose(), [slot]);
  if (unexpected !== null) throw unexpected.error;
  if (state.kind === "unexpected_error") throw state.error;
  const inspect = () => {
    void slot
      .load(key, (signal) => readPinnedResource(http, target, pin, signal))
      .catch((error: unknown) => setUnexpected({ error }));
  };
  return (
    <div className="ev-pinned-resource">
      <p>
        <strong>{pin.resource_id}</strong> · content version {pin.revision}
      </p>
      <details>
        <summary>Exact SHA-256</summary>
        <code>{pin.digest}</code>
      </details>
      {openEvidence === undefined ? (
        <p className="wg-hint">
          Exact Resources navigation is unavailable in this build. The resource ID, content version
          and digest above remain selectable.
        </p>
      ) : (
        <Button
          onClick={() =>
            openEvidence({
              kind: "resource_content",
              connectionId: target.connection.id,
              generation: target.connection.generation,
              workspaceId: target.workspaceId,
              resourceId: pin.resource_id,
              version: pin.revision,
              digest: pin.digest,
            })
          }
        >
          Open exact resource version
        </Button>
      )}
      <Button onClick={inspect} disabled={state.kind === "loading"}>
        Read this exact small text
      </Button>
      {state.kind === "loading" && <p role="status">Reading and verifying pinned text…</p>}
      {state.kind === "failed" && (
        <p role="alert">
          {failureText(state.failure)} Complete text here is limited to 64 KiB; use the Resources
          view for larger or binary artifacts. No current-version fallback occurred.
        </p>
      )}
      {state.kind === "ready" && state.key === key && <ContentViewer source={state.value} />}
    </div>
  );
}
