import { ActivityEntry } from "../activity/ActivityEntry";
import "../activity/activity.css";
import type { OverviewScope, OverviewState } from "./types";
/** Every entry comes from a native bounded capture; no combined revision is invented. */
export function LiveActivity({
  state,
  scope,
  compact = false,
}: {
  readonly state: OverviewState;
  readonly scope: OverviewScope;
  readonly compact?: boolean;
}) {
  const rows = state.liveActivity.flatMap((frame) => frame.value.entries).reverse();
  const unique = rows.filter(
    (entry, index) =>
      rows.findIndex(
        (other) => other.revision === entry.revision && other.changeIndex === entry.changeIndex,
      ) === index,
  );
  if (unique.length === 0) return null;
  return (
    <section className="ov-live-activity" aria-label="New activity">
      <div className="ov-live-activity-heading">
        <span className="ov-live-dot" />
        New activity<span>Updates as work happens</span>
      </div>
      {unique.slice(0, compact ? 4 : 100).map((entry) => (
        <ActivityEntry key={`${entry.revision}:${entry.changeIndex}`} entry={entry} scope={scope} />
      ))}
      {!compact && unique.length > 100 && (
        <p className="wg-hint">Showing the most recent 100 received entries.</p>
      )}
      {state.liveActivityRead.kind === "failed" && (
        <p role="status" className="wg-hint">
          Updates are reconnecting. Previously received activity stays visible.
        </p>
      )}
    </section>
  );
}
