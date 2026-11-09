import { useEffect, useRef, useState } from "react";
import { Button, Select, StatePanel, Toolbar } from "../components/Primitives";
import { createContentWorkerClient } from "./client";
import { useClipboardCopy } from "./clipboard";
import { CODE_LANGUAGES } from "./languages";
import { CONTENT_LIMITS } from "./limits";
import { RenderTree } from "./RenderTree";
import type {
  ContentMode,
  ContentPreview,
  ContentSource,
  ContentViewerProps,
  RenderOverride,
  WorkOutcome,
} from "./types";
import "./content.css";

// Shared admission across viewers; no worker is created until a job is submitted.
const sharedClient = createContentWorkerClient();
interface CapturedPreview {
  readonly source: ContentSource;
  readonly mode: ContentMode;
  readonly override: RenderOverride;
  readonly startLine: number;
  readonly rawOffset: number;
  readonly attempt: number;
  readonly outcome: WorkOutcome<ContentPreview>;
}
export function ContentViewer({
  source,
  client = sharedClient,
  chrome = "full",
}: ContentViewerProps) {
  const [mode, setMode] = useState<ContentMode>("rendered");
  const [override, setOverride] = useState<RenderOverride>("auto");
  const [position, setPosition] = useState({ key: source.key, line: 0, byte: 0 });
  const startLine = position.key === source.key ? position.line : 0;
  const rawOffset = position.key === source.key ? position.byte : 0;
  const [captured, setCaptured] = useState<CapturedPreview | null>(null);
  const { copy, notice } = useClipboardCopy(source, {
    unavailable: "Clipboard is unavailable. Select source text or download the captured bytes.",
    copied: "Exact decoded source copied. Byte download preserves its UTF-8 encoding.",
  });
  const [unexpected, setUnexpected] = useState<{
    readonly source: ContentSource;
    readonly error: unknown;
  } | null>(null);
  const urls = useRef(new Set<string>());
  const [attempt, setAttempt] = useState(0);
  const container = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry !== undefined) setVisible(entry.isIntersecting);
      },
      { rootMargin: "160px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (
      !visible ||
      (captured?.source === source &&
        captured.mode === mode &&
        captured.override === override &&
        captured.startLine === startLine &&
        captured.rawOffset === rawOffset &&
        captured.attempt === attempt)
    )
      return;
    const abort = new AbortController();
    void client
      .render(
        {
          key: source.key,
          bytes: source.bytes,
          hints: source.hints,
          override,
          mode,
          startLine,
          rawOffset,
        },
        abort.signal,
        { waitForCapacity: true },
      )
      .then((outcome) => {
        if (!abort.signal.aborted)
          setCaptured({ source, mode, override, startLine, rawOffset, attempt, outcome });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setUnexpected({ source, error });
      });
    return () => {
      abort.abort();
    };
  }, [source, client, mode, override, startLine, rawOffset, attempt, captured, visible]);
  useEffect(() => {
    const current = urls.current;
    return () => {
      for (const url of current) URL.revokeObjectURL(url);
      current.clear();
    };
  }, []);
  if (unexpected?.source === source) throw unexpected.error;
  const outcome =
    captured?.source === source &&
    captured.mode === mode &&
    captured.override === override &&
    captured.startLine === startLine &&
    captured.rawOffset === rawOffset &&
    captured.attempt === attempt
      ? captured.outcome
      : null;
  const preview = outcome?.ok ? outcome.value : null;
  function download() {
    const url = URL.createObjectURL(
      new Blob([source.bytes.slice()], { type: "application/octet-stream" }),
    );
    urls.current.add(url);
    const link = document.createElement("a");
    const filename =
      source.label
        .split(/[\\/]/u)
        .pop()
        ?.replace(/[^\p{L}\p{N}._ -]/gu, "_")
        .slice(0, 128) || "workgraph-source.bin";
    link.href = url;
    link.download = source.completeness === "partial" ? `${filename}.partial` : filename;
    link.rel = "noopener noreferrer";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      urls.current.delete(url);
    }, 1000);
  }
  const options = (
    <>
      <Select
        label="Language override"
        value={override}
        onChange={(event) => {
          const value = event.target.value;
          if (
            value === "auto" ||
            value === "plain" ||
            CODE_LANGUAGES.some((language) => language === value)
          ) {
            const choice =
              value === "auto" || value === "plain"
                ? value
                : CODE_LANGUAGES.find((language) => language === value);
            if (choice) setOverride(choice);
          }
        }}
      >
        <option value="auto">Auto · metadata</option>
        <option value="plain">Plain text</option>
        {CODE_LANGUAGES.map((language) => (
          <option value={language} key={language}>
            {language === "markdown" ? "Markdown" : language === "bash" ? "Shell" : language}
          </option>
        ))}
      </Select>
      <Button
        onClick={() => {
          if (preview?.copyText !== null && preview?.copyText !== undefined)
            void copy(preview.copyText);
        }}
        disabled={preview?.copyText === null || preview?.copyText === undefined}
        title={
          preview?.copyText === null
            ? `Exact text copy is limited to ${CONTENT_LIMITS.richBytes.toLocaleString()} bytes; byte download retains the entire capture.`
            : undefined
        }
      >
        Copy source
      </Button>
      <Button onClick={download} disabled={source.bytes.byteLength > CONTENT_LIMITS.inputBytes}>
        {source.completeness === "partial" ? "Download loaded bytes" : "Download source"}
      </Button>
    </>
  );
  const controls = (
    <>
      <div className="wg-content-caption">
        <strong>{source.label}</strong>
        <span>
          {source.bytes.byteLength.toLocaleString()} captured bytes
          {source.completeness === "partial" ? " · Partial content" : ""}
        </span>
      </div>
      <Toolbar label="Content presentation">
        <div className="wg-content-modes" role="group" aria-label="Content view">
          {(["rendered", "source", "raw"] as const).map((value) => (
            <Button
              key={value}
              aria-pressed={mode === value}
              onClick={() => {
                setMode(value);
              }}
            >
              {value === "rendered" ? "Rendered" : value === "source" ? "Source" : "Raw bytes"}
            </Button>
          ))}
        </div>
        {chrome !== "full" ? (
          <details className="wg-content-options">
            <summary>Content options</summary>
            <div className="wg-toolbar">{options}</div>
          </details>
        ) : (
          options
        )}
      </Toolbar>
    </>
  );
  return (
    <section
      ref={container}
      className={`wg-content-viewer wg-content-viewer--${chrome}`}
      aria-label={`Content: ${source.label}`}
    >
      {(chrome !== "message" || outcome?.ok === false) && (
        <header className="wg-content-toolbar">
          {chrome === "reading" ? (
            <details className="wg-content-reading-options">
              <summary>Source & display options</summary>
              {controls}
            </details>
          ) : (
            controls
          )}
        </header>
      )}
      {source.completeness === "partial" && (
        <p className="wg-content-warning" role="status">
          This is loaded content only. Rendering and download do not imply the full resource or
          event has been retrieved.
        </p>
      )}
      {notice && (
        <p role="status" className="wg-content-notice">
          {notice}
        </p>
      )}
      {outcome === null ? (
        chrome === "message" ? null : (
          <StatePanel kind="loading" title="Preparing content">
            <p>
              {visible
                ? "Preparing this preview as rendering capacity becomes available."
                : "This preview will load when it comes into view."}
            </p>
          </StatePanel>
        )
      ) : !outcome.ok ? (
        <StatePanel
          kind={outcome.kind === "cancelled" ? "unavailable" : "error"}
          title={outcome.kind === "timeout" ? "Preview budget reached" : "Preview unavailable"}
          action={
            <Button
              onClick={() => {
                setAttempt((value) => value + 1);
              }}
            >
              Retry preview
            </Button>
          }
        >
          <p>{outcome.message}</p>
          <p>
            {source.bytes.byteLength > CONTENT_LIMITS.inputBytes
              ? "This capture exceeds the shared input budget. Use the containing resource or event’s full download action."
              : "Raw byte view and captured-byte download remain available."}
          </p>
        </StatePanel>
      ) : (
        <>
          {chrome !== "message" && (
            <div className="wg-content-provenance">
              <span>
                {mode === "raw"
                  ? "Raw bytes"
                  : outcome.value.format.kind === "code"
                    ? (outcome.value.format.language ?? "Unrecognized language · plain code")
                    : outcome.value.format.kind}{" "}
                · {outcome.value.format.via}
              </span>
              <span>Source is unchanged</span>
            </div>
          )}
          {outcome.value.diagnostics.map((message) => (
            <p className="wg-content-warning" role="status" key={message}>
              {message}
            </p>
          ))}
          {mode === "raw" || outcome.value.status === "binary" ? (
            <div className="wg-content-byte-view">
              <p className="wg-hint">
                Bytes {outcome.value.rawOffset.toLocaleString()}–
                {(outcome.value.rawOffset + outcome.value.rawLength).toLocaleString()} of{" "}
                {source.bytes.length.toLocaleString()} · offsets are bytes
              </p>
              <pre aria-label="Raw byte window">{outcome.value.rawHex || "Empty capture"}</pre>
              <Toolbar label="Byte window navigation">
                <Button
                  disabled={rawOffset === 0}
                  onClick={() => {
                    setPosition({
                      key: source.key,
                      line: startLine,
                      byte: Math.max(0, rawOffset - CONTENT_LIMITS.rawBytes),
                    });
                  }}
                >
                  Previous bytes
                </Button>
                <Button
                  disabled={
                    outcome.value.rawOffset + outcome.value.rawLength >= source.bytes.length
                  }
                  onClick={() => {
                    setPosition({
                      key: source.key,
                      line: startLine,
                      byte: rawOffset + CONTENT_LIMITS.rawBytes,
                    });
                  }}
                >
                  Next bytes
                </Button>
              </Toolbar>
            </div>
          ) : outcome.value.nodes.length > 0 ? (
            <div className="wg-rich-content" key={`${source.key}:${mode}:${override}`}>
              <RenderTree nodes={outcome.value.nodes} />
            </div>
          ) : (
            <div className="wg-source-window">
              {outcome.value.window && (
                <>
                  <p className="wg-hint">
                    Showing lines{" "}
                    {outcome.value.window.lines[0] ? outcome.value.window.lines[0].number + 1 : 0}–
                    {(outcome.value.window.lines.at(-1)?.number ?? -1) + 1} of{" "}
                    {outcome.value.window.totalLines.toLocaleString()}. This window is not the full
                    source.
                  </p>
                  <ol start={startLine + 1} aria-label="Source line window">
                    {outcome.value.window.lines.map((line) => (
                      <li value={line.number + 1} key={line.number}>
                        <code>{line.text || " "}</code>
                        {line.omittedCharacters > 0 && (
                          <span className="wg-content-omitted">
                            {" "}
                            … {line.omittedCharacters.toLocaleString()} UTF-16 units omitted from
                            this preview line; source download retains them.
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                  <Toolbar label="Source window navigation">
                    <Button
                      disabled={startLine === 0}
                      onClick={() => {
                        setPosition({
                          key: source.key,
                          line: Math.max(0, startLine - CONTENT_LIMITS.sourceLines),
                          byte: rawOffset,
                        });
                      }}
                    >
                      Previous lines
                    </Button>
                    <Button
                      disabled={
                        (outcome.value.window.lines.at(-1)?.number ??
                          outcome.value.window.totalLines) +
                          1 >=
                        outcome.value.window.totalLines
                      }
                      onClick={() => {
                        setPosition({
                          key: source.key,
                          line: (outcome.value.window?.lines.at(-1)?.number ?? startLine) + 1,
                          byte: rawOffset,
                        });
                      }}
                    >
                      Next lines
                    </Button>
                  </Toolbar>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
