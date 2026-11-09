import { Button } from "../../../../components/Primitives";
import { JsonView, LazyDetails } from "../../../connections/shared";
import type { ProtocolProcessor } from "../../../../core/protocol/worker/types";
import type { CellResult } from "../../config";
import { cellReference } from "./model";
import type { PresentationNavigation } from "./types";
export function Cell({
  result,
  processing,
  identity,
  ...navigation
}: PresentationNavigation & {
  readonly result: CellResult;
  readonly processing: ProtocolProcessor;
  readonly identity: string;
}) {
  const reference = cellReference(result);
  if (reference !== null) {
    const label =
      reference.kind === "resource_pin"
        ? `${reference.pin.resource_id} · v${reference.pin.version} · ${reference.pin.digest}`
        : reference.entity === "workspace"
          ? "Workspace"
          : `${reference.entity}: ${reference.id}`;
    const available =
      navigation.onOpenReference !== undefined &&
      (navigation.canOpenReference?.(reference) ?? true);
    return available ? (
      <Button onClick={() => navigation.onOpenReference?.(reference)}>{label}</Button>
    ) : (
      <span>
        {label}
        <small> · Navigation unavailable</small>
      </span>
    );
  }
  if (result.kind === "text" || result.kind === "enum")
    return (
      <span
        className={`wg-custom-cell ${result.kind === "enum" ? `wg-custom-tone-${result.tone}` : ""}`}
      >
        {result.text.length <= 1000 ? (
          result.text
        ) : (
          <>
            {result.text.slice(0, 1000)}…
            <LazyDetails summary="Full cell text">
              <pre>{result.text}</pre>
            </LazyDetails>
          </>
        )}
      </span>
    );
  if (result.kind === "json")
    return (
      <LazyDetails summary="Inspect JSON value">
        <JsonView
          value={result.value}
          identity={identity}
          label="Selected JSON value"
          processing={processing}
        />
      </LazyDetails>
    );
  return (
    <span className="wg-hint">
      {result.kind === "unavailable"
        ? result.message
        : "Malformed reference; navigation unavailable."}
      {result.kind === "unavailable" && result.raw !== null && (
        <LazyDetails summary="Inspect incompatible value">
          <JsonView
            value={result.raw}
            identity={identity}
            label="Incompatible value"
            processing={processing}
          />
        </LazyDetails>
      )}
    </span>
  );
}
