import type { JsonValue } from "../../../core/json";
import type {
  AdapterDescriptor,
  CapturedPayload,
  FormatProjection,
  MetricName,
  ProjectedItem,
  Provenance,
  Reported,
  ReportedMetric,
  SourcePath,
} from "./types";
import { field, integer, nonnegative, object } from "./validation";
export class Projection {
  readonly items: ProjectedItem[] = [];
  readonly metrics: ReportedMetric[] = [];
  readonly warnings: string[] = [];
  model: FormatProjection["model"] = null;
  sourceTime: FormatProjection["sourceTime"] = null;
  sourceSequence: FormatProjection["sourceSequence"] = null;
  identity: FormatProjection["identity"] = null;
  reportedStatus: FormatProjection["reportedStatus"] = null;
  reportedError: FormatProjection["reportedError"] = null;
  constructor(
    readonly descriptor: AdapterDescriptor,
    readonly capture: CapturedPayload,
  ) {}
  provenance(path: SourcePath): Provenance {
    return {
      captureId: this.capture.captureId,
      adapter: this.descriptor.id,
      schemaPin: this.descriptor.schemaPin,
      path,
    };
  }
  report<T>(value: T, path: SourcePath): Reported<T> {
    return { value, provenance: this.provenance(path) };
  }
  text(
    raw: JsonValue,
    path: SourcePath,
    text: string,
    role: string | null,
    interpretation: Extract<ProjectedItem, { kind: "text" }>["interpretation"] = "message",
    phase: string | null = null,
  ) {
    this.items.push({
      kind: "text",
      raw,
      provenance: this.provenance(path),
      text,
      role,
      phase,
      interpretation,
    });
  }
  unsupported(raw: JsonValue, path: SourcePath, reason: string) {
    this.items.push({ kind: "unsupported", raw, provenance: this.provenance(path), reason });
  }
  metric(
    value: JsonValue,
    path: SourcePath,
    name: MetricName,
    scope: ReportedMetric["scope"],
    basis: ReportedMetric["basis"] = "snapshot",
    coverage: ReportedMetric["coverage"] = "reported-response",
  ) {
    const lexeme = name === "estimated_cost_usd" ? nonnegative(value, path) : integer(value, path);
    const unit =
      name === "estimated_cost_usd"
        ? "USD"
        : name === "model_round_trips"
          ? "model-round-trips"
          : name.endsWith("duration_ms") || name === "duration_ms"
            ? "milliseconds"
            : "tokens";
    this.metrics.push({
      name,
      lexeme,
      unit,
      basis,
      scope,
      coverage,
      provenance: this.provenance(path),
      snapshotKey:
        scope.kind === "sdk-query-pipeline"
          ? null
          : JSON.stringify([
              this.capture.scopeId,
              scope.family,
              scope.kind,
              ...(scope.kind === "response" ? [scope.id] : [scope.sessionId, scope.resultId]),
            ]),
      possibleOverlapKey:
        scope.kind === "sdk-query-pipeline"
          ? JSON.stringify([
              this.capture.scopeId,
              scope.family,
              scope.kind,
              scope.sessionId,
              "query-boundary-unknown",
            ])
          : null,
    });
  }
  usage(
    value: JsonValue | undefined,
    path: SourcePath,
    scope: ReportedMetric["scope"],
    fields: readonly [string, MetricName, boolean][],
    basis: ReportedMetric["basis"] = "snapshot",
    coverage: ReportedMetric["coverage"] = "reported-response",
  ) {
    const source = object(value, path);
    for (const [key, name, mandatory] of fields) {
      const entry = field(source, key);
      if (mandatory || (entry !== undefined && entry.kind !== "null"))
        this.metric(entry ?? { kind: "null" }, [...path, key], name, scope, basis, coverage);
    }
  }
  finish(): FormatProjection {
    return {
      items: this.items,
      metrics: this.metrics,
      model: this.model,
      sourceTime: this.sourceTime,
      sourceSequence: this.sourceSequence,
      identity: this.identity,
      reportedStatus: this.reportedStatus,
      reportedError: this.reportedError,
      warnings: this.warnings,
    };
  }
}
