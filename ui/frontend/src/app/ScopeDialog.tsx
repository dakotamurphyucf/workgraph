import { useState } from "react";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { Button, Field } from "../components/Primitives";
import type { HttpClient } from "../core/protocol/http";
import type { ConnectionProfile } from "../core/protocol/types";
import { failureText } from "../features/connections/failure";
import { changeScope, validIdentifier } from "./navigation";
import { useScopeChoices, type ScopeChoice } from "./scope-choices";
import type { Route } from "./types";
import "./scope-design.css";

function ChoiceList({
  kind,
  items,
  value,
  onSelect,
}: {
  readonly kind: "workspace" | "project";
  readonly items: readonly ScopeChoice[];
  readonly value: string;
  readonly onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = items.filter((item) =>
    `${item.title} ${item.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <>
      <Field
        label={`Search ${kind}s`}
        placeholder="Find by name or ID…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div
        className="sc-choices"
        aria-label={`${kind === "workspace" ? "Workspace" : "Project"} choices`}
      >
        {kind === "project" && (
          <button
            type="button"
            className="sc-choice"
            aria-pressed={value === ""}
            onClick={() => onSelect("")}
          >
            <Icon name="overview" />
            <span>
              <strong>All projects</strong>
              <small>See the whole workspace, including work outside a project.</small>
            </span>
            {value === "" && <Icon name="check" />}
          </button>
        )}
        {matches.map((item) => (
          <button
            key={item.id}
            type="button"
            className="sc-choice"
            aria-pressed={value === item.id}
            onClick={() => onSelect(item.id)}
          >
            <Icon name={kind === "workspace" ? "resources" : "workflow"} />
            <span>
              <strong>{item.title || item.id}</strong>
              <small>
                {item.id} · {item.detail}
              </small>
            </span>
            {value === item.id && <Icon name="check" />}
          </button>
        ))}
        {matches.length === 0 && (
          <p className="sc-empty">
            {items.length === 0
              ? `No ${kind}s were returned. You can enter a known ID below.`
              : "No matches. Try a different name or ID."}
          </p>
        )}
      </div>
    </>
  );
}

export function ScopeDialog({
  client,
  connection,
  route,
  onSelect,
  onClose,
}: {
  readonly client: HttpClient;
  readonly connection: ConnectionProfile | undefined;
  readonly route: Route;
  readonly onSelect: (route: Route) => void;
  readonly onClose: () => void;
}) {
  const [workspace, setWorkspace] = useState(route.workspaceId ?? "");
  const [project, setProject] = useState(route.projectId ?? "");
  const [submitted, setSubmitted] = useState(false);
  const workspaces = useScopeChoices(client, connection, null);
  const projects = useScopeChoices(client, connection, workspace, validIdentifier(workspace));
  const chooseWorkspace = (id: string) => {
    if (id !== workspace) {
      setWorkspace(id);
      setProject("");
    }
  };
  const workspaceError =
    workspace === ""
      ? undefined
      : !connection
        ? "Choose a daemon connection first."
        : !validIdentifier(workspace)
          ? "Use 1–96 letters, digits, underscores or hyphens."
          : undefined;
  const projectError =
    project !== "" && (!validIdentifier(project) || workspace === "")
      ? "Choose a workspace and use a valid project ID."
      : undefined;
  const workspaceTitle =
    workspaces.data?.items.find((item) => item.id === workspace)?.title || workspace;
  const projectTitle = projects.data?.items.find((item) => item.id === project)?.title || project;
  return (
    <Dialog title="Workspace & project scope" onClose={onClose} wide>
      <form
        className="sc-scope"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (!workspaceError && !projectError)
            onSelect(changeScope(route, workspace || null, project || null));
        }}
      >
        <div className="sc-intro">
          <span>
            <Icon name="workflow" />
          </span>
          <div>
            <h3>Choose the work you want to see</h3>
            <p>
              A workspace holds related work. A project groups a particular effort inside it. Your
              scope selects what the pages focus on; it does not move or edit any records.
            </p>
          </div>
        </div>
        <div className="sc-connection">
          <Icon name="connection" />
          <span>
            Connected through{" "}
            <strong>{connection?.label || connection?.id || "No daemon selected"}</strong>
          </span>
        </div>
        {!connection && (
          <p className="sc-notice" role="status">
            Close this menu and use Workgraph in the top-left corner to choose a daemon connection.
            Then return here to browse its workspaces.
          </p>
        )}
        <div className="sc-columns">
          <section className="sc-section" data-kind="workspace">
            <header>
              <span>
                <Icon name="resources" />
              </span>
              <div>
                <h3>1. Choose a workspace</h3>
                <p>Browse workspaces registered with this daemon.</p>
              </div>
            </header>
            <div className="sc-section-body">
              {connection && (
                <>
                  {workspaces.data && (
                    <ChoiceList
                      kind="workspace"
                      items={workspaces.data.items}
                      value={workspace}
                      onSelect={chooseWorkspace}
                    />
                  )}
                  {!workspaces.data && workspaces.state?.kind !== "failed" && (
                    <p className="sc-empty" role="status">
                      Loading workspace choices…
                    </p>
                  )}
                  {workspaces.state?.kind === "failed" && (
                    <p className="sc-notice" role="alert">
                      {failureText(workspaces.state.failure)} You can retry or enter a known ID.
                    </p>
                  )}
                  {workspaces.data?.partial && (
                    <p className="sc-notice">
                      This directory is incomplete. An unlisted workspace may still exist; enter its
                      ID if you know it.
                    </p>
                  )}
                  <Button tone="quiet" onClick={workspaces.refresh}>
                    Refresh workspaces
                  </Button>
                </>
              )}
              <details className="sc-manual">
                <summary>Enter a workspace ID</summary>
                <p>
                  Use an exact ID from a shared Workgraph link or your local setup. An ID selects an
                  existing workspace; it does not create or open a closed workspace on the daemon.
                </p>
                <Field
                  label="Workspace ID"
                  value={workspace}
                  onChange={(e) => chooseWorkspace(e.target.value)}
                  spellCheck={false}
                  maxLength={96}
                  autoComplete="off"
                  {...(submitted && workspaceError ? { error: workspaceError } : {})}
                />
              </details>
              {workspace !== "" && (
                <Button tone="quiet" onClick={() => chooseWorkspace("")}>
                  Clear workspace selection
                </Button>
              )}
            </div>
          </section>
          <section className="sc-section" data-kind="project">
            <header>
              <span>
                <Icon name="workflow" />
              </span>
              <div>
                <h3>2. Focus on a project</h3>
                <p>Optional. Keep All projects to see the whole workspace.</p>
              </div>
            </header>
            <div className="sc-section-body">
              {!validIdentifier(workspace) || !connection ? (
                <div className="sc-empty">
                  <Icon name="workflow" />
                  <h4>Choose a workspace first</h4>
                  <p>
                    Its projects will appear here. You can also keep the workspace view without
                    choosing a project.
                  </p>
                </div>
              ) : (
                <>
                  {projects.data && (
                    <ChoiceList
                      key={workspace}
                      kind="project"
                      items={projects.data.items}
                      value={project}
                      onSelect={setProject}
                    />
                  )}
                  {!projects.data && projects.state?.kind !== "failed" && (
                    <p className="sc-empty" role="status">
                      Loading projects…
                    </p>
                  )}
                  {projects.state?.kind === "failed" && (
                    <p className="sc-notice" role="alert">
                      {failureText(projects.state.failure)} Keep All projects, retry, or enter a
                      known ID.
                    </p>
                  )}
                  <Button tone="quiet" onClick={projects.refresh}>
                    Refresh projects
                  </Button>
                </>
              )}
              <details className="sc-manual">
                <summary>Enter a project ID</summary>
                <p>
                  Use a project ID in the selected workspace. Leave it empty for All projects.
                  Workspace-wide pages may still show records from across the workspace.
                </p>
                <Field
                  label="Project ID (optional)"
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                  disabled={!validIdentifier(workspace)}
                  spellCheck={false}
                  maxLength={96}
                  autoComplete="off"
                  {...(submitted && projectError ? { error: projectError } : {})}
                />
              </details>
              {project !== "" && (
                <Button tone="quiet" onClick={() => setProject("")}>
                  Use all projects
                </Button>
              )}
            </div>
          </section>
        </div>
        <footer className="sc-footer">
          <div className="sc-summary">
            <Icon name="check" />
            <div>
              <strong>{workspace === "" ? "No workspace selected" : workspaceTitle}</strong>
              <span>
                {workspace === ""
                  ? "Return to a view without a workspace focus."
                  : project === ""
                    ? "All projects · workspace-wide focus"
                    : projectTitle}
              </span>
              <small>
                Applies when you open this scope. Existing drafts keep their original workspace and
                identity.
              </small>
            </div>
          </div>
          {submitted && (workspaceError || projectError) && (
            <p role="alert" className="sc-notice">
              {workspaceError || projectError}
            </p>
          )}
          <div className="wg-form-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button tone="primary" type="submit">
              Open scope
            </Button>
          </div>
        </footer>
      </form>
    </Dialog>
  );
}
