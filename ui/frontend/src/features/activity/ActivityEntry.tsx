import { commentCodec } from "../work/progress/client";
import { jsonField } from "../../core/json";
import type { TicketComment } from "../work/progress/types";
import { ActorAvatar } from "../../components/ActorAvatar";
import { Icon, type IconName } from "../../components/Icon";
import { field } from "../overview/codecs";
import { Sources } from "../overview/presentation";
import type { DigestEntry, OverviewScope } from "../overview/types";

function appearance(category: string): { icon: IconName; label: string; tone: string } {
  switch (category) {
    case "progress":
      return { icon: "discussions", label: "Comment", tone: "violet" };
    case "completion":
      return { icon: "work", label: "Completed", tone: "green" };
    case "ownership":
      return { icon: "participants", label: "Ownership", tone: "amber" };
    case "task_changed":
      return { icon: "work", label: "Ticket updated", tone: "blue" };
    case "resource":
    case "resource_changed":
      return { icon: "resources", label: "Resource", tone: "blue" };
    case "fact":
    case "fact_changed":
      return { icon: "facts", label: "Fact updated", tone: "violet" };
    case "request":
      return { icon: "discussions", label: "Request", tone: "amber" };
    case "communication":
      return { icon: "discussions", label: "Discussion", tone: "violet" };
    default:
      return { icon: "activity", label: category.replaceAll("_", " "), tone: "neutral" };
  }
}
function commentSummary(comment: TicketComment): string {
  if (comment.tombstone) return "Removed a comment";
  if (comment.revision !== "1") return "Edited a comment";
  if (comment.origin === "completion") return "Recorded completion evidence";
  if (comment.replyToId !== null) return "Replied to a comment";
  switch (comment.kind) {
    case "comment":
      return "Added a comment";
    case "progress":
      return "Shared a progress update";
    case "decision":
      return "Recorded a decision";
    case "blocker":
      return "Reported a blocker";
    case "evidence":
      return "Shared evidence";
  }
}
export function ActivityEntry({
  entry,
  scope,
}: {
  readonly entry: DigestEntry;
  readonly scope: OverviewScope;
}) {
  const { item } = entry,
    visual = appearance(entry.category);
  const claim = entry.category === "ownership" ? jsonField(item.record, "claim") : undefined;
  const created = item.kind === "request" ? jsonField(item.record, "created") : undefined;
  const attribution =
    claim?.kind === "object" ? claim : created?.kind === "object" ? created : null;
  const actor =
    field(item.record, "actor_id") ??
    field(item.record, "author_id") ??
    (attribution === null ? null : field(attribution, "actor_id"));
  const decoded = item.kind === "comment" ? commentCodec.decode(item.record) : null;
  const comment = decoded?.ok ? decoded.value : null;
  const body = comment?.tombstone
    ? null
    : item.kind === "comment"
      ? field(item.record, "body")
      : null;
  const summary =
    comment === null ? item.summary.replace(/^[a-z_]+:\s*/u, "") : commentSummary(comment);
  const target = jsonField(item.record, "target");
  const targetLabel =
    target?.kind === "object" && field(target, "kind") === "ticket" ? field(target, "id") : null;
  const stamp =
    field(item.record, "timestamp") ??
    (created?.kind === "object" ? field(created, "timestamp") : null);
  const date =
    stamp === null ? null : new Date(stamp.replace(" ", "T").replace(/(\.\d{3})\d+(?=Z$)/u, "$1"));
  const time =
    date === null || Number.isNaN(date.getTime())
      ? null
      : new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }).format(date);
  return (
    <article className="ac-entry" data-tone={visual.tone}>
      <div className="ac-entry-marker">
        {actor ? <ActorAvatar actor={actor} /> : <Icon name={visual.icon} />}
      </div>
      <div className="ac-entry-body">
        <header>
          <p className="ac-entry-title">
            {actor && <strong>{actor} </strong>}
            <span>
              {actor && comment ? summary.charAt(0).toLowerCase() + summary.slice(1) : summary}
            </span>
            {targetLabel && <span className="ac-entry-target"> on {targetLabel}</span>}
          </p>
          {time ? (
            <time title={stamp ?? undefined}>{time}</time>
          ) : (
            <span className="ac-entry-revision" title="This record has no event timestamp">
              r{entry.revision}
            </span>
          )}
        </header>
        {body !== null && (
          <p className="ac-entry-excerpt">{body.length > 300 ? `${body.slice(0, 300)}…` : body}</p>
        )}
        <div className="ac-entry-footer">
          <div className="ac-entry-meta">
            <span className="ac-entry-category">{visual.label}</span>
            <div className="ac-entry-links">
              <Sources scope={scope} sources={item.sources} item={item} />
            </div>
          </div>
          <details className="ac-entry-details">
            <summary>Details</summary>
            <p>{item.summary}</p>
            <p>
              Revision {entry.revision} · change {entry.changeIndex}
              {field(item.record, "run_id") ? ` · run ${field(item.record, "run_id")}` : ""}
            </p>
            {item.clipped.map((clip) => (
              <p key={clip.field}>
                {clip.field}: {clip.omittedBytes} bytes omitted from this preview. Open the source
                for its retained content.
              </p>
            ))}
          </details>
        </div>
      </div>
    </article>
  );
}
