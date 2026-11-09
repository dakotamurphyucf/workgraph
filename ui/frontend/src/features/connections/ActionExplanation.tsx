import type { LifecycleEditor, LifecycleKind } from "./store";
import type { AdminKind } from "../administration/types";

interface Explanation {
  readonly outcome: string;
  readonly detail: string;
}
type ArchiveKind = "workspace_archive" | "project_archive" | "milestone_archive";
const LIFECYCLE: Readonly<Record<Exclude<LifecycleKind, ArchiveKind>, Explanation>> = {
  workspace_create: {
    outcome: "Create a new workspace folder, add it to this daemon’s list, and open it for use.",
    detail:
      "Give it a name and a full path to a new folder on the daemon’s machine. This creates an empty workspace; add projects and tickets afterward. An optional ID is its permanent identifier, not its display name.",
  },
  workspace_register: {
    outcome: "Connect an existing workspace folder to this daemon and open it.",
    detail:
      "Use this for a workspace that already has Workgraph data on disk. The folder is checked before registration. This uses the existing data in place; it does not create a copy or restore a backup.",
  },
  workspace_open: {
    outcome: "Load this registered workspace so clients can read and work with it.",
    detail:
      "The workspace’s saved data is loaded from its existing folder. Opening is separate from its archive flag; it does not restore an archived item or import a backup.",
  },
  workspace_close: {
    outcome:
      "Unload this workspace from the daemon. Clients will need it reopened before they can continue using it.",
    detail:
      "Its files remain on disk. This is useful before handing the workspace to another process or doing offline maintenance. The daemon may reject closing if ongoing work prevents it.",
  },
  workspace_unregister: {
    outcome: "Remove this workspace from this daemon’s registered-workspace list.",
    detail:
      "Close it first. Its folder and data are kept, so it can be registered again later. This is different from deleting files or archiving the workspace.",
  },
  workspace_edit: {
    outcome: "Save the workspace name, summary, description and instructions shown in this form.",
    detail:
      "The summary is a quick introduction; the description gives the full context. Instructions are guidance that agents can read, not enforced permissions. Clearing a text field saves it as empty. This does not move the workspace folder or rename its ID.",
  },
  project_create: {
    outcome: "Add a new project to the selected workspace with this title and description.",
    detail:
      "A project groups work around an outcome. Creating it does not create tickets or start agents; add tickets from the Work page and milestones here afterward. Leave the ID blank to generate one automatically.",
  },
  project_edit: {
    outcome:
      "Save the project title, status, priority, acceptance criteria, summary and description shown below.",
    detail:
      "Acceptance criteria describe the evidence needed for success. Clearing a text field removes its existing text. Changing the project status does not change ticket statuses or run the completion checks; use Readiness & finish for that.",
  },
  project_finish: {
    outcome:
      "Ask Workgraph to check this project’s completion requirements and, if they pass, finish it with your evidence and handoff.",
    detail:
      "Evidence explains how the goal was met. The handoff summary tells the next reader what was delivered; next steps record any follow-up. Open tickets are not completed automatically. Resolve failed checks before trying to finish again.",
  },
  milestone_create: {
    outcome:
      "Add a milestone to the project identified below, with a title, description and optional target date.",
    detail:
      "A milestone is a stage such as a prototype or launch. Creating one does not create or move tickets; associate the relevant tickets afterward. Its target date is for planning, not an automatic schedule for agents.",
  },
  milestone_edit: {
    outcome: "Save this milestone’s title, description and status.",
    detail:
      "Clearing the description removes its existing text. Marking the milestone done records its status; it does not complete its tickets, finish its project or run project completion checks. Use Schedule to change its target date.",
  },
  milestone_schedule: {
    outcome:
      "Set this milestone’s target date, or remove its current date if you leave the field blank.",
    detail:
      "The date communicates when you aim to reach this stage. Saving it does not start work, change ticket deadlines or update the milestone’s status.",
  },
};
const ADMIN: Readonly<Record<AdminKind, Explanation>> = {
  workspace_export: {
    outcome: "Start a job that saves a portable snapshot of the chosen workspace to a new folder.",
    detail:
      "The snapshot contains committed workspace data and resource files. Use a full destination path on the daemon’s machine; its parent must exist and the destination must be new. Check the job result before treating the export as a completed backup.",
  },
  export_all: {
    outcome:
      "Start one export job that captures the daemon’s workspaces together in a new destination folder.",
    detail:
      "Allow partial capture permits omissions when a workspace cannot be captured. Such an incomplete export cannot be used for Restore all. Leave this option off when you need a complete set for restoring all workspaces.",
  },
  export_cancel: {
    outcome: "Request cancellation of the export job identified below.",
    detail:
      "This targets that existing job, not the workspace itself. A cancellation request does not prove that the job has stopped; inspect its status afterward. Source workspace data is not deleted.",
  },
  export_retry: {
    outcome: "Retry the existing export job using its original captured data and destination.",
    detail:
      "This resumes the same export intent rather than capturing the workspace again. Use a new export if you want a snapshot of newer changes. Check the retry’s final status before using the output.",
  },
  workspace_restore: {
    outcome:
      "Validate a workspace export, restore its data into a new folder, and register the restored workspace as closed.",
    detail:
      "The workspace ID must not already be registered. Nothing is restored over an existing workspace folder. After success, open it from Workspaces. This imports a backup; it is different from removing an archive flag.",
  },
  restore_all: {
    outcome:
      "Restore every member of a complete all-workspace export into the new folders you specify.",
    detail:
      "The workspace-to-root JSON maps each exported workspace ID to its full destination path. Each ID must be unregistered and each folder new. Restores can complete some members before interruption; recover using the original saved request rather than starting another.",
  },
  restore_cancel: {
    outcome:
      "Request cancellation of the pending restore identified by its original actor and mutation ID.",
    detail:
      "The actor identifies who requested the restore; the mutation ID identifies that particular request. Cancellation is allowed only before any target is installed or occupied. It releases reservations without deleting files; otherwise recover the original restore.",
  },
  migrate_0_6_2: {
    outcome:
      "Run an offline helper to convert a released 0.6.2 workspace into a new current-format workspace folder.",
    detail:
      "Stop the old daemon and resolve uncertain writes with its original executable first. Paths are on the machine running the UI service. The source stays intact; inspect the conversion report and register the new folder separately after success.",
  },
  cleanup_stage: {
    outcome: "Delete an unpublished temporary migration stage owned by the exact token below.",
    detail:
      "A stage is a temporary folder left by a conversion, not a normal workspace. The helper checks its ownership and allowed contents before removal. It does not delete the original source or a published destination. Only apply this when you intend to remove that temporary output.",
  },
};
function ExplanationCard({
  explanation,
  local = false,
}: {
  readonly explanation: Explanation;
  readonly local?: boolean;
}) {
  return (
    <aside className="wg-action-explanation" aria-label="What this action does">
      <strong>What this will do</strong>
      <p>{explanation.outcome}</p>
      <p className="wg-action-explanation-detail">{explanation.detail}</p>
      <div className="wg-action-explanation-steps">
        <span>1 · Review the request</span>
        <span>2 · {local ? "Apply the prepared helper" : "Execute to apply it"}</span>
      </div>
      <p className="wg-action-explanation-footnote">
        Reviewing prepares the action; it does not apply it.{" "}
        {local
          ? "The helper runs only after you choose Apply."
          : "The change is sent only after you choose Execute."}
      </p>
    </aside>
  );
}
export function LifecycleActionExplanation({
  editor,
}: {
  readonly editor: Pick<LifecycleEditor, "kind" | "archived">;
}) {
  switch (editor.kind) {
    case "workspace_archive":
    case "project_archive":
    case "milestone_archive": {
      const entity =
        editor.kind === "workspace_archive"
          ? "workspace"
          : editor.kind === "project_archive"
            ? "project"
            : "milestone";
      return (
        <ExplanationCard
          explanation={
            editor.archived
              ? {
                  outcome: `Mark this ${entity} as archived so it is set aside from active work.`,
                  detail: `Archiving keeps the ${entity} and its data. It does not create a backup, delete files, or mark work complete.${entity === "workspace" ? " It is separate from closing the workspace." : " Archived items are excluded from the default list; turn on Include archived to find them."} Choose Restore to remove the archive flag later.`,
                }
              : {
                  outcome: `Remove the archive flag from this ${entity}.`,
                  detail: `The existing ${entity} becomes unarchived; its other saved details stay intact. This does not import a backup, reset ticket statuses, or start agents.${entity === "workspace" ? " A closed workspace must still be opened separately." : " It will appear in the normal list again."}`,
                }
          }
        />
      );
    }
    case "workspace_create":
    case "workspace_register":
    case "workspace_open":
    case "workspace_close":
    case "workspace_unregister":
    case "workspace_edit":
    case "project_create":
    case "project_edit":
    case "project_finish":
    case "milestone_create":
    case "milestone_edit":
    case "milestone_schedule":
      return <ExplanationCard explanation={LIFECYCLE[editor.kind]} />;
  }
}
export function AdminActionExplanation({ kind }: { readonly kind: AdminKind }) {
  return (
    <ExplanationCard
      explanation={ADMIN[kind]}
      local={kind === "migrate_0_6_2" || kind === "cleanup_stage"}
    />
  );
}
