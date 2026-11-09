import { createPortal } from "react-dom";
import { useState } from "react";
import { Button, Field } from "../components/Primitives";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import type { Route } from "./types";
import type { useScopeChoices } from "./scope-choices";
import { changeScope } from "./navigation";
import { failureText } from "../features/connections/failure";

type Directory = ReturnType<typeof useScopeChoices>;
export interface SidebarScopeProps {
  readonly route: Route;
  readonly workspaces: Directory;
  readonly projects: Directory;
  readonly pins: readonly string[];
  readonly onPins: (pins: readonly string[]) => void;
  readonly navigate: (route: Route) => void;
  readonly onManage: () => void;
}
export function SidebarScope({
  route,
  workspaces,
  projects,
  pins,
  onPins,
  navigate,
  onManage,
}: SidebarScopeProps) {
  const [open, setOpen] = useState<"workspace" | "project" | null>(null);
  const [query, setQuery] = useState("");
  const workspaceName =
    workspaces.data?.items.find((item) => item.id === route.workspaceId)?.title ||
    route.workspaceId ||
    "Choose workspace";
  const projectName =
    projects.data?.items.find((item) => item.id === route.projectId)?.title ||
    route.projectId ||
    "All projects";
  const directory = open === "workspace" ? workspaces : projects;
  const rows = directory.data?.items.filter((item) =>
    `${item.title} ${item.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const toggle = (kind: "workspace" | "project") => {
    setQuery("");
    if (open !== kind) (kind === "workspace" ? workspaces : projects).refresh();
    setOpen(open === kind ? null : kind);
  };
  return (
    <section className="qs-switcher" aria-label="Quick workspace and project switching">
      <button
        type="button"
        className="qs-current"
        title={workspaceName}
        aria-label={`Switch workspace: ${workspaceName}`}
        aria-expanded={open === "workspace"}
        onClick={() => toggle("workspace")}
      >
        <Icon name="resources" />
        <span>
          <small>Workspace</small>
          <strong>{workspaceName}</strong>
        </span>
        <Icon name="chevron" />
      </button>
      <button
        type="button"
        className="qs-current qs-current--project"
        title={projectName}
        aria-label={`Switch project: ${projectName}`}
        aria-expanded={open === "project"}
        disabled={route.workspaceId === null}
        onClick={() => toggle("project")}
      >
        <Icon name="workflow" />
        <span>
          <small>Project focus</small>
          <strong>{projectName}</strong>
        </span>
        <Icon name="chevron" />
      </button>
      {open &&
        createPortal(
          <Dialog
            title={open === "workspace" ? "Switch workspace" : "Switch project"}
            description={
              open === "workspace"
                ? "Choose a registered workspace. Each workspace keeps its own project pins and acting identity."
                : "Focus this page on one project, or choose All projects. Use the bookmark beside a project to pin it in the sidebar."
            }
            onClose={() => setOpen(null)}
          >
            <div className="qs-picker">
              <Field
                label={`Find ${open}s`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name or ID…"
              />
              <div className="qs-options">
                {open === "project" && (
                  <Button
                    aria-pressed={route.projectId === null}
                    onClick={() => {
                      setOpen(null);
                      navigate(changeScope(route, route.workspaceId, null));
                    }}
                  >
                    All projects
                  </Button>
                )}
                {rows?.map((row) => (
                  <div key={row.id} className="qs-option">
                    <button
                      type="button"
                      aria-pressed={
                        (open === "workspace" ? route.workspaceId : route.projectId) === row.id
                      }
                      onClick={() => {
                        setOpen(null);
                        navigate(
                          open === "workspace"
                            ? changeScope(route, row.id, null)
                            : changeScope(route, route.workspaceId, row.id),
                        );
                      }}
                    >
                      <strong>
                        <Icon name={open === "workspace" ? "resources" : "workflow"} />
                        {row.title || row.id}
                      </strong>
                      <small>
                        {row.id} · {row.detail}
                      </small>
                    </button>
                    {open === "project" && (
                      <button
                        type="button"
                        className="qs-pin"
                        aria-label={`${pins.includes(row.id) ? "Unpin" : "Pin"} project ${row.title || row.id}`}
                        aria-pressed={pins.includes(row.id)}
                        onClick={() =>
                          onPins(
                            pins.includes(row.id)
                              ? pins.filter((id) => id !== row.id)
                              : [...pins, row.id],
                          )
                        }
                      >
                        <Icon name="saved" />
                      </button>
                    )}
                  </div>
                ))}
                {rows?.length === 0 && <p>No matching {open}s.</p>}
                {!directory.data && directory.state?.kind !== "failed" && (
                  <p>
                    {route.connectionId === null
                      ? "Choose a daemon first using Workgraph above."
                      : "Loading choices…"}
                  </p>
                )}
                {directory.state?.kind === "failed" && (
                  <p role="status">{failureText(directory.state.failure)}</p>
                )}
                {directory.data?.partial && (
                  <p>Some choices may be missing. Open scope settings to enter an ID.</p>
                )}
              </div>
              <div className="qs-picker-footer">
                <Button tone="quiet" onClick={directory.refresh}>
                  Refresh
                </Button>
                <Button
                  tone="quiet"
                  onClick={() => {
                    setOpen(null);
                    onManage();
                  }}
                >
                  Scope settings
                </Button>
              </div>
            </div>
          </Dialog>,
          document.body,
        )}
      <button type="button" className="wg-scope-navigation qs-manage" onClick={onManage}>
        Workspace & project settings
      </button>
    </section>
  );
}
export function PinnedProjects({ route, projects, pins, onPins, navigate }: SidebarScopeProps) {
  if (!route.workspaceId) return null;
  return (
    <section className="qs-pins" aria-label="Pinned projects">
      <div className="wg-section-label">PINNED PROJECTS</div>
      <button
        type="button"
        aria-current={route.projectId === null ? "page" : undefined}
        onClick={() => navigate(changeScope(route, route.workspaceId, null))}
      >
        <Icon name="overview" />
        <span>All projects</span>
      </button>
      {pins.map((id) => {
        const title = projects.data?.items.find((item) => item.id === id)?.title || id;
        return (
          <div className="qs-pin-row" key={id}>
            <button
              type="button"
              title={title}
              aria-current={route.projectId === id ? "page" : undefined}
              onClick={() => navigate(changeScope(route, route.workspaceId, id))}
            >
              <Icon name="workflow" />
              <span>{title}</span>
            </button>
            <button
              type="button"
              className="qs-unpin"
              aria-label={`Unpin ${title}`}
              onClick={() => onPins(pins.filter((value) => value !== id))}
            >
              <Icon name="close" />
            </button>
          </div>
        );
      })}
      {pins.length === 0 && (
        <p>Pin projects from the project switcher above for one-click access.</p>
      )}
    </section>
  );
}
