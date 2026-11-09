import { useActorGate } from "../../components/ActorAccess";
import { LifecycleActionExplanation } from "./ActionExplanation";
import { ManagementHelp } from "./ManagementHelp";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { FeatureContext } from "../../app/types";
import {
  Badge,
  Button,
  Field,
  Panel,
  Select,
  StatePanel,
  Toolbar,
} from "../../components/Primitives";
import { CapturedValues } from "./CapturedValues";
import { useManagementPresentation } from "./management-presentation";
import { jsonField } from "../../core/json";
import { createCompanion } from "../../core/protocol/client";
import * as d from "../../core/protocol/decoders";
import * as c from "../../core/protocol/codec";
import type { Identifier, JsonObject, ReadResponse } from "../../core/protocol/types";
import { createReadSlot, readKey } from "../../core/state/read-slot";
import {
  entityPage,
  freezeAction,
  newIdentity,
  DraftInputError,
  ProjectionError,
  readScope,
} from "./model";
import { useDaemonRead } from "./reads";
import { JsonView, LazyDetails, OperationPanel } from "./shared";
import { failureText } from "./failure";
import type { EntityPage, EntityRow, LifecycleAction, LifecycleFeatureProps } from "./types";
import "./connections.css";

import type {
  LifecycleKind as Kind,
  EditorField as FieldName,
  EditorFields as Fields,
  LifecycleEditor as Editor,
} from "./store";
const EMPTY: Fields = {
  id: "",
  name: "",
  root: "",
  title: "",
  summary: "",
  description: "",
  instructions: "",
  acceptance: "",
  priority: "2",
  status: "todo",
  project: "",
  date: "",
  revision: "",
  evidence: "",
  nextSteps: "",
};
const LABELS: Readonly<Record<Kind, string>> = {
  workspace_create: "Create workspace",
  workspace_register: "Register existing workspace",
  workspace_open: "Open workspace",
  workspace_close: "Close workspace",
  workspace_unregister: "Unregister workspace",
  workspace_edit: "Edit workspace",
  workspace_archive: "Archive or restore workspace",
  project_create: "Create project",
  project_edit: "Edit project",
  project_archive: "Archive or restore project",
  project_finish: "Finish project with evidence",
  milestone_create: "Create milestone",
  milestone_edit: "Edit milestone",
  milestone_archive: "Archive or restore milestone",
  milestone_schedule: "Schedule milestone",
};
function capture(context: FeatureContext): FeatureContext {
  return {
    ...context,
    connection: { ...context.connection },
    route: { ...context.route },
    writer: { ...context.writer },
  };
}
function action(editor: Editor): LifecycleAction {
  const f = editor.fields;
  switch (editor.kind) {
    case "workspace_create":
      return { kind: editor.kind, id: f.id, name: f.name, root: f.root };
    case "workspace_register":
      return { kind: editor.kind, root: f.root };
    case "workspace_open":
    case "workspace_close":
    case "workspace_unregister":
      return { kind: editor.kind, id: f.id };
    case "workspace_edit":
      return {
        kind: editor.kind,
        id: f.id,
        revision: f.revision,
        name: f.name,
        summary: f.summary,
        description: f.description,
        instructions: f.instructions,
      };
    case "workspace_archive":
    case "project_archive":
    case "milestone_archive":
      return { kind: editor.kind, id: f.id, revision: f.revision, archived: editor.archived };
    case "project_create":
      return { kind: editor.kind, id: f.id, title: f.title, description: f.description };
    case "project_edit":
      return {
        kind: editor.kind,
        id: f.id,
        revision: f.revision,
        title: f.title,
        summary: f.summary,
        description: f.description,
        acceptance: f.acceptance,
        priority: f.priority,
        status: f.status,
      };
    case "project_finish":
      return {
        kind: editor.kind,
        id: f.id,
        revision: f.revision,
        evidence: f.evidence,
        summary: f.summary,
        nextSteps: f.nextSteps,
      };
    case "milestone_create":
      return {
        kind: editor.kind,
        id: f.id,
        project: f.project,
        title: f.title,
        description: f.description,
        date: f.date,
      };
    case "milestone_edit":
      return {
        kind: editor.kind,
        id: f.id,
        revision: f.revision,
        title: f.title,
        description: f.description,
        status: f.status,
      };
    case "milestone_schedule":
      return { kind: editor.kind, id: f.id, revision: f.revision, date: f.date };
  }
}
function fieldText(raw: JsonObject, name: string): string {
  const value = jsonField(raw, name);
  if (value?.kind === "null") return "";
  const result = c.text.decode(value);
  if (!result.ok)
    throw new ProjectionError(
      `Entity ${name} is missing or invalid; refresh the complete record before editing.`,
    );
  return result.value;
}
function page(
  kind: "workspace" | "project" | "milestone",
  response: ReadResponse | undefined,
): { readonly value: EntityPage | null; readonly error: string | null } {
  if (response === undefined) return { value: null, error: null };
  try {
    return { value: entityPage(kind, response), error: null };
  } catch (error: unknown) {
    if (error instanceof ProjectionError) return { value: null, error: error.message };
    throw error;
  }
}
function EntityTable({
  kind,
  data,
  onAction,
  onSelect,
}: {
  readonly kind: "workspace" | "project" | "milestone";
  readonly data: EntityPage;
  readonly onAction: (kind: Kind, row: EntityRow) => void;
  readonly onSelect: (row: EntityRow) => void;
}) {
  return (
    <>
      {data.rows.length === 0 && <p className="wg-hint">No {kind}s in this observed page.</p>}
      {data.rows.length > 0 && (
        <div className="wg-lifecycle-table-scroll">
          <table className="wg-lifecycle-table">
            <caption>
              {kind === "workspace"
                ? "Registered workspaces on this daemon"
                : `${kind === "project" ? "Projects" : "Milestones"} in the selected workspace`}
            </caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">State</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    <Button onClick={() => onSelect(row)}>{row.title}</Button>
                    <div>
                      <code>{row.id}</code>
                    </div>
                    {row.root !== null && <div className="wg-hint">{row.root}</div>}
                  </th>
                  <td data-status={row.open === null ? row.status : row.open ? "open" : "closed"}>
                    <Badge>
                      {row.open === null
                        ? (row.status?.replaceAll("_", " ") ?? "observed")
                        : row.open
                          ? "open"
                          : "closed"}
                    </Badge>
                    {row.archived === true && <Badge tone="warning">archived</Badge>}
                    {row.revision !== null && (
                      <div className="wg-hint">revision {row.revision}</div>
                    )}
                    {row.date !== null && <div>Target {row.date}</div>}
                  </td>
                  <td>
                    <Toolbar label={`${row.title} lifecycle actions`}>
                      {kind === "workspace" ? (
                        <>
                          <Button
                            onClick={() =>
                              onAction(row.open ? "workspace_close" : "workspace_open", row)
                            }
                          >
                            {row.open ? "Close" : "Open"}
                          </Button>
                          <Button
                            disabled={!row.open}
                            onClick={() => onAction("workspace_edit", row)}
                          >
                            Edit
                          </Button>
                          <Button
                            disabled={!row.open}
                            onClick={() => onAction("workspace_archive", row)}
                          >
                            {row.archived ? "Restore" : "Archive"}
                          </Button>
                          <Button
                            disabled={row.open !== false}
                            title="Close this workspace before removing its local registry association. Portable files are retained."
                            onClick={() => onAction("workspace_unregister", row)}
                          >
                            Unregister
                          </Button>
                        </>
                      ) : kind === "project" ? (
                        <>
                          <Button onClick={() => onAction("project_edit", row)}>Edit</Button>
                          <Button onClick={() => onAction("project_archive", row)}>
                            {row.archived ? "Restore" : "Archive"}
                          </Button>
                          <Button onClick={() => onAction("project_finish", row)}>
                            Readiness & finish
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button onClick={() => onAction("milestone_edit", row)}>
                            Edit / status
                          </Button>
                          <Button onClick={() => onAction("milestone_schedule", row)}>
                            Schedule
                          </Button>
                          <Button onClick={() => onAction("milestone_archive", row)}>
                            {row.archived ? "Restore" : "Archive"}
                          </Button>
                        </>
                      )}
                    </Toolbar>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.partial && (
        <p role="alert" className="wg-error">
          This page contains omissions. Open a complete record before editing; omitted text is never
          used to prefill a patch.
        </p>
      )}
    </>
  );
}
export function ConnectionLifecycleFeature({
  context,
  operations,
  store,
  section,
}: LifecycleFeatureProps) {
  const draftIssue = useSyncExternalStore(store.editor.subscribe, store.editor.issue);
  const retainedEditor = useSyncExternalStore(store.editor.subscribe, store.editor.get);
  const management = useManagementPresentation();
  const editor =
    section === undefined || retainedEditor?.kind.startsWith(`${section}_`) ? retainedEditor : null;
  const otherDraft = retainedEditor !== null && editor === null;
  const canStart = () => {
    if (otherDraft) {
      setNotice(
        `Your ${LABELS[retainedEditor.kind].toLowerCase()} draft is saved in the ${retainedEditor.kind.split("_")[0]} section. Finish or close that draft before starting another.`,
      );
      return false;
    }
    return true;
  };
  const setEditor = store.editor.set;
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<Identifier | null>(null);
  const [unexpected, setUnexpected] = useState<{ readonly error: unknown } | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [showReadiness, setShowReadiness] = useState(true);
  const [detail] = useState(() => createReadSlot<ReadResponse>());
  const companion = useMemo(() => createCompanion(context.client), [context.client]);
  const scopeIdentity = JSON.stringify([
    context.connection.id,
    context.connection.generation,
    context.route.workspaceId,
    context.route.projectId,
    context.writer.actorId,
    context.writer.runId,
  ]);
  useEffect(
    () => () => {
      detail.clear();
    },
    [detail, scopeIdentity],
  );
  const base = useMemo(
    () =>
      context.route.workspaceId === null
        ? d.jsonObject([])
        : d.jsonObject([
            ["workspace_id", d.jsonString(context.route.workspaceId)],
            ["limit", d.jsonString("100")],
            ["offset", d.jsonString("0")],
            ["include_archived", { kind: "boolean", value: includeArchived }],
          ]),
    [context.route.workspaceId, includeArchived],
  );
  const workspaceRead = useDaemonRead(
    context,
    "workspace.list",
    d.jsonObject([]),
    section === undefined || section === "workspace",
  );
  const projectRead = useDaemonRead(
    context,
    "project.list",
    base,
    context.route.workspaceId !== null && (section === undefined || section === "project"),
  );
  const milestoneRead = useDaemonRead(
    context,
    "milestone.list",
    base,
    context.route.workspaceId !== null && (section === undefined || section === "milestone"),
  );
  const readinessParams = useMemo(
    () =>
      editor?.kind === "project_finish"
        ? d.jsonObject([
            ["workspace_id", d.jsonString(editor.context.route.workspaceId ?? "")],
            ["project_id", d.jsonString(editor.fields.id)],
            ["limit", d.jsonString("100")],
            ["offset", d.jsonString("0")],
          ])
        : d.jsonObject([]),
    [editor],
  );
  const readiness = useDaemonRead(
    editor?.context ?? context,
    "project.readiness",
    readinessParams,
    editor?.kind === "project_finish",
  );
  const workspacePage = page("workspace", workspaceRead.value),
    projectPage = page("project", projectRead.value),
    milestonePage = page("milestone", milestoneRead.value);
  const allowNewAction = useActorGate();
  const create = (kind: Kind) => {
    if (!allowNewAction()) return;
    if (!canStart()) return;
    setSelected(null);
    if (store.editor.get()?.registration === "pending") {
      setNotice("Wait for the captured registration to settle before starting another draft.");
      return;
    }
    detail.clear();
    setEditor({
      context: capture(context),
      kind,
      fields: { ...EMPTY, project: context.route.projectId ?? "" },
      archived: true,
      review: null,
      registration: "idle",
    });
    setNotice("");
  };
  const begin = async (kind: Kind, row: EntityRow) => {
    if (!allowNewAction()) return;
    if (!canStart()) return;
    if (store.editor.get()?.registration === "pending") {
      setNotice("Wait for the captured registration to settle before editing another entity.");
      return;
    }
    setSelected(null);
    const selection = store.editor.captureSelection();
    const captured = capture(context);
    const entity = kind.startsWith("workspace_")
      ? "workspace"
      : kind.startsWith("project_")
        ? "project"
        : "milestone";
    if (
      kind === "workspace_open" ||
      kind === "workspace_close" ||
      kind === "workspace_unregister"
    ) {
      detail.clear();
      setEditor({
        context: captured,
        kind,
        fields: { ...EMPTY, id: row.id },
        archived: true,
        review: null,
        registration: "idle",
      });
      return;
    }
    const workspace = entity === "workspace" ? row.id : captured.route.workspaceId;
    if (workspace === null) {
      setNotice("Select a workspace before editing.");
      return;
    }
    const params = d.jsonObject([
      ["workspace_id", d.jsonString(workspace)],
      ...(entity === "workspace" ? [] : [[`${entity}_id`, d.jsonString(row.id)] as const]),
      ["max_bytes", d.jsonString("1048576")],
    ]);
    const key = readKey(readScope(captured), `${entity}.get`, params);
    setNotice("Reading the complete guarded record…");
    const result = await detail.load(key, (signal) =>
      companion.read(
        {
          connection_id: captured.connection.id,
          generation: captured.connection.generation,
          method: `${entity}.get`,
          params,
          lane: "visible",
        },
        signal,
      ),
    );
    if (!result.ok) {
      if (!("superseded" in result)) setNotice(failureText(result.failure));
      return;
    }
    if (!selection.isCurrent()) return;
    const budget = jsonField(result.data.response.meta, "budget");
    const truncated = budget?.kind === "object" ? jsonField(budget, "truncated") : undefined;
    if (truncated?.kind === "boolean" && truncated.value) {
      setNotice(
        "Record is partial; use a larger bounded inspection before editing. No patch was created.",
      );
      return;
    }
    const raw = result.data.response.data;
    if (raw.kind !== "object") {
      setNotice(
        "The item could not be read completely. Refresh and try again; no draft was created.",
      );
      return;
    }
    try {
      const settings = jsonField(raw, "settings");
      const milestone = jsonField(raw, "milestone");
      const record =
        entity === "workspace"
          ? settings?.kind === "object"
            ? settings
            : null
          : entity === "milestone"
            ? milestone?.kind === "object"
              ? milestone
              : null
            : raw;
      if (record === null)
        throw new ProjectionError(
          "The complete entity record is absent; no guarded patch was created.",
        );
      const actualId = entity === "workspace" ? row.id : fieldText(record, `${entity}_id`);
      if (actualId !== row.id)
        throw new ProjectionError(
          "The observed entity differs from the selected target; no draft was created.",
        );
      const fields = {
        ...EMPTY,
        id: actualId,
        revision: fieldText(record, "revision"),
      };
      if (entity === "workspace") {
        fields.name = fieldText(raw, "name");
        fields.summary = fieldText(record, "summary");
        fields.description = fieldText(record, "description");
        fields.instructions = fieldText(record, "instructions");
      } else {
        fields.title = fieldText(record, "title");
        fields.description = fieldText(record, "description");
        fields.status = fieldText(record, "status");
        if (entity === "project") {
          fields.summary = fieldText(record, "summary");
          fields.acceptance = fieldText(record, "acceptance_criteria");
          fields.priority = fieldText(record, "priority");
        } else {
          fields.date = fieldText(record, "target_date");
          fields.project = fieldText(record, "project_id");
        }
      }
      const archived = jsonField(record, "archived");
      if (archived?.kind !== "boolean")
        throw new ProjectionError("Missing complete archived state; no patch created.");
      setEditor({
        context: captured,
        kind,
        fields,
        archived: !archived.value,
        review: null,
        registration: "idle",
      });
      setNotice("");
    } catch (error: unknown) {
      if (error instanceof ProjectionError) setNotice(error.message);
      else throw error;
    }
  };
  const beginSafely = (kind: Kind, row: EntityRow) => {
    void begin(kind, row).catch((error: unknown) => {
      setUnexpected({ error });
    });
  };
  const field = (name: FieldName, label: string, hint?: string, type = "text") => (
    <Field
      key={name}
      label={label}
      readOnly={!editor?.kind.endsWith("_create") && (name === "id" || name === "revision")}
      value={editor?.fields[name] ?? ""}
      disabled={editor?.review !== null}
      onChange={(event) => {
        const value = event.target.value;
        setEditor((previous) =>
          previous === null ? null : { ...previous, fields: { ...previous.fields, [name]: value } },
        );
      }}
      {...(hint === undefined ? {} : { hint })}
      type={type}
      autoComplete="off"
      spellCheck={false}
      maxLength={65536}
    />
  );
  const rich = (name: FieldName, label: string) => (
    <label key={name} className={`wg-field wg-lifecycle-rich wg-lifecycle-rich--${name}`}>
      {label}
      <textarea
        value={editor?.fields[name] ?? ""}
        rows={4}
        maxLength={65536}
        disabled={editor?.review !== null}
        onChange={(event) => {
          const value = event.target.value;
          setEditor((previous) =>
            previous === null
              ? null
              : { ...previous, fields: { ...previous.fields, [name]: value } },
          );
        }}
      />
    </label>
  );
  const renderFields = () => {
    if (editor === null) return null;
    const f = editor.kind;
    const guarded =
      f.endsWith("_edit") ||
      f.endsWith("_archive") ||
      f === "milestone_schedule" ||
      f === "project_finish";
    return (
      <>
        {f !== "workspace_register" &&
          !(management && guarded) &&
          field(
            "id",
            f.endsWith("_create") ? "ID (optional)" : "Identifier",
            f.endsWith("_create")
              ? "Leave blank and Workgraph will create a unique ID."
              : "The item this change will apply to.",
          )}
        {guarded &&
          !management &&
          field(
            "revision",
            "Version being edited",
            "Checked when saving, so someone else’s changes cannot be overwritten. Reload the item if its version has changed.",
          )}
        {(f === "workspace_create" || f === "workspace_register") &&
          field(
            "root",
            "Workspace folder",
            "Full path on the machine running Workgraph. Create uses a new folder; register connects an existing workspace.",
          )}
        {(f === "workspace_create" || f === "workspace_edit") && field("name", "Workspace name")}
        {(f === "project_create" ||
          f === "project_edit" ||
          f === "milestone_create" ||
          f === "milestone_edit") &&
          field("title", "Title")}
        {f === "milestone_create" && field("project", "Owning project ID")}
        {(f === "milestone_create" || f === "milestone_schedule") &&
          field(
            "date",
            "Target date",
            f === "milestone_schedule"
              ? "Leave empty to explicitly clear the schedule."
              : "Optional calendar date.",
            "date",
          )}
        {(f === "project_edit" || f === "milestone_edit") && (
          <Select
            label="Status"
            value={editor.fields.status}
            disabled={editor.review !== null}
            onChange={(event) => {
              const status = event.target.value;
              setEditor((previous) =>
                previous === null ? null : { ...previous, fields: { ...previous.fields, status } },
              );
            }}
          >
            {["backlog", "todo", "in_progress", "done", "canceled"].map((status) => (
              <option key={status} value={status}>
                {status.replaceAll("_", " ")}
              </option>
            ))}
          </Select>
        )}
        {f === "milestone_edit" && (
          <p className="wg-hint">
            Marking a milestone done updates its status. It does not finish the project or run the
            project’s completion checks.
          </p>
        )}
        {f === "project_edit" && (
          <>
            <p className="wg-hint">
              To complete this project with its required checks, use “Readiness & finish”. Changing
              this status alone does not run those checks.
            </p>
            <Select
              label="Priority"
              value={editor.fields.priority}
              disabled={editor.review !== null}
              onChange={(event) => {
                const priority = event.target.value;
                setEditor((previous) =>
                  previous === null
                    ? null
                    : { ...previous, fields: { ...previous.fields, priority } },
                );
              }}
            >
              <option value="0">Unspecified</option>
              <option value="1">Urgent</option>
              <option value="2">High</option>
              <option value="3">Normal</option>
              <option value="4">Low</option>
            </Select>
            {rich("acceptance", "Acceptance criteria")}
          </>
        )}
        {(f === "workspace_edit" || f === "project_edit" || f === "project_finish") &&
          rich("summary", f === "project_finish" ? "Completion handoff summary" : "Summary")}
        {(f === "workspace_edit" ||
          f === "project_edit" ||
          f === "project_create" ||
          f === "milestone_edit" ||
          f === "milestone_create") &&
          rich("description", "Description")}
        {f === "workspace_edit" && rich("instructions", "Workspace instructions")}
        {f.endsWith("_archive") && (
          <Select
            label="Archive state"
            value={editor.archived ? "archive" : "restore"}
            disabled={editor.review !== null}
            onChange={(event) => {
              const archived = event.target.value === "archive";
              setEditor((previous) => (previous === null ? null : { ...previous, archived }));
            }}
          >
            <option value="archive">Archive</option>
            <option value="restore">Restore from archive</option>
          </Select>
        )}
        {f === "project_finish" && (
          <>
            {rich("evidence", "Completion evidence")}
            {rich("nextSteps", "Handoff next steps")}
            <p className="wg-hint">
              The daemon evaluates actual project completion gates. This action retains the expected
              revision and does not finish open tickets implicitly.
            </p>
          </>
        )}
        {f === "workspace_unregister" && (
          <p role="alert">
            Unregister removes this registry entry; it does not delete workspace bytes. Check that
            the workspace is closed and no background work blocks removal.
          </p>
        )}
        {f === "workspace_close" && (
          <p className="wg-hint">
            Closing unloads the workspace. It does not archive or delete it.
          </p>
        )}
      </>
    );
  };
  const activeIntention = selected ?? editor?.review?.preparation.intention_id ?? null;
  const retainedFailure = useSyncExternalStore(
    store.manager.subscribe,
    () => store.manager.get().unexpected,
  );
  if (unexpected !== null) throw unexpected.error;
  if (retainedFailure !== null) throw retainedFailure.error;
  return (
    <div className="wg-lifecycle">
      {draftIssue !== null && (
        <p role="alert" className="wg-error">
          {draftIssue}
        </p>
      )}
      {section !== undefined && (
        <div className="wg-management-intro">
          <h2>
            {section === "project"
              ? "Projects"
              : section === "milestone"
                ? "Milestones"
                : "Workspaces"}
          </h2>
          <p>
            {section === "project"
              ? "Group related tickets around a goal. Define what success looks like, track progress, and finish with evidence when the work is ready."
              : section === "milestone"
                ? "Break a project into meaningful stages. Give each milestone a target date and update its status as the work progresses."
                : "A workspace keeps projects, tickets, discussions and resources together in a local folder. Create one here or connect a workspace that already exists."}
          </p>
          <ManagementHelp section={section} />
        </div>
      )}
      {section === undefined && (
        <header className="wg-lifecycle-heading">
          <div>
            <h2>Workspace & planning lifecycle</h2>
            <p className="wg-hint">
              Registry paths and daemon processes belong to the companion host. Planning actions use
              explicit captured attribution and revision guards.
            </p>
          </div>
          <Badge>
            {context.connection.label} · generation {context.connection.generation}
          </Badge>
        </header>
      )}
      {notice !== "" && (
        <p role="status" className="wg-hint">
          {notice}
        </p>
      )}
      {(section === undefined || section === "workspace") && (
        <Panel
          title="Workspaces"
          actions={
            <Toolbar label="Workspace creation">
              <Button tone="primary" onClick={() => create("workspace_create")}>
                Create workspace
              </Button>
              <Button onClick={() => create("workspace_register")}>Register existing</Button>
              <Button onClick={workspaceRead.refresh}>Refresh registry</Button>
            </Toolbar>
          }
        >
          {workspaceRead.state.kind === "loading" && !workspaceRead.value && (
            <p role="status">Loading registry…</p>
          )}
          {workspaceRead.state.kind === "failed" && (
            <p role="alert" className="wg-error">
              {failureText(workspaceRead.state.failure)} Endpoint unreachable does not prove the
              daemon stopped.
            </p>
          )}
          {workspacePage.error && <p role="alert">{workspacePage.error}</p>}
          {workspacePage.value && (
            <EntityTable
              kind="workspace"
              data={workspacePage.value}
              onAction={beginSafely}
              onSelect={(row) =>
                context.navigate({
                  ...context.route,
                  workspaceId: row.id,
                  projectId: null,
                  entityId: null,
                })
              }
            />
          )}{" "}
          {!management && workspaceRead.value && (
            <LazyDetails summary="Raw registry observation">
              <JsonView
                processing={context.client.processing}
                value={workspaceRead.value.response.data}
                label="Registry response"
                identity={`${scopeIdentity}-registry`}
              />
            </LazyDetails>
          )}
        </Panel>
      )}
      {section !== "workspace" &&
        (context.route.workspaceId === null ? (
          <StatePanel kind="empty" title="Select a workspace">
            Choose a registered workspace to manage projects and milestones. Closed workspaces can
            be opened using their registry action.
          </StatePanel>
        ) : (
          <>
            <label className="wg-lifecycle-checkbox">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => setIncludeArchived(event.target.checked)}
              />{" "}
              Include archived projects and milestones
            </label>
            {(
              [
                ["project", projectRead, projectPage],
                ["milestone", milestoneRead, milestonePage],
              ] as const
            )
              .filter(([kind]) => section === undefined || section === kind)
              .map(([kind, read, projected]) => (
                <Panel
                  key={kind}
                  title={kind === "project" ? "Projects" : "Milestones"}
                  actions={
                    <Toolbar label={`${kind} actions`}>
                      <Button
                        tone="primary"
                        onClick={() =>
                          create(kind === "project" ? "project_create" : "milestone_create")
                        }
                      >
                        Create {kind}
                      </Button>
                      <Button onClick={read.refresh}>Refresh</Button>
                      <Button
                        disabled={!read.hasNext || read.state.kind === "loading"}
                        onClick={read.next}
                      >
                        Next page
                      </Button>
                    </Toolbar>
                  }
                >
                  {read.state.kind === "loading" && !read.value && (
                    <p role="status">Loading {kind}s…</p>
                  )}
                  {read.state.kind === "failed" && (
                    <p role="alert" className="wg-error">
                      {failureText(read.state.failure)} Refresh starts a new traversal; the previous
                      captured page is retained.
                    </p>
                  )}
                  {projected.error && <p role="alert">{projected.error}</p>}
                  {projected.value && (
                    <EntityTable
                      kind={kind}
                      data={projected.value}
                      onAction={beginSafely}
                      onSelect={(row) =>
                        context.navigate({
                          ...context.route,
                          ...(kind === "project"
                            ? { projectId: row.id, entityId: null }
                            : { entityId: row.id }),
                        })
                      }
                    />
                  )}
                  {!management && read.value && (
                    <LazyDetails summary="Raw page and continuation">
                      <JsonView
                        processing={context.client.processing}
                        value={read.value.response.data}
                        label={`${kind} page`}
                        identity={`${scopeIdentity}-${kind}`}
                        partial={projected.value?.partial ?? false}
                      />
                      {read.value.pagination && (
                        <JsonView
                          processing={context.client.processing}
                          value={read.value.pagination}
                          label="Exact continuation"
                          identity={`${scopeIdentity}-${kind}-continuation`}
                        />
                      )}
                    </LazyDetails>
                  )}
                </Panel>
              ))}
            {(section === undefined || section === "milestone") && (
              <p className="wg-hint">
                Milestones can have target dates to help schedule your work.
              </p>
            )}
          </>
        ))}
      {editor && (
        <Panel
          title={LABELS[editor.kind]}
          className="wg-management-editor"
          actions={
            <>
              {editor.review !== null && (
                <Button
                  disabled={editor.registration === "pending"}
                  onClick={() => {
                    detail.clear();
                    setSelected(null);
                    setEditor((previous) =>
                      previous === null
                        ? null
                        : { ...previous, review: null, registration: "idle" },
                    );
                  }}
                >
                  Edit copy as new draft
                </Button>
              )}
              <Button
                disabled={editor.registration === "pending"}
                onClick={() => {
                  detail.clear();
                  setEditor(null);
                }}
              >
                Close draft
              </Button>
            </>
          }
        >
          <LifecycleActionExplanation editor={editor} />
          <div className="wg-editor-context">
            <p className="wg-hint">
              Draft captured actor{" "}
              <strong>
                {editor.context.writer.actorId ??
                  "none — choose an actor before creating a new draft"}
              </strong>
              {" · "}Workspace{" "}
              <strong>{editor.context.route.workspaceId ?? "new workspace"}</strong>
              {" · "}
              {editor.context.connection.label}
              {editor.context.writer.runId !== null && <> · Run {editor.context.writer.runId}</>}
            </p>
            <p className="wg-hint">
              This draft keeps its original actor and destination when you switch sections.
            </p>
          </div>
          {!management && (
            <LazyDetails summary="Exact original draft endpoint">
              <p>{editor.context.connection.socket}</p>
            </LazyDetails>
          )}
          {management && editor.fields.revision !== "" && (
            <p className="wg-editor-version">
              <strong>{editor.fields.id}</strong> · Version {editor.fields.revision}
              <span>Changes are checked against this version before saving.</span>
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              detail.clear();
              const captured = store.editor.get();
              if (
                captured === null ||
                captured.registration === "pending" ||
                captured.registration === "registered"
              )
                return;
              let frozen;
              try {
                frozen =
                  captured.review ??
                  freezeAction(captured.context, action(captured), newIdentity());
              } catch (error: unknown) {
                if (error instanceof DraftInputError) setNotice(error.message);
                else setUnexpected({ error });
                return;
              }
              store.editor.set({ ...captured, review: frozen, registration: "pending" });
              void Promise.resolve()
                .then(() => operations.register(frozen.preparation))
                .then(async (result) => {
                  if (!result.ok) {
                    store.editor.set((previous) =>
                      previous?.review?.preparation.intention_id === frozen.preparation.intention_id
                        ? { ...previous, registration: "idle" }
                        : previous,
                    );
                    setNotice(failureText(result.failure));
                    return;
                  }
                  setSelected(frozen.preparation.intention_id);
                  const prepared = await operations.act(frozen.preparation.intention_id, "prepare");
                  store.editor.set((previous) =>
                    previous?.review?.preparation.intention_id === frozen.preparation.intention_id
                      ? { ...previous, registration: "registered" }
                      : previous,
                  );
                  setNotice(
                    prepared.ok
                      ? "Prepared for review. Inspect the captured target, writer and guards below, then explicitly execute."
                      : failureText(prepared.failure),
                  );
                })
                .catch((error: unknown) => {
                  store.editor.set((previous) =>
                    previous?.review?.preparation.intention_id === frozen.preparation.intention_id
                      ? { ...previous, registration: "idle" }
                      : previous,
                  );
                  store.manager.set((previous) => ({ ...previous, unexpected: { error } }));
                });
            }}
          >
            <div className="wg-lifecycle-fields">{renderFields()}</div>
            <Button type="submit" tone="primary" disabled={editor.registration !== "idle"}>
              {editor.registration === "pending"
                ? "Preparing review…"
                : editor.registration === "registered"
                  ? "Ready for review"
                  : "Review changes"}
            </Button>
          </form>
        </Panel>
      )}
      {editor?.kind === "project_finish" && !showReadiness && (
        <Button onClick={() => setShowReadiness(true)}>Show completion checks</Button>
      )}
      {editor?.kind === "project_finish" && showReadiness && (
        <Panel
          title="Observed project readiness"
          actions={
            <>
              <Button onClick={() => setShowReadiness(false)}>Hide completion checks</Button>
              <Button onClick={readiness.refresh}>Refresh readiness</Button>
              <Button disabled={!readiness.hasNext} onClick={readiness.next}>
                Next captured readiness page
              </Button>
            </>
          }
        >
          {readiness.state.kind === "loading" && <p role="status">Reading completion gates…</p>}
          {readiness.state.kind === "failed" && (
            <p role="alert">{failureText(readiness.state.failure)}</p>
          )}
          {readiness.value &&
            (management ? (
              <CapturedValues value={readiness.value.response.data} />
            ) : (
              <JsonView
                processing={context.client.processing}
                value={readiness.value.response.data}
                label="Project readiness"
                identity={`${editor.fields.id}-readiness`}
              />
            ))}
        </Panel>
      )}
      {activeIntention !== null && (
        <OperationPanel
          processing={context.client.processing}
          operations={operations}
          intention={activeIntention}
        />
      )}
      <RecentActions
        operations={operations}
        connection={context.connection.id}
        onSelect={setSelected}
        section={section}
      />
    </div>
  );
}
function RecentActions({
  operations,
  connection,
  onSelect,
  section,
}: {
  readonly section: LifecycleFeatureProps["section"];
  readonly operations: LifecycleFeatureProps["operations"];
  readonly connection: Identifier;
  readonly onSelect: (id: Identifier) => void;
}) {
  const [, refresh] = useState(0);
  useEffect(() => operations.subscribe(() => refresh((value) => value + 1)), [operations]);
  const entries = operations
    .list()
    .filter(
      (entry) =>
        entry.preparation.intention_id.startsWith("life-") &&
        entry.preparation.connection_id === connection &&
        (section === undefined || entry.preparation.method.startsWith(`${section}.`)),
    );
  if (entries.length === 0) return null;
  return (
    <Panel title="Retained lifecycle actions">
      <ul className="wg-lifecycle-recent">
        {entries.map((entry) => (
          <li key={entry.preparation.intention_id}>
            <Button onClick={() => onSelect(entry.preparation.intention_id)}>
              {entry.preparation.method} · {entry.operation?.state.kind ?? entry.phase.kind}
            </Button>
            <code>{entry.preparation.intention_id}</code>
          </li>
        ))}
      </ul>
      <p className="wg-hint">
        Browser actions remain in the application controller across navigation. Durable daemon
        operations can also be inspected from the saved operation journal.
      </p>
    </Panel>
  );
}
