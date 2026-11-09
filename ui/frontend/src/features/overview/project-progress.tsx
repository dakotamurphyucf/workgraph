import { Icon } from "../../components/Icon";
import type { ProjectProgressSummary } from "./types";
import { progressPercent } from "./dashboard-model";

const statusStyles = [
  { status: "done", label: "Done", color: "var(--blue)" },
  { status: "in_progress", label: "In progress", color: "var(--yellow)" },
  { status: "todo", label: "To do", color: "var(--green)" },
  { status: "backlog", label: "Backlog", color: "var(--purple)" },
  { status: "canceled", label: "Canceled", color: "var(--muted)" },
] as const;
/** Status segments partition the total. Blocked is an overlapping readiness
 * count, so it is shown separately rather than double-counted in the bar. */
export function ProjectProgressPanel({
  summary,
  href,
}: {
  readonly summary: ProjectProgressSummary;
  readonly href?: string;
}) {
  const progress = summary.progress;
  if (progress === null) return null;
  const percent = progressPercent(progress);
  const segments = statusStyles.map((style) => ({
    ...style,
    count: summary.statusCounts.find((row) => row.status === style.status)?.count,
  }));
  const complete = segments.every((segment) => segment.count !== undefined);
  const width = (count: string) =>
    progress.total === "0" ? 0 : Number((BigInt(count) * 10000n) / BigInt(progress.total)) / 100;
  return (
    <div className="projectrow">
      <div className="between">
        <div className="flex">
          <span className="accent">
            <Icon name="facts" />
          </span>
          <strong>{href === undefined ? summary.title : <a href={href}>{summary.title}</a>}</strong>
        </div>
        <span className="progress-percent">{Math.round(percent)}%</span>
      </div>
      <div
        className="progressbar"
        role="progressbar"
        aria-label="Completed tickets"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${progress.done} of ${progress.total} tickets done`}
      >
        {complete ? (
          segments.map((segment) => (
            <span
              key={segment.status}
              style={{ width: `${width(segment.count!)}%`, background: segment.color }}
              title={`${segment.count} ${segment.label.toLowerCase()}`}
            />
          ))
        ) : (
          <span style={{ width: `${percent}%`, background: "var(--accent)" }} />
        )}
      </div>
      <div className="progress-caption">
        <span>
          {progress.done} of {progress.total} tickets complete
        </span>
        <span className="orange">{progress.blocked} blocked</span>
      </div>
      {complete ? (
        <div className="progress-statuses">
          {segments.map((segment) => (
            <div key={segment.status}>
              <span>
                <i className="dot" style={{ background: segment.color }} />
                <strong>{segment.count}</strong> {segment.label}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="rowdetail">
          The full status breakdown is unavailable for this capture. Refresh to retry.
        </p>
      )}
    </div>
  );
}
