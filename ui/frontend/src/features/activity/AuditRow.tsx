import { routeHref } from "../../app/navigation";
import { ActorAvatar } from "../../components/ActorAvatar";
import { Icon, type IconName } from "../../components/Icon";
import { LazyDetails } from "../connections/shared";
import { field } from "../overview/codecs";
import type { OverviewScope } from "../overview/types";
import { auditDate, describeChange, type ChangeDescription } from "./model";
import type { AuditEvent } from "./types";

/** Category color is a navigation cue, never an inferred ticket status. */
const categories: Readonly<Record<string, { label: string; icon: IconName; tone: string }>> = {
  ticket_put: { label: "Ticket", icon: "work", tone: "blue" },
  project_put: { label: "Project", icon: "overview", tone: "purple" },
  milestone_put: { label: "Milestone", icon: "milestone", tone: "purple" },
  comment_changed: { label: "Conversation", icon: "discussions", tone: "pink" },
  communication_changed: { label: "Discussion", icon: "discussions", tone: "pink" },
  facts_changed: { label: "Fact", icon: "facts", tone: "green" },
  resource_changed: { label: "Resource", icon: "resources", tone: "purple" },
  agent_run_changed: { label: "Participant", icon: "participants", tone: "green" },
  evidence_changed: { label: "Evidence", icon: "check", tone: "blue" },
  hierarchy_policy_put: { label: "Workflow", icon: "workflow", tone: "orange" },
  handoff_put: { label: "Handoff", icon: "participants", tone: "orange" },
  ticket_recovered: { label: "Recovery", icon: "refresh", tone: "orange" },
};
function Subject({ description }: { readonly description: ChangeDescription }) {
  return description.route ? (
    <a href={routeHref(description.route)}>{description.subject}</a>
  ) : (
    <span>{description.subject}</span>
  );
}
export function AuditRow({
  event,
  scope,
  onOpenChange,
}: {
  readonly event: AuditEvent;
  readonly scope: OverviewScope;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const first = event.changes[0];
  const description = first === undefined ? null : describeChange(first, scope);
  const category = categories[first ? (field(first, "kind") ?? "") : ""] ?? {
    label: "Change",
    icon: "activity",
    tone: "blue",
  };
  const date = auditDate(event.timestamp);
  const clock =
    date === null
      ? "Time unavailable"
      : new Intl.DateTimeFormat(undefined, {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        }).format(date);
  return (
    <article className="ac-entry" data-revision={event.revision}>
      <div className="ac-entry-marker">
        <ActorAvatar actor={event.actorId} />
      </div>
      <div className="ac-entry-body">
        <header>
          <p className="ac-entry-title">
            <strong>{event.actorId}</strong> {description?.verb ?? "recorded a change"}{" "}
            {description && <Subject description={description} />}
          </p>
          <time
            dateTime={date?.toISOString()}
            title={
              date === null ? event.timestamp : `${date.toLocaleString()} · ${event.timestamp}`
            }
          >
            {clock}
          </time>
        </header>
        {description?.detail && (
          <p className="ac-entry-excerpt">
            {description.detail.length > 280
              ? `${description.detail.slice(0, 280)}…`
              : description.detail}
          </p>
        )}
        <div className="ac-audit-detail">
          <span className="ac-category" data-tone={category.tone}>
            <Icon name={category.icon} />
            {category.label}
          </span>
          <LazyDetails
            onOpenChange={onOpenChange}
            summary={
              event.changes.length > 1 ? `Details · ${event.changes.length} changes` : "Details"
            }
          >
            <div className="ac-record-details">
              <div className="ac-record-heading">
                <Icon name="history" />
                <h4>Recorded changes</h4>
                <span>Revision {event.revision}</span>
              </div>
              <ol className="ac-change-list">
                {event.changes.map((change, index) => {
                  const item = describeChange(change, scope);
                  return (
                    <li key={index}>
                      <p>
                        <strong>{item.verb}</strong> <Subject description={item} />
                      </p>
                      {item.detail && <p className="ac-change-body">{item.detail}</p>}
                    </li>
                  );
                })}
              </ol>
              <dl className="ac-record-meta">
                <div>
                  <dt>Recorded by</dt>
                  <dd>
                    <ActorAvatar actor={event.actorId} />
                    {event.actorId}
                  </dd>
                </div>
                <div>
                  <dt>Recorded at</dt>
                  <dd>{date?.toLocaleString() ?? event.timestamp}</dd>
                </div>
                {event.runId && (
                  <div>
                    <dt>Run</dt>
                    <dd>{event.runId}</dd>
                  </div>
                )}
              </dl>
              <p className="ac-record-note">
                This record preserves what was saved at the time. Ticket and run links open the
                current item; comment revision links open the recorded version.
              </p>
            </div>
          </LazyDetails>
        </div>
      </div>
    </article>
  );
}
