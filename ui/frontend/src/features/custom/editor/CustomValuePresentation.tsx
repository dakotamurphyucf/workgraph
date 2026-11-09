import { LazyDetails } from "../../connections/shared";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Select } from "../../../components/Primitives";
import type { JsonValue } from "../../../core/json";
import { chooseRenderer, CONFIG_LIMITS } from "../config";
import { ValuePresentation } from "./presentation";
import { current, declaredSchema } from "./model";
import type { CustomValuePresentationProps } from "./types";
const pinKey = (pin: import("../config").ContentPin) =>
  `${pin.resource_id}@${pin.version}:${pin.digest}:${pin.size_bytes}`;
/** Verified registry only. No reads, publication, arbitrary HTML or executable configuration. */
export function CustomValuePresentation({
  identity,
  association,
  subject,
  content,
  controller,
  generic,
  processing,
}: CustomValuePresentationProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get),
    catalog = current(state.shared);
  const localIdentity = JSON.stringify([
    association.connectionId,
    association.generation,
    association.socket,
    association.workspaceId,
    identity,
  ]);
  const [selection, setSelection] = useState<{ identity: string; choice: string }>({
    identity: localIdentity,
    choice: "generic",
  });
  const bytes = content.kind === "bytes" ? content.bytes : null,
    value = content.kind === "value" ? content.value : null;
  const eligible =
    (content.kind === "value" && content.complete !== false) ||
    (content.kind === "bytes" &&
      content.complete &&
      content.verified &&
      content.bytes.byteLength <= CONFIG_LIMITS.maxBytes);
  const [parsed, setParsed] = useState<{
    identity: string;
    bytes: Uint8Array;
    value: JsonValue | null;
    message: string | null;
    unexpected: { cause: unknown } | null;
  } | null>(null);
  useEffect(() => {
    if (bytes === null || !eligible) return;
    const owner = new AbortController(),
      retained = bytes.slice();
    void processing
      .parse(retained, { limits: CONFIG_LIMITS, signal: owner.signal })
      .then((result) => {
        if (owner.signal.aborted) return;
        const value = result.ok && result.value.ok ? result.value.value.value : null;
        setParsed({
          identity: localIdentity,
          bytes,
          value,
          message: !result.ok
            ? `JSON processing ${result.failure.kind}: ${result.failure.message}. The original viewer remains available.`
            : !result.value.ok
              ? "This exact source cannot be interpreted as bounded JSON. The original viewer remains available."
              : null,
          unexpected: null,
        });
      })
      .catch((cause: unknown) => {
        if (!owner.signal.aborted)
          setParsed({
            identity: localIdentity,
            bytes,
            value: null,
            message: null,
            unexpected: { cause },
          });
      });
    return () => owner.abort();
  }, [processing, localIdentity, bytes, eligible]);
  const observed = parsed?.identity === localIdentity && parsed.bytes === bytes ? parsed : null;
  if (observed?.unexpected !== null && observed?.unexpected !== undefined)
    throw observed.unexpected.cause;
  const decoded = eligible ? (value ?? observed?.value ?? null) : null;
  const declaration =
    decoded === null ? { schema: undefined, message: null } : declaredSchema(decoded);
  const registry =
    catalog !== undefined &&
    catalog.capture.scope.connection.id === association.connectionId &&
    catalog.capture.scope.connection.generation === association.generation &&
    catalog.capture.scope.connection.socket === association.socket &&
    catalog.capture.scope.workspaceId === association.workspaceId
      ? catalog.renderers
      : [];
  const registryComplete = catalog !== undefined && catalog.unavailable.length === 0;
  const selected = selection.identity === localIdentity ? selection.choice : "generic";
  const explicit = registry.find((entry) => pinKey(entry.pin) === selected);
  const choice =
    decoded === null || selected === "generic" || (selected === "auto" && !registryComplete)
      ? null
      : chooseRenderer(
          registry,
          { ...subject, schema: declaration.schema, value: decoded },
          selected === "auto" ? undefined : explicit?.pin,
        );
  // A removed exact choice cannot silently become an automatic match.
  const renderer =
    selected !== "auto" && selected !== "generic" && explicit === undefined
      ? null
      : choice?.kind === "renderer"
        ? choice
        : null;
  return (
    <section aria-label="Configured value renderer">
      <details className="wg-renderer-options">
        <summary>Value renderer · {renderer?.renderer.title ?? "Original"}</summary>
        <Select
          label="Value renderer"
          value={selected}
          onChange={(event) =>
            setSelection({ identity: localIdentity, choice: event.target.value })
          }
        >
          <option value="generic">Generic · original viewer</option>
          <option value="auto" disabled={decoded === null}>
            Match verified catalog
          </option>
          {registry.map((entry) => (
            <option key={pinKey(entry.pin)} value={pinKey(entry.pin)}>
              {entry.renderer.title} · {entry.pin.resource_id}@{entry.pin.version}
            </option>
          ))}
          {selected !== "auto" && selected !== "generic" && explicit === undefined && (
            <option value={selected}>Exact selected renderer unavailable</option>
          )}
        </Select>
        {registry.length === 0 && (
          <p className="wg-hint">
            No verified renderer catalog is loaded for this exact endpoint and workspace. Read one
            in Saved views; generic rendering remains selected.
          </p>
        )}
        {!eligible && (
          <p className="wg-hint">
            Custom JSON rendering requires complete verified source at most 64 KiB. Partial, binary
            or larger source retains its original viewer.
          </p>
        )}
        {selected === "generic" && declaration.message && <p>{declaration.message}</p>}
        {selected === "generic" && observed?.message && <p>{observed.message}</p>}
      </details>
      {selected !== "generic" && declaration.message && <p role="status">{declaration.message}</p>}
      {selected !== "generic" && observed?.message && <p role="status">{observed.message}</p>}
      {selected === "auto" && !registryComplete && (
        <p role="status">
          Catalog entries are unavailable or unverified. Matching cannot establish a unique
          renderer; choose an available exact version explicitly.
        </p>
      )}
      {selected === "auto" && choice?.kind === "generic" && (
        <p role="status">
          {choice.reason === "ambiguous"
            ? "Multiple verified renderers match. Choose an exact version explicitly."
            : "No verified renderer matches this value."}{" "}
          Generic viewer retained.
        </p>
      )}
      {renderer === null ? (
        generic
      ) : (
        <>
          <p className="wg-hint">
            Renderer {renderer.pin.resource_id} · content version {renderer.pin.version} · SHA-256{" "}
            {renderer.pin.digest}
          </p>
          <ValuePresentation
            identity={`${localIdentity}:${pinKey(renderer.pin)}`}
            value={decoded ?? { kind: "null" }}
            renderer={renderer.renderer}
            generic={
              <p className="wg-hint">The original viewer is available in Source / Raw below.</p>
            }
            processing={processing}
          />
          <LazyDetails summary="Original viewer · Source / Raw">{generic}</LazyDetails>
        </>
      )}
    </section>
  );
}
