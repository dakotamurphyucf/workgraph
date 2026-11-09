import { useMemo, useState, type ReactNode } from "react";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { Icon } from "../../../components/Icon";
import { ContentViewer, type ContentHints, type ContentSource } from "../../../content";
import { jsonField, type JsonValue } from "../../../core/json";
import type { ProjectedItem } from "../formats";
import { prettyJson } from "./pretty-json";
import { recordedHints, toolInputParts, outputDocuments, structuredText } from "./tool-display";
import { transcriptContent } from "./content-lane";

function LazyDetails({
  summary,
  children,
}: {
  readonly summary: ReactNode;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{summary}</summary>
      {open && children}
    </details>
  );
}
export function HistoryText({
  text,
  identity,
  label,
  code = false,
  hints,
}: {
  readonly text: string;
  readonly identity: string;
  readonly label: string;
  readonly code?: boolean;
  readonly hints?: ContentHints;
}) {
  const { language, mime, filename, intent } = hints ?? {};
  const source = useMemo<ContentSource>(
    () => ({
      key: identity,
      label,
      bytes: new TextEncoder().encode(text),
      completeness: "complete",
      hints: {
        intent: intent ?? (code ? "code" : "prose"),
        ...(language ? { language } : {}),
        ...(mime ? { mime } : {}),
        ...(filename ? { filename } : {}),
      },
    }),
    [text, identity, label, code, language, mime, filename, intent],
  );
  return <ContentViewer client={transcriptContent} source={source} chrome="message" />;
}
function ToolInput({
  item,
  identity,
}: {
  readonly item: Extract<ProjectedItem, { kind: "tool-call" }>;
  readonly identity: string;
}) {
  const description = jsonField(item.arguments, "description");
  return (
    <div className="ht-tool-input">
      {description?.kind === "string" && <p className="ht-tool-description">{description.value}</p>}
      {toolInputParts(item).map((part, index) => (
        <div key={index}>
          <span className="ht-tool-part-label">{part.label}</span>
          <HistoryText
            text={part.text}
            identity={`${identity}/${index}`}
            label={part.label}
            hints={part.hints}
          />
        </div>
      ))}
    </div>
  );
}
function OutputText({
  text,
  identity,
  hints,
}: {
  readonly text: string;
  readonly identity: string;
  readonly hints?: ContentHints;
}) {
  const documents = useMemo(() => outputDocuments(text), [text]);
  if (!documents)
    return (
      <HistoryText
        text={text}
        identity={identity}
        label="Recorded tool output"
        {...(hints ? { hints } : {})}
      />
    );
  return (
    <>
      {documents.map((value, index) => {
        const output = jsonField(value, "output"),
          exit = jsonField(value, "exit_code");
        // Known exec_command envelopes. Unrecognized objects are formatted whole.
        const shellEnvelope =
          output?.kind === "string" &&
          (exit?.kind === "number" || exit?.kind === "null") &&
          jsonField(value, "wall_time_seconds")?.kind === "number";
        const innerOutput = shellEnvelope ? structuredText(output.value) : null;
        return (
          <div className="ht-output-part" key={index}>
            {documents.length > 1 && <span className="ht-tool-part-label">Output {index + 1}</span>}
            {shellEnvelope ? (
              <>
                <span
                  className={`ht-tool-part-label ${exit.kind === "number" && exit.lexeme !== "0" ? "is-error" : ""}`}
                >
                  {exit.kind === "number" ? `Exit code ${exit.lexeme}` : "Process still running"}
                </span>
                <HistoryText
                  text={innerOutput ? prettyJson(innerOutput) : output.value}
                  identity={`${identity}/${index}`}
                  label="Command output"
                  hints={innerOutput ? { language: "json" } : { intent: "prose" }}
                />
                <LazyDetails summary="Execution details">
                  <HistoryText
                    text={prettyJson(value)}
                    identity={`${identity}/${index}/details`}
                    label="Execution details"
                    hints={{ language: "json" }}
                  />
                </LazyDetails>
              </>
            ) : (
              <HistoryText
                text={prettyJson(value)}
                identity={`${identity}/${index}`}
                label="Structured tool output"
                hints={{ language: "json" }}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
/** Tool outputs may be text or a structured array of text/attachment blocks.
 * Only known text blocks become prose; everything else retains its actual data. */
export function ToolContent({
  value,
  identity,
}: {
  readonly value: JsonValue;
  readonly identity: string;
}) {
  if (value.kind === "string") return <OutputText text={value.value} identity={identity} />;
  if (value.kind === "array")
    return (
      <>
        {value.items.map((v, i) => {
          const type = jsonField(v, "type"),
            text = jsonField(v, "text");
          return type?.kind === "string" &&
            ["text", "input_text", "output_text"].includes(type.value) &&
            text?.kind === "string" ? (
            <OutputText
              key={i}
              text={text.value}
              identity={`${identity}/${i}`}
              hints={recordedHints(v)}
            />
          ) : (
            <div key={i} className="ht-attachment">
              <Icon name="resources" />
              <span>
                Attachment{type?.kind === "string" ? ` · ${type.value}` : ""} · view its retained
                representation below.
              </span>
              <LazyDetails summary="Attachment details">
                <HistoryText
                  text={prettyJson(v)}
                  identity={`${identity}/${i}/attachment`}
                  label="Attachment data"
                  hints={{ language: "json" }}
                />
              </LazyDetails>
            </div>
          );
        })}
      </>
    );
  return (
    <HistoryText
      text={prettyJson(value)}
      label="Recorded tool output"
      identity={identity}
      hints={{ language: "json" }}
    />
  );
}
export function ConversationBlock({
  item,
  index,
  identity,
  pairedResult,
}: {
  readonly pairedResult?: ReactNode;
  readonly item: ProjectedItem;
  readonly index: number;
  readonly identity: string;
}) {
  const key = `${identity}/projected/${index}`;
  if (item.kind === "text") {
    const reasoning =
      item.interpretation === "summary" || item.interpretation === "retained-reasoning";
    const label = reasoning
      ? item.interpretation === "summary"
        ? "Reasoning / saved summary"
        : "Recorded thinking"
      : item.role === "user"
        ? "User"
        : item.role === "assistant"
          ? "Assistant"
          : item.role === "system" || item.role === "developer"
            ? "Instructions"
            : (item.role ?? "Recorded response");
    const body = <HistoryText text={item.text} identity={key} label={label} />;
    if (reasoning)
      return (
        <div className="ht-chat-block ht-chat-reasoning">
          <LazyDetails
            summary={
              <>
                <Icon name="facts" />
                <strong>{label}</strong>
                <span>Read retained text</span>
              </>
            }
          >
            {body}
          </LazyDetails>
        </div>
      );
    return (
      <section className={`ht-chat-block ht-chat-message ${item.role === "user" ? "is-user" : ""}`}>
        <header>
          <ActorAvatar actor={item.role ?? "assistant"} />
          <strong>{label}</strong>
          {item.phase && (
            <span className="ht-chat-tag">
              {item.phase === "final_answer" ? "Final response" : item.phase}
            </span>
          )}
          {item.interpretation === "refusal" && <span className="ht-chat-tag">Refusal</span>}
          {item.interpretation === "reported-error" && (
            <span className="ht-chat-tag is-error">Reported error</span>
          )}
        </header>
        <div className="ht-chat-body">{body}</div>
      </section>
    );
  }
  if (item.kind === "tool-call")
    return (
      <section className="ht-chat-block ht-chat-tool ht-tool-combined">
        <header className="ht-tool-heading">
          <Icon name="advanced" />
          <strong>{item.name}</strong>
          <span>{pairedResult ? "Call & result" : "Tool call"}</span>
        </header>
        <ToolInput item={item} identity={key} />
        {pairedResult ?? (
          <p className="ht-tool-unmatched">No uniquely matched result in the loaded events.</p>
        )}
      </section>
    );
  if (item.kind === "tool-result")
    return (
      <section className="ht-chat-block ht-chat-tool is-result">
        <LazyDetails
          summary={
            <>
              <Icon name="advanced" />
              <strong>Tool result</strong>
              <span>{item.reportedError === true ? "Reported error" : "Recorded output"}</span>
            </>
          }
        >
          <ToolContent value={item.content} identity={key} />
        </LazyDetails>
      </section>
    );
  if (item.kind === "opaque-reasoning")
    return (
      <div className="ht-chat-marker">
        <Icon name="facts" />
        <span>
          {item.retention === "signature"
            ? "Thinking signature retained"
            : `${item.retention === "encrypted" ? "Encrypted" : "Redacted"} reasoning`}{" "}
          · no readable text in this block
        </span>
      </div>
    );
  if (item.kind === "marker")
    return (
      <div className="ht-chat-marker">
        <Icon name="history" />
        <span>
          {item.label}
          {item.reportedStatus ? ` · ${item.reportedStatus}` : ""}
        </span>
      </div>
    );
  return (
    <div className="ht-chat-marker is-unknown">
      <Icon name="resources" />
      <span>{item.reason}. Read the original event source for this content.</span>
    </div>
  );
}
