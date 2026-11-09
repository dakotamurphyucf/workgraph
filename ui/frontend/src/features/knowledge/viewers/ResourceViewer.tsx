import { VersionChoice } from "./VersionChoice";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Field, Select, Toolbar } from "../../../components/Primitives";
import { ContentViewer, resolveFormat } from "../../../content";
import type { ContentSource } from "../../../content/types";
import * as d from "../../../core/protocol/decoders";
import type { ResourceContentContext } from "../resources/types";
import type { Comparison, ResourceViewerProps, ViewerResult, ViewerWorker } from "./types";
import { completeContent, pinKey } from "./controller";
import { JsonPane } from "./JsonPane";
import { RasterOverlay, RasterPane } from "./RasterPane";
import "./viewers.css";
import { VIEWER_LIMITS as L } from "./limits";
function useComplete(content: ResourceContentContext) {
  const [state, setState] = useState<{
      readonly source: ContentSource;
      readonly blob: Blob;
      readonly value: ResourceContentContext;
      readonly issue: string | null;
    } | null>(null),
    [unexpected, setUnexpected] = useState<{ readonly blob: Blob; readonly error: unknown } | null>(
      null,
    );
  useEffect(() => {
    let active = true;
    void completeContent(content)
      .then((value) => {
        if (active) setState({ source: content.source, blob: content.blob, value, issue: null });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof DOMException)
          setState({
            source: content.source,
            blob: content.blob,
            value: content,
            issue: `Could not read verified local Blob: ${error.name}.`,
          });
        else setUnexpected({ blob: content.blob, error });
      });
    return () => {
      active = false;
    };
  }, [content]);
  if (unexpected?.blob === content.blob) throw unexpected.error;
  return state?.source === content.source && state.blob === content.blob ? state : null;
}
function inferred(source: ContentSource): "json" | "raster" | "text" {
  const mime = source.hints.mime?.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime.startsWith("image/")
    ? "raster"
    : mime === "application/json" ||
        mime.endsWith("+json") ||
        source.hints.filename?.toLowerCase().endsWith(".json")
      ? "json"
      : "text";
}
export function RichContent({
  source,
  worker,
  totalBytes = source.bytes.length,
}: {
  readonly source: ContentSource;
  readonly worker: ViewerWorker;
  readonly totalBytes?: number;
}) {
  const [choice, setChoice] = useState("auto");
  const mode = choice === "auto" ? inferred(source) : choice;
  return (
    <section aria-label="Rich publication viewer" className="wg-rich-viewer">
      <details className="rs-viewer-choice">
        <summary>
          Viewer ·{" "}
          {choice === "auto"
            ? "Automatic"
            : choice === "text"
              ? "Markdown / code / source"
              : choice === "json"
                ? "JSON fields"
                : "Image"}
        </summary>
        <p className="wg-hint">
          Automatic uses the filename and file type to choose a display. Change it here if the file
          looks better as text, JSON fields or an image.
        </p>
        <Toolbar label="Rich viewer choice">
          <Select label="Viewer" value={choice} onChange={(event) => setChoice(event.target.value)}>
            <option value="auto">Automatic</option>
            <option value="text">Markdown / code / source</option>
            <option value="json">JSON fields</option>
            <option value="raster">Image</option>
          </Select>
        </Toolbar>
      </details>
      {(mode === "json" && totalBytes > L.jsonBytes) ||
      (mode === "raster" && totalBytes > L.imageBytes) ? (
        <p role="alert">
          <strong>budget</strong>: This {totalBytes} byte publication exceeds the{" "}
          {mode === "json" ? "4MiB JSON" : "8MiB raster"} preview budget. Complete verified download
          and bounded Source/Raw remain available; no rich decode was started.
        </p>
      ) : mode === "json" ? (
        <JsonPane key={source.key} source={source} worker={worker} />
      ) : mode === "raster" ? (
        <RasterPane key={source.key} source={source} worker={worker} />
      ) : (
        <ContentViewer source={source} chrome="compact" />
      )}
      {mode !== "text" && (
        <details>
          <summary>Original file and display options</summary>
          <ContentViewer source={source} chrome="compact" />
        </details>
      )}
    </section>
  );
}
function Download({
  content,
  label,
}: {
  readonly content: ResourceContentContext;
  readonly label: string;
}) {
  const urls = useRef(new Set<string>()),
    [issue, setIssue] = useState<{ readonly key: string; readonly message: string } | null>(null),
    [unexpected, setUnexpected] = useState<{
      readonly key: string;
      readonly error: unknown;
    } | null>(null);
  const key = pinKey(content.pin);
  useEffect(() => {
    const owned = urls.current;
    return () => {
      for (const url of owned) URL.revokeObjectURL(url);
      owned.clear();
    };
  }, []);
  if (unexpected?.key === key) throw unexpected.error;
  function download() {
    try {
      const url = URL.createObjectURL(content.blob);
      urls.current.add(url);
      const link = document.createElement("a");
      link.href = url;
      link.download = content.pin.filename.replaceAll(/[\\/]/g, "_") || "resource.bin";
      link.rel = "noopener noreferrer";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
      }, 1000);
      setIssue(null);
    } catch (error: unknown) {
      if (error instanceof DOMException)
        setIssue({ key, message: `Download unavailable: ${error.name}.` });
      else setUnexpected({ key, error });
    }
  }
  return (
    <>
      <Button onClick={download}>{label}</Button>
      {issue?.key === key && <p role="status">{issue.message}</p>}
    </>
  );
}
function PinLabel({
  content,
  side,
}: {
  readonly content: ResourceContentContext;
  readonly side: string;
}) {
  return (
    <header className="wg-comparison-pin">
      <strong>
        {side}: {content.pin.filename} · content v{content.pin.version}
      </strong>
      <span>
        {content.pin.connection.id} / generation {content.pin.connection.generation} ·{" "}
        {content.pin.resourceId} · {content.pin.sizeBytes} bytes
      </span>
    </header>
  );
}
function CompareProjection({
  left,
  right,
  worker,
  format,
}: {
  readonly left: ResourceContentContext;
  readonly right: ResourceContentContext;
  readonly worker: ViewerWorker;
  readonly format: "text" | "json" | "images" | "binary";
}) {
  const [state, setState] = useState<{
      readonly key: string;
      readonly result: ViewerResult<Comparison>;
      readonly leftSource: ContentSource;
      readonly rightSource: ContentSource;
    } | null>(null),
    [unexpected, setUnexpected] = useState<{
      readonly key: string;
      readonly error: unknown;
    } | null>(null),
    [overlay, setOverlay] = useState(false);
  const key = JSON.stringify([left.source.key, right.source.key, format]);
  useEffect(() => {
    const abort = new AbortController();
    if (format === "binary" || format === "images") return () => abort.abort();
    void worker
      .compare(left.source, right.source, format, abort.signal)
      .then((result) => {
        if (!abort.signal.aborted)
          setState({ key, result, leftSource: left.source, rightSource: right.source });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setUnexpected({ key, error });
      });
    return () => abort.abort();
  }, [left.source, right.source, worker, format, key]);
  if (unexpected?.key === key) throw unexpected.error;
  const result =
    state?.key === key && state.leftSource === left.source && state.rightSource === right.source
      ? state.result
      : null;
  if (format === "binary")
    return (
      <p role="status">
        {left.pin.digest === right.pin.digest && left.pin.sizeBytes === right.pin.sizeBytes
          ? "Identical verified bytes."
          : "Different verified bytes."}{" "}
        Binary comparison uses independently verified SHA-256 and size; no text decoding.
      </p>
    );
  if (format === "images" && (left.blob.size > L.imageBytes || right.blob.size > L.imageBytes))
    return (
      <p role="alert">
        <strong>budget</strong>: Image comparison requires each verified file to fit the 8MiB raster
        budget. Exact pins, bounded sources and both verified downloads remain available.
      </p>
    );
  if (format === "images")
    return (
      <>
        <Toolbar label="Image comparison">
          <Button aria-pressed={!overlay} onClick={() => setOverlay(false)}>
            Side by side
          </Button>
          <Button aria-pressed={overlay} onClick={() => setOverlay(true)}>
            Overlay
          </Button>
        </Toolbar>
        {overlay ? (
          <RasterOverlay left={left.source} right={right.source} worker={worker} />
        ) : (
          <div className="wg-comparison-columns">
            <RasterPane source={left.source} worker={worker} />
            <RasterPane source={right.source} worker={worker} />
          </div>
        )}
      </>
    );
  return !result ? (
    <p role="status">Preparing {format} comparison…</p>
  ) : !result.ok ? (
    <p role="alert">
      <strong>{result.kind}</strong>: {result.message}
    </p>
  ) : result.value.kind === "text" ? (
    <div className="wg-text-diff" aria-label="Text differences">
      {result.value.rows.map((row, index) => (
        <div key={index} className={`wg-diff-row wg-diff-row--${row.kind}`}>
          <span>{row.left ?? ""}</span>
          <span>{row.right ?? ""}</span>
          <span aria-label={row.kind}>
            {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}
          </span>
          <code>{row.text || " "}</code>
        </div>
      ))}
    </div>
  ) : result.value.kind === "json-diff" ? (
    <section aria-label="JSON differences">
      <p>
        {result.value.changes.length === 0
          ? result.value.formattingOnly
            ? "Formatting / object field order only; exact sources differ."
            : "No JSON value or numeric-lexeme changes."
          : `${result.value.changes.length} changed paths. Numeric lexemes and array order are significant; missing and null are distinct.`}
      </p>
      {result.value.changes.map((change) => (
        <div className="wg-json-change" key={change.pointer}>
          <code>{change.pointer || "(root)"}</code>
          <strong>{change.kind}</strong>
          <span>Left: {change.before ?? "(missing)"}</span>
          <span>Right: {change.after ?? "(missing)"}</span>
        </div>
      ))}
    </section>
  ) : null;
}
export function ResourceViewer({ content, controller, http }: ResourceViewerProps) {
  const loaded = useComplete(content),
    state = useSyncExternalStore(controller.subscribe, controller.get),
    owner = pinKey(content.pin),
    [comparisonOpen, setComparisonOpen] = useState(false),
    [version, setVersion] = useState(""),
    [format, setFormat] = useState<"auto" | "text" | "json" | "images" | "binary">("auto");
  useEffect(() => () => controller.clearComparison(), [controller, owner]);
  if (state.unexpected?.owner === owner) throw state.unexpected.error;
  const comparison =
    state.comparison.kind !== "idle" && state.comparison.owner === owner ? state.comparison : null;
  const right = comparison?.kind === "ready" ? comparison.content : null,
    left = loaded?.value ?? content;
  const resolvedFormat =
    format !== "auto"
      ? format
      : inferred(left.source) === "raster" && right && inferred(right.source) === "raster"
        ? "images"
        : inferred(left.source) === "json" && right && inferred(right.source) === "json"
          ? "json"
          : resolveFormat(left.source.hints, "auto").kind === "binary" ||
              (right && resolveFormat(right.source.hints, "auto").kind === "binary")
            ? "binary"
            : "text";
  const parsed = d.positiveDecimal.decode(d.jsonString(version));
  return (
    <section className="wg-resource-rich" aria-label="Resource rich content and comparison">
      {!loaded ? (
        <p role="status">Opening verified local bytes…</p>
      ) : (
        <>
          {loaded.issue && <p role="alert">{loaded.issue}</p>}
          <RichContent
            source={left.source}
            worker={controller.worker}
            totalBytes={left.blob.size}
          />
        </>
      )}
      <details
        className="wg-resource-comparison"
        onToggle={(e) => setComparisonOpen(e.currentTarget.open)}
      >
        <summary>Compare versions</summary>
        <p className="wg-hint">
          See what changed between saved files. The document you’re reading stays on the left;
          choose another version for the right. Comparing never changes either file.
        </p>
        <Toolbar label="Choose comparison">
          {http && comparisonOpen ? (
            <VersionChoice http={http} pin={content.pin} value={version} onChange={setVersion} />
          ) : (
            <Field
              label="Right content version"
              value={version}
              inputMode="numeric"
              onChange={(event) => setVersion(event.target.value)}
            />
          )}
          <Button
            disabled={!parsed.ok}
            onClick={() => {
              if (parsed.ok) void controller.compareVersion(content.pin, parsed.value);
            }}
          >
            Compare versions
          </Button>
          <Button onClick={controller.clearComparison}>Clear comparison</Button>
        </Toolbar>
        {comparison?.kind === "loading" && (
          <p role="status">Resolving and verifying exact content v{comparison.version}…</p>
        )}
        {comparison?.kind === "failed" && <p role="alert">{comparison.message}</p>}
        {right && (
          <>
            <div className="wg-comparison-columns">
              <PinLabel content={left} side="Left" />
              <PinLabel content={right} side="Right" />
            </div>
            <Toolbar label="Comparison format">
              <Select
                label="Comparison"
                value={format}
                onChange={(event) => {
                  const value = event.target.value;
                  if (
                    value === "auto" ||
                    value === "text" ||
                    value === "json" ||
                    value === "images" ||
                    value === "binary"
                  )
                    setFormat(value);
                }}
              >
                <option value="auto">Automatic</option>
                <option value="text">Text lines</option>
                <option value="json">JSON values</option>
                <option value="images">Images</option>
                <option value="binary">File equality</option>
              </Select>
              <Download content={left} label="Download verified left" />
              <Download content={right} label="Download verified right" />
            </Toolbar>
            <CompareProjection
              left={left}
              right={right}
              worker={controller.worker}
              format={resolvedFormat}
            />
            <details>
              <summary>View both original files</summary>
              <div className="wg-comparison-columns">
                <ContentViewer source={left.source} />
                <ContentViewer source={right.source} />
              </div>
            </details>
          </>
        )}
      </details>
    </section>
  );
}
