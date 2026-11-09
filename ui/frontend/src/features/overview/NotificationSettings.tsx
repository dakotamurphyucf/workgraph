import { useEffect, useState } from "react";
import { Dialog } from "../../components/Dialog";
import { Button } from "../../components/Primitives";
import { Icon, type IconName } from "../../components/Icon";
import { current } from "./controller";
import { field } from "./codecs";
import { ticketRoute } from "./model";
import { Link, Read } from "./presentation";
import { attentionRowKey, mergeObservedChanges } from "./notification-model";
import type { AttentionRow, OverviewController, OverviewScope, OverviewState } from "./types";
import "./notification-settings.css";

type Audience = "none" | "actor" | "run";
const APPEARANCE: Readonly<
  Record<
    AttentionRow["kind"],
    { readonly icon: IconName; readonly label: string; readonly tone: string }
  >
> = {
  ticket_changed: { icon: "work", label: "Ticket", tone: "blue" },
  fact_changed: { icon: "facts", label: "Fact", tone: "purple" },
  readiness_invalidated: { icon: "workflow", label: "Readiness", tone: "gold" },
  hierarchy_policy_changed: { icon: "settings", label: "Policy", tone: "gold" },
  communication_group: { icon: "discussions", label: "Notification", tone: "pink" },
};

