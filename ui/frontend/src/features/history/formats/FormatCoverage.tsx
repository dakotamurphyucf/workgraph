import type { FormatCoverage } from "./coverage.types";
import type { FormatSelection } from "./types";
import { FORMAT_ADAPTERS } from "./registry";

export function FormatCoverageSummary({
  coverage,
  selection,
}: {
  readonly coverage: FormatCoverage;
  readonly selection: FormatSelection;
}) {
  const chosen = FORMAT_ADAPTERS.find((adapter) => adapter.id === selection);
  return (
    <div aria-label="Current window format coverage">
      <p className="wg-hint" role="status">
        {selection === "generic"
          ? `${coverage.loaded} loaded payloads in Generic view`
          : `${coverage.matched} validated · ${coverage.explicitGeneric + coverage.unsupported + coverage.ambiguous} Generic`}
        {coverage.pending > 0 && ` · ${coverage.pending} awaiting projection`}
        {coverage.unloaded > 0 && ` · ${coverage.unloaded} not loaded`}
        {coverage.partial > 0 && ` · ${coverage.partial} partial prefixes`}
      </p>
      <details className="ht-source">
        <summary>Format view details</summary>
        <p>
          Only the {coverage.windowEvents} events in this captured window are counted. Unloaded
          payloads have not been inspected. Generic preserves the original bytes; choosing a format
          never rewrites stored history.
        </p>
        {chosen && (
          <p>
            Selected {chosen.label} · {chosen.schemaPin.name}@{chosen.schemaPin.revision}. Every
            payload still has to match this bounded schema.
          </p>
        )}
        {coverage.matches.map(({ adapter, count, shapeOnly, producerPinned }) => (
          <p key={adapter.id}>
            {adapter.label}: {count} · {shapeOnly} validated shape only · {producerPinned} with an
            explicit producer pin. Shape recognition does not prove a source producer or complete
            upstream schema.
          </p>
        ))}
        {coverage.fallbacks.length > 0 && (
          <ul aria-label="Generic fallback reasons">
            {coverage.fallbacks.map(({ reason, count }) => (
              <li key={reason}>
                {count} · {reason}
              </li>
            ))}
          </ul>
        )}
        {coverage.ambiguous > 0 && (
          <p>
            {coverage.ambiguous} payloads match multiple shapes; choose an exact format or Generic.
          </p>
        )}
        {selection === "generic" && <p>Generic skips provider-format recognition.</p>}
      </details>
    </div>
  );
}
