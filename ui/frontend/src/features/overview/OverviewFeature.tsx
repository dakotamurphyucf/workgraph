import { NotificationSettings } from "./NotificationSettings";
import { scopeKey } from "./model";
import { ManagementPresentation } from "../connections/management-presentation";
import { useState } from "react";
import { OverviewLoading } from "./OverviewLoading";
import { useOverview } from "./use-overview";
import { Button, StatePanel } from "../../components/Primitives";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import type { OverviewFeatureProps, OverviewManagementSection } from "./types";
import { OverviewDashboard } from "./dashboard";
import "./overview.css";
import "./overview-settings.css";

export function OverviewFeature({ context, controller, renderManagement }: OverviewFeatureProps) {
  const { state, run, matches } = useOverview(context, controller);
  const [dialog, setDialog] = useState<"management" | "notifications" | null>(null);
  const [managementSection, setManagementSection] = useState<OverviewManagementSection>(
    context.route.workspaceId === null ? "workspace" : "project",
  );
  const scope = state.scope;
  const management =
    dialog === "management" && renderManagement !== undefined ? (
      <Dialog
        title="Manage workspace"
        description="Organize your projects and milestones, or manage the local workspace."
        onClose={() => setDialog(null)}
        wide
      >
        <div className="ov-settings">
          <nav className="ov-settings-tabs" aria-label="Workspace settings">
            {(
              [
                ["project", "Projects", "facts", "Goals & tickets"],
                ["milestone", "Milestones", "milestone", "Stages & dates"],
                ["workspace", "Workspaces", "overview", "Local collections"],
                ["maintenance", "Maintenance", "settings", "Backup & storage"],
              ] as const
            ).map(([value, label, icon, description]) => (
              <button
                key={value}
                data-section={value}
                aria-current={managementSection === value ? "page" : undefined}
                onClick={() => setManagementSection(value)}
              >
                <span className="ov-settings-tab-icon">
                  <Icon name={icon} />
                </span>
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
              </button>
            ))}
          </nav>
          <ManagementPresentation value={true}>
            <div
              className="ov-settings-content"
              data-section={managementSection}
              key={managementSection}
            >
              {renderManagement(managementSection)}
            </div>
          </ManagementPresentation>
        </div>
      </Dialog>
    ) : null;
  if (context.route.workspaceId === null)
    return (
      <div className="ov-feature" data-feature="overview">
        <StatePanel
          kind="empty"
          title="Your next project starts here"
          action={
            <Button tone="primary" onClick={() => setDialog("management")}>
              Choose or create a workspace
            </Button>
          }
        >
          <p>A workspace keeps your projects, tickets, conversations and resources together.</p>
        </StatePanel>
        {management}
      </div>
    );
  if (scope === null || !matches) return <OverviewLoading />;
  const initialReads = [state.summary, state.coordination, state.questions, state.digest];
  for (const read of initialReads) {
    if (read.kind === "unexpected_error") throw read.error;
  }
  // Reveal the dashboard once the initial reads have settled, including failures.
  // Existing results remain mounted during refresh/navigation back to this scope.
  if (
    initialReads.some(
      (read) => read.kind === "idle" || (read.kind === "loading" && read.previous === undefined),
    )
  )
    return <OverviewLoading />;
  return (
    <div className="ov-feature" data-feature="overview">
      {!state.currentProfile && (
        <p role="alert">
          Connection details are being refreshed. Previously loaded data is still shown.
        </p>
      )}
      {state.issue !== null && <p role="alert">{state.issue.message}</p>}
      <OverviewDashboard
        state={state}
        scope={scope}
        context={context}
        controller={controller}
        run={run}
        onManage={() => setDialog("management")}
        onNotifications={() => setDialog("notifications")}
      />
      {management}
      {dialog === "notifications" && (
        <NotificationSettings
          key={scopeKey(scope)}
          state={state}
          scope={scope}
          controller={controller}
          run={run}
          onClose={() => {
            controller.stop();
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}