/** Modal-local drafts and observed rows. The controller owns reads, guards and cancellation. */
export function NotificationSettings({
  state,
  scope,
  controller,
  run,
  onClose,
}: {
  readonly state: OverviewState;
  readonly scope: OverviewScope;
  readonly controller: OverviewController;
  readonly run: (task: Promise<void>) => void;
  readonly onClose: () => void;
}) {
  const applied = state.attentionFilter.recipient?.kind ?? "none";
  const [audience, setAudience] = useState<Audience>(applied);
  const [following, setFollowing] = useState(true);
  const observed = current(state.attention);
  const [history, setHistory] = useState({
    filter: state.attentionFilter,
    observation: observed,
    rows: mergeObservedChanges([], observed?.value.items ?? []),
  });
  if (history.filter !== state.attentionFilter || history.observation !== observed) {
    setHistory({
      filter: state.attentionFilter,
      observation: observed,
      rows: mergeObservedChanges(
        history.filter === state.attentionFilter ? history.rows : [],
        observed?.value.items ?? [],
      ),
    });
  }
  const busy = state.refreshing || (state.attention.kind === "loading" && !state.waiting);
  const available =
    audience === "none" || (audience === "actor" ? scope.actorId !== null : scope.runId !== null);
  const needsPages = observed?.value.hasMore ?? false;
  const limited = observed?.value.needsLargerBudget ?? false;
  const failed = state.attention.kind === "failed" || state.issue !== null;
  useEffect(() => () => controller.stop(), [controller]);
  useEffect(() => {
    if (
      !following ||
      busy ||
      state.waiting ||
      failed ||
      !state.currentProfile ||
      state.attention.kind !== "ready" ||
      needsPages ||
      limited
    )
      return;
    const timer = setTimeout(() => run(controller.wait()), 1000);
    return () => clearTimeout(timer);
  }, [
    following,
    busy,
    failed,
    state.waiting,
    state.currentProfile,
    state.attention.kind,
    observed,
    needsPages,
    limited,
    controller,
    run,
  ]);
  const apply = () => {
    if (!available) return;
    controller.stop();
    const recipient =
      audience === "actor" && scope.actorId !== null
        ? { kind: "actor" as const, id: scope.actorId }
        : audience === "run" && scope.runId !== null
          ? { kind: "run" as const, id: scope.runId }
          : null;
    run(
      controller.setAttentionFilter({
        ...state.attentionFilter,
        kinds:
          recipient === null
            ? ["ticket", "fact", "readiness"]
            : ["ticket", "fact", "readiness", "communication"],
        recipient,
        excludeSelf: false,
      }),
    );
  };
  const status = failed
    ? "Needs attention"
    : limited
      ? "Read limit reached"
      : needsPages
        ? "More changes to load"
        : !following
          ? "Paused"
          : state.waiting
            ? "Listening"
            : busy
              ? "Updating"
              : "Following changes";
  return (
    <Dialog
      title="Notification settings"
      description="Choose the updates you want to follow in this Overview."
      onClose={onClose}
      wide
    >
      <div className="ov-notification-settings">
        <div className="ov-notification-scope">
          <span>
            <Icon name="overview" /> Workspace <strong>{scope.workspaceId}</strong>
          </span>
          {scope.projectId !== null && (
            <span>
              <Icon name="facts" /> Project <strong>{scope.projectId}</strong>
            </span>
          )}
        </div>
        <section className="ov-notification-card" aria-labelledby="notification-sources-title">
          <header>
            <span className="ov-notification-section-icon">
              <Icon name="filter" />
            </span>
            <div>
              <h3 id="notification-sources-title">Choose update sources</h3>
              <p>
                Workspace changes are always included. You can also include notifications addressed
                to an actor or a run.
              </p>
            </div>
          </header>
          <div className="ov-notification-card-body">
            <fieldset className="ov-notification-options">
              <legend className="ov-notification-legend">Include updates for</legend>
              {(
                [
                  {
                    id: "none",
                    icon: "overview",
                    title: "Workspace only",
                    detail: "Ticket, fact and work-readiness changes.",
                    identity: null,
                    disabled: false,
                  },
                  {
                    id: "actor",
                    icon: "participants",
                    title: "Selected actor",
                    detail: "An actor is the person or agent named on an action.",
                    identity: scope.actorId,
                    disabled: scope.actorId === null,
                  },
                  {
                    id: "run",
                    icon: "activity",
                    title: "Selected run",
                    detail: "A run identifies one recorded agent invocation.",
                    identity: scope.runId,
                    disabled: scope.runId === null,
                  },
                ] as const
              ).map((option) => (
                <label
                  key={option.id}
                  className="ov-notification-option"
                  data-selected={audience === option.id}
                  data-disabled={option.disabled}
                >
                  <input
                    type="radio"
                    name="notification-audience"
                    value={option.id}
                    checked={audience === option.id}
                    disabled={option.disabled || busy}
                    onChange={() => setAudience(option.id)}
                  />
                  <span className="ov-notification-option-icon">
                    <Icon name={option.icon} />
                  </span>
                  <strong>{option.title}</strong>
                  <span>{option.detail}</span>
                  {option.id !== "none" && (
                    <small>
                      {option.identity ??
                        `Choose ${option.id === "actor" ? "an actor" : "a run"} in the sidebar first.`}
                    </small>
                  )}
                </label>
              ))}
            </fieldset>
            <div className="ov-notification-apply">
              <p>
                {audience !== applied
                  ? "Selection changed. Apply it to update this view."
                  : `Currently applied: ${applied === "none" ? "workspace changes only" : `workspace + selected ${applied}`}.`}
              </p>
              <Button
                tone="primary"
                disabled={!available || audience === applied || state.refreshing}
                onClick={apply}
              >
                Apply preferences
              </Button>
            </div>
            <details className="ov-notification-help">
              <summary>What these settings change</summary>
              <p>
                Apply updates this Overview’s read filter. It does not create a subscription, send
                desktop alerts, or change another user’s settings. The preference is not saved
                across a browser reload.
              </p>
              <p>
                Reading updates does not acknowledge messages or resolve questions. Open Discussions
                to reply or record those actions. Closing this dialog stops its listener; the main
                Overview continues its own live updates.
              </p>
            </details>
          </div>
        </section>
        <section className="ov-notification-card" aria-labelledby="notification-changes-title">
          <header>
            <span className="ov-notification-section-icon ov-notification-section-icon--green">
              <Icon name="activity" />
            </span>
            <div>
              <h3 id="notification-changes-title">Observed changes</h3>
              <p>
                The latest 100 changes observed in this dialog, not a complete activity history.
              </p>
            </div>
            <span
              className="ov-notification-status"
              data-warning={failed || limited}
              data-paused={!following}
            >
              {status}
            </span>
          </header>
          <div className="ov-notification-card-body">
            <div className="ov-notification-listening">
              <p>
                New matching changes appear automatically while this dialog is open. Previously
                observed changes stay visible.
              </p>
              <Button
                onClick={() => {
                  if (following) controller.stop();
                  setFollowing(!following);
                }}
              >
                {following ? "Pause listening" : "Resume listening"}
              </Button>
            </div>
            {state.issue !== null && (
              <p role="alert" className="wg-error">
                {state.issue.message}
              </p>
            )}
            <Read quiet state={state.attention} label="Observed changes">
              {() =>
                history.rows.length === 0 ? (
                  <div className="ov-notification-empty">
                    <Icon name="check" />
                    <strong>No changes in this window</strong>
                    <p>
                      {following
                        ? "New matching updates will appear here while listening."
                        : "Resume listening to check for new updates."}
                    </p>
                  </div>
                ) : (
                  <ul className="ov-notification-events">
                    {history.rows.map((row) => {
                      const style = APPEARANCE[row.kind],
                        ticket = field(row.raw, "ticket_id");
                      return (
                        <li key={attentionRowKey(row)} data-tone={style.tone}>
                          <span className="ov-notification-event-icon">
                            <Icon name={style.icon} />
                          </span>
                          <div>
                            <strong>
                              {ticket === null ? (
                                row.title
                              ) : (
                                <Link route={ticketRoute(scope, ticket)}>{row.title}</Link>
                              )}
                            </strong>
                            <div className="ov-notification-event-meta">
                              <span>{style.label}</span>
                              <span>Revision {row.revision}</span>
                              {row.notificationIds.length > 0 && (
                                <span>
                                  {row.notificationIds.length} notification
                                  {row.notificationIds.length === 1 ? "" : "s"}
                                </span>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )
              }
            </Read>
            {needsPages && (
              <div className="ov-notification-continuation">
                <p>Load the remaining captured changes before listening for newer ones.</p>
                <Button
                  disabled={busy || state.waiting || limited}
                  onClick={() => run(controller.nextAttention())}
                >
                  Load more changes
                </Button>
              </div>
            )}
            {limited && (
              <p role="alert" className="wg-error">
                This window exceeds the read limit. Narrow the selected workspace/project or
                notification source, then apply again.
              </p>
            )}
            {failed && (
              <Button
                disabled={busy || needsPages || limited}
                onClick={() =>
                  run(observed === undefined ? controller.refresh() : controller.wait())
                }
              >
                Retry reading changes
              </Button>
            )}
          </div>
        </section>
        <div className="ov-notification-footer">
          <p>
            <Icon name="discussions" /> Need to answer a question?{" "}
            <Link
              route={{
                view: "discussions",
                connectionId: scope.connection.id,
                workspaceId: scope.workspaceId,
                projectId: scope.projectId,
                entityId: null,
              }}
            >
              Open Discussions
            </Link>
          </p>
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Dialog>
  );
}
