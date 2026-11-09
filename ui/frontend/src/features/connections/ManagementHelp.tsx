import { Icon } from "../../components/Icon";

type Section =
  "workspace" | "project" | "milestone" | "exports" | "restore" | "offline" | "journals";
const HELP: Readonly<
  Record<
    Section,
    { readonly title: string; readonly items: readonly (readonly [string, string])[] }
  >
> = {
  workspace: {
    title: "Creating, opening and archiving workspaces",
    items: [
      [
        "Create or register",
        "Create starts a new workspace in a new folder. Register connects an existing workspace folder to this daemon—the local server that reads and saves your work.",
      ],
      [
        "Open, close or archive",
        "Open makes the workspace available to work in. Close unloads it without deleting its files. Archive marks it as set aside; Restore removes that archive flag.",
      ],
      [
        "Unregister",
        "Remove a closed workspace from this daemon’s list. Its files stay on disk. Folder paths refer to the machine running Workgraph, which may differ from your browser’s machine.",
      ],
    ],
  },
  project: {
    title: "Planning a project and finishing it safely",
    items: [
      [
        "Start with a goal",
        "Create a project, describe the outcome, then add its tickets from the Work page. A ticket is one actionable piece of work; milestones group tickets into stages.",
      ],
      [
        "Define success",
        "Acceptance criteria describe what must be true when the work is complete. Priority helps order the work; a summary is the short overview, while the description holds the full brief.",
      ],
      [
        "Finish or archive",
        "Readiness & finish checks completion requirements and records evidence plus a handoff. Setting a status alone does not run these checks. Archive sets a project aside without deleting it.",
      ],
    ],
  },
  milestone: {
    title: "Using milestones to organize a project",
    items: [
      [
        "A stage of work",
        "A milestone represents a meaningful stage, such as a prototype or a launch. Create it under a project, then associate the relevant tickets with it.",
      ],
      [
        "Dates and status",
        "A target date is a planning aid, not an automatic deadline or scheduler. Schedule changes that date; leaving it blank clears it. Status records the stage’s current progress.",
      ],
      [
        "Completion and archive",
        "Marking a milestone done does not finish its project or complete its tickets. Archive sets the milestone aside; include archived items to find and restore it.",
      ],
    ],
  },
  exports: {
    title: "What an export saves and where it goes",
    items: [
      [
        "A portable snapshot",
        "An export saves committed workspace data and resource files to a folder. Use it for a backup, sharing, or a later restore. Normal work can continue while the export runs.",
      ],
      [
        "Choose a new folder",
        "Enter a full path on the daemon’s machine. The destination must be new, its parent folder must exist, and it must not overlap a workspace folder.",
      ],
      [
        "Review, then verify",
        "Review prepares the request; Execute starts it. The export job shows its outcome. Verify checks the saved file inventory and hashes; restore additionally checks that the data can be replayed.",
      ],
    ],
  },
  restore: {
    title: "Restoring a backup without replacing existing work",
    items: [
      [
        "Export versus archive",
        "Restore here imports an exported backup into a new folder. It is different from restoring an archived item, which simply removes that item’s archive flag.",
      ],
      [
        "A fresh destination",
        "The workspace ID must not already be registered, and the target folder must be new. Restored workspaces are registered closed; open them in Workspaces when you are ready.",
      ],
      [
        "Receipts and pending requests",
        "A receipt records what happened to a request. Actor identifies who made it; mutation ID identifies that particular change. If the outcome is uncertain, inspect or retry the original saved request rather than creating another.",
      ],
    ],
  },
  offline: {
    title: "When to use migration and cleanup",
    items: [
      [
        "Only for version 0.6.2",
        "Migration converts a released 0.6.2 workspace to the current format. It is not needed for a new workspace or a current-format export. Stop the old daemon before converting its data.",
      ],
      [
        "Preserve the original",
        "The helper runs on the machine hosting the UI service and writes a new folder. It keeps the source files and produces a report. Register the converted folder separately after success.",
      ],
      [
        "Temporary migration stages",
        "A stage is an unpublished temporary folder left by a conversion. Cleanup requires its exact owner token, which proves it belongs to that job. Do not use this action for ordinary workspace folders.",
      ],
    ],
  },
  journals: {
    title: "Understanding saved actions and recovery",
    items: [
      [
        "Operations and journals",
        "An operation tracks a change through preparation, execution and its result. A journal is the saved request file that lets you inspect or retry that exact change later.",
      ],
      [
        "Inspecting is read-only",
        "Listing or reopening a saved action does not execute it. Hiding its results only closes the view—it does not cancel work, remove a file, or discard the saved action.",
      ],
      [
        "An uncertain outcome",
        "A lost connection can leave it unclear whether a change was saved. Keep the original request and check its receipt. Retry that same request only when appropriate; a new request could duplicate the work.",
      ],
    ],
  },
};

/** Optional, contextual explanations; ordinary actions remain visible without opening help. */
export function ManagementHelp({ section }: { readonly section: Section }) {
  const help = HELP[section];
  return (
    <details className="wg-management-help">
      <summary>
        <Icon name="resources" />
        <span>{help.title}</span>
      </summary>
      <dl>
        {help.items.map(([term, explanation]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{explanation}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
