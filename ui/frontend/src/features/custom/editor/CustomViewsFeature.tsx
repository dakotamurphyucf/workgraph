import { SavedViewsGuide, BuilderGuide } from "./guide";
import { ScopeChoice, type ConfigurationReferences } from "./ScopeChoice";
import { ManagementPresentation } from "../../connections/management-presentation";
import { flushSync } from "react-dom";
import { Dialog } from "../../../components/Dialog";
import { Icon } from "../../../components/Icon";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { jsonField } from "../../../core/json";
import { Badge, Button, Field, Panel, Select, Toolbar } from "../../../components/Primitives";
import type { ReadState } from "../../../core/state/read-slot";
import type { Identifier } from "../../../core/protocol/types";
import type { ConfigScope, ConfigDecode } from "../config";
import { CONFIG_LIMITS } from "../config";
import { ViewForm, RendererForm } from "./forms";
import { RowsPresentation, ValuePresentation } from "./presentation";
import { current, editable, targetKey } from "./model";
import { sameTarget } from "./settings";
import { personalTitle } from "./personal-labels";
import { failureText } from "../../connections/failure";
import { JsonView, OperationPanel } from "../../connections/shared";
import * as d from "../../../core/protocol/decoders";
import type { CustomViewsFeatureProps, ConfigurationDraft, CustomPage } from "./types";
import type { FormDraft } from "./forms/types";
import "./editor.css";
function validId(value: string): Identifier | null {
  const result = d.identifier.decode(d.jsonString(value));
  return result.ok ? result.value : null;
}
function ReadNotice<T>({ state }: { readonly state: ReadState<T> }) {
  if (state.kind === "unexpected_error") throw state.error;
  return state.kind === "loading" && state.previous === undefined ? (
    <p role="status">Loading saved view…</p>
  ) : state.kind === "failed" ? (
    <p role="alert">{failureText(state.failure)}</p>
  ) : null;
}
interface ScopeInput {
  readonly kind: ConfigScope["kind"];
  readonly id: string;
}
const scopeInput = (scope: ConfigScope): ScopeInput => ({
  kind: scope.kind,
  id: "id" in scope ? scope.id : "",
});
function resolveScope(scope: ScopeInput): ConfigScope | null {
  if (scope.kind === "workspace") return { kind: "workspace" };
  const id = validId(scope.id);
  return id === null ? null : { kind: scope.kind, id };
}
function ScopeControl({
  label,
  scope,
  onChange,
  allowed = ["workspace", "project", "milestone", "ticket"],
  references,
}: {
  readonly label: string;
  readonly scope: ScopeInput;
  readonly onChange: (scope: ScopeInput) => void;
  readonly allowed?: readonly ConfigScope["kind"][];
  readonly references?: ConfigurationReferences;
}) {
  return (
    <div className="wg-custom-scope">
      <Select
        label={label}
        value={scope.kind}
        onChange={(event) => {
          const kind = allowed.find((kind) => kind === event.target.value);
          if (kind !== undefined) onChange({ kind, id: "" });
        }}
      >
        {allowed.map((kind) => (
          <option key={kind}>{kind}</option>
        ))}
      </Select>
      {scope.kind !== "workspace" && (
        <ScopeChoice
          {...(references ? { references } : {})}
          kind={scope.kind}
          label={`${label} ID`}
          value={scope.id}
          onChange={(id) => onChange({ ...scope, id })}
        />
      )}
    </div>
  );
}
function ImportMapping({
  references,
  label,
  scope,
  onChange,
}: {
  readonly label: string;
  readonly scope: ConfigScope | null;
  readonly references?: ConfigurationReferences;
  readonly onChange: (scope: ConfigScope | null) => void;
}) {
  const [input, setInput] = useState<ScopeInput>(scopeInput(scope ?? { kind: "workspace" }));
  return (
    <>
      <ScopeControl
        {...(references ? { references } : {})}
        label={label}
        scope={input}
        onChange={(value) => {
          setInput(value);
          onChange(null);
        }}
      />
      <Button disabled={resolveScope(input) === null} onClick={() => onChange(resolveScope(input))}>
        Confirm scope
      </Button>
      <span>
        {scope === null
          ? "Mapping required"
          : `Mapped to ${scope.kind}${"id" in scope ? ` ${scope.id}` : ""}`}
      </span>
    </>
  );
}

function captureLabels(page: CustomPage) {
  const capture = page.capture;
  return [
    {
      label: "Endpoint",
      value: `${page.target.connection.label} · generation ${page.target.connection.generation}`,
    },
    { label: "Workspace", value: page.target.workspaceId },
    ...(capture.kind === "history"
      ? [
          { label: "History head", value: capture.head ?? "empty" },
          { label: "Through event", value: capture.sequence },
        ]
      : capture.kind === "activity"
        ? [
            { label: "Activity lineage", value: capture.lineage },
            { label: "Through", value: capture.through },
          ]
        : [
            { label: `${capture.kind} revision`, value: capture.revision },
            ...(capture.kind === "runs" && capture.history !== null
              ? [{ label: "Associated history head", value: capture.history.head ?? "empty" }]
              : []),
          ]),
  ];
}
function sourceForm(draft: Extract<ConfigurationDraft, { kind: "editing" }>): FormDraft | null {
  if (draft.form !== null) return draft.form;
  const decoded = draft.decoded;
  if (decoded === null || decoded.kind === "invalid_json") return null;
  return { candidate: decoded.raw, text: {}, errors: [] };
}
function Download({ blob, name }: { readonly blob: Blob; readonly name: string }) {
  const anchor = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(blob);
    if (anchor.current !== null) anchor.current.href = url;
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return (
    <a ref={anchor} className="wg-button" download={name}>
      Download portable settings
    </a>
  );
}

function issues(decoded: ConfigDecode | null) {
  if (decoded === null) return null;
  if (decoded.kind === "invalid")
    return (
      <ul role="alert">
        {decoded.issues.map((issue, index) => (
          <li key={index}>
            {issue.path.join(".") || "configuration"}: {issue.message}
          </li>
        ))}
      </ul>
    );
  if (decoded.kind === "unsupported_version")
    return (
      <p role="status">
        Version {decoded.version} is unavailable. Exact source remains preserved; this configuration
        cannot be activated.
      </p>
    );
  return null;
}
export function CustomViewsFeature({ context, controller, operations }: CustomViewsFeatureProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get);
  const [screen, setScreen] = useState<"library" | "builder" | "results">("library");
  const [dialog, setDialog] = useState<"import" | "catalog" | "targets" | null>(null);
  const [filter, setFilter] = useState("");
  const [unexpected, setUnexpected] = useState<{ cause: unknown } | null>(null),
    [exported, setExported] = useState<Blob | null>(null),
    [importText, setImportText] = useState("");
  const [reviewedImport, setReviewedImport] = useState<string | null>(null);
  const [reviewingImport, setReviewingImport] = useState(false);
  const [documentResource, setDocumentResource] = useState(""),
    [catalogResource, setCatalogResource] = useState("");
  const [indexScope, setIndexScope] = useState<ScopeInput>({ kind: "workspace", id: "" }),
    [link, setLink] = useState<ScopeInput>({ kind: "workspace", id: "" });
  const previewOwner = useRef<AbortController | null>(null);
  const workingView = useRef<HTMLDivElement | null>(null);
  const activationFocus = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      previewOwner.current?.abort();
      activationFocus.current?.abort();
    },
    [
      controller,
      context.connection.id,
      context.connection.generation,
      context.connection.socket,
      context.route.workspaceId,
      state.draft?.id,
    ],
  );
  const [previewText, setPreviewText] = useState('{"example":"value"}'),
    [preview, setPreview] = useState<{
      value: import("../../../core/json").JsonValue;
      identity: string;
      scope: string;
    } | null>(null),
    [previewError, setPreviewError] = useState<{ scope: string; message: string } | null>(null);
  useEffect(() => controller.select(context), [controller, context]);
  if (unexpected !== null) throw unexpected.cause;
  if (state.unexpected !== null) throw state.unexpected.cause;
  const run = (work: Promise<unknown>) => {
    void work.catch((cause) => setUnexpected({ cause }));
  };
  const personal = current(state.personal),
    catalog = current(state.shared),
    inventory = current(state.inventory),
    page = current(state.page);
  const references = state.target ? { context, target: state.target } : undefined;
  const draft = state.draft,
    editing = draft?.kind === "editing" ? draft : null,
    document = editing === null ? null : editable(editing.decoded),
    form = editing === null ? null : sourceForm(editing);
  const visibleScreen =
    (screen === "builder" && draft === null) || (screen === "results" && state.active === null)
      ? "library"
      : screen;
  const rawKind = form?.candidate.kind === "object" ? jsonField(form.candidate, "kind") : undefined;
  const editorKind =
    rawKind?.kind === "string" && (rawKind.value === "renderer" || rawKind.value === "view")
      ? rawKind.value
      : null;
  const ready =
    editing !== null &&
    !editing.busy &&
    (editing.form === null || editing.form.errors.length === 0) &&
    document !== null;
  const locked =
    state.personalSave.kind === "saving" ||
    state.personalSave.kind === "unknown" ||
    state.personalSave.kind === "conflict" ||
    state.personalSave.kind === "rejected";
  const previewScope = editing === null ? "none" : `${targetKey(editing.target)}:${editing.id}`;
  async function previewValue() {
    const scope = previewScope;
    const captured = previewText,
      owner = new AbortController();
    previewOwner.current?.abort();
    previewOwner.current = owner;
    try {
      const result = await context.client.processing.parse(captured, {
        limits: CONFIG_LIMITS,
        signal: owner.signal,
      });
      if (owner.signal.aborted || previewOwner.current !== owner) return;
      if (!result.ok || !result.value.ok) {
        setPreviewError({
          scope,
          message: !result.ok
            ? result.failure.message
            : !result.value.ok
              ? result.value.error.message
              : "",
        });
        return;
      }
      setPreview({ value: result.value.value.value, identity: captured, scope });
      setPreviewError(null);
    } catch (error) {
      if (!owner.signal.aborted && previewOwner.current === owner) throw error;
    }
  }
  function prepare() {
    const documentResourceId = validId(documentResource),
      catalogResourceId = validId(catalogResource);
    if (documentResourceId === null || catalogResourceId === null) return;
    const index = resolveScope(indexScope),
      target = resolveScope(link);
    if (
      index === null ||
      target === null ||
      (target.kind !== "workspace" && target.kind !== "project")
    )
      return;
    run(
      controller.prepareShared(context, {
        documentResourceId,
        catalogResourceId,
        indexScope: index,
        link:
          target.kind === "workspace" ? { kind: "workspace" } : { kind: "project", id: target.id },
      }),
    );
  }
  const coverage =
    page === undefined
      ? null
      : {
          capture: captureLabels(page),
          complete: page.complete && !state.loadedLimitReached,
          partial: state.loadedPartial,
          stop: state.loadedLimitReached
            ? "Loaded capacity of 512 rows reached; start a fresh query to replace them"
            : page.stop,
          values: state.loadedCoverage,
          byteCoverage: state.loadedPages.some((item) => item.byteCoverage?.kind === "not_reported")
            ? {
                kind: "not_reported" as const,
                message:
                  "One or more source pages do not report a byte-budget completeness contract. Collection traversal is shown separately.",
              }
            : {
                kind: "reported" as const,
                truncated: state.loadedPages.some(
                  (item) => item.byteCoverage?.kind === "reported" && item.byteCoverage.truncated,
                ),
              },
        };
  return (
    <div className="wg-custom-editor">
      <header className="sv-heading">
        <h1>
          <Icon name="saved" />
          Saved views
        </h1>
        <Toolbar label="Saved view actions">
          <Button tone="quiet" onClick={() => setDialog("import")}>
            Import
          </Button>
          <Button tone="quiet" onClick={() => setDialog("catalog")}>
            Shared catalog
          </Button>
          <Button
            tone="quiet"
            onClick={() => {
              setDialog("targets");
              run(controller.inspectInventory());
            }}
          >
            Saved targets
          </Button>
          <Button
            onClick={() => {
              controller.newRenderer();
              setScreen("builder");
            }}
            disabled={state.target === null || draft !== null}
          >
            <Icon name="advanced" />
            New renderer
          </Button>
          <Button
            tone="primary"
            onClick={() => {
              const projectId =
                context.route.projectId === null ? null : validId(context.route.projectId);
              controller.newView(
                projectId === null ? { kind: "workspace" } : { kind: "project", id: projectId },
              );
              setScreen("builder");
            }}
            disabled={state.target === null || draft !== null}
          >
            <Icon name="plus" />
            New view
          </Button>
        </Toolbar>
      </header>
      <nav className="sv-tabs" aria-label="Saved view sections">
        <Button aria-pressed={visibleScreen === "library"} onClick={() => setScreen("library")}>
          <Icon name="saved" /> Library{" "}
          {personal === undefined ? "" : `· ${personal.documents.length}`}
        </Button>
        <Button
          aria-pressed={visibleScreen === "builder"}
          onClick={() => setScreen("builder")}
          disabled={draft === null}
        >
          <Icon name="work" /> Builder {draft === null ? "" : "· Draft"}
        </Button>
        <Button
          aria-pressed={visibleScreen === "results"}
          onClick={() => setScreen("results")}
          disabled={state.active === null}
        >
          <Icon name="activity" /> Results{" "}
          {state.active === null ? "" : `· ${state.active.view.title}`}
        </Button>
      </nav>
      <div className="sv-section-description">
        <strong>
          {visibleScreen === "library"
            ? "Your saved perspectives"
            : visibleScreen === "builder"
              ? "Build a view, one choice at a time"
              : "Explore your results"}
        </strong>
        <p>
          {visibleScreen === "library"
            ? "Browse reusable views and display recipes, or create your first one. Your library is kept for the selected connection and workspace."
            : visibleScreen === "builder"
              ? "Choose what to read and how to show it. Your unsaved draft stays here when you switch tabs."
              : "Read the records selected by the activated view. Use Fresh query to start a new snapshot or Load more results to extend this one."}
        </p>
      </div>
      {state.message !== null && <p role="status">{state.message}</p>}
      {state.personalSave.kind !== "idle" && (
        <section aria-label="Private save status">
          <p role="status">
            {state.personalSave.kind === "saved"
              ? state.personalSave.confirmation === "acknowledged"
                ? `Private settings saved at revision ${state.personalSave.revision}.`
                : `Desired private settings observed at revision ${state.personalSave.revision}; the original attempt is not attributed by this read.`
              : state.personalSave.kind === "saving"
                ? "Saving captured private settings…"
                : state.personalSave.message}
          </p>
          {(state.personalSave.kind === "unknown" ||
            state.personalSave.kind === "conflict" ||
            state.personalSave.kind === "rejected") && (
            <>
              <Button onClick={() => run(controller.inspectPersonal())}>
                Inspect original save target
              </Button>
              <Button
                onClick={() => run(controller.retryPersonal())}
                disabled={
                  state.personalSave.kind !== "conflict" ||
                  state.personalSave.observed.revision !== state.personalSave.plan.expectedRevision
                }
              >
                Retry exact save
              </Button>
              {state.draft?.kind === "editing" ? (
                <Button
                  onClick={() => controller.rebasePersonal()}
                  disabled={state.personalSave.kind !== "conflict"}
                >
                  Use inspected revision for a new save
                </Button>
              ) : state.draft === null ? (
                <>
                  <Button
                    onClick={() => run(controller.discardPersonalSave())}
                    disabled={state.personalSave.kind !== "conflict" || state.target === null}
                  >
                    Discard intention and inspect current settings
                  </Button>
                  <p className="wg-hint">
                    Discarding does not undo or resolve any earlier publication. Current documents
                    must be read before you deliberately set a preference, remove a document, or
                    save the retained import again. No stale document set is merged automatically.
                  </p>
                </>
              ) : null}
              <p className="wg-hint">
                Original target generation {state.personalSave.plan.target.connection.generation},
                private guard {state.personalSave.plan.expectedRevision}. Inspecting never updates
                that guard.
              </p>
            </>
          )}
        </section>
      )}

      <section
        className="sv-section"
        hidden={visibleScreen !== "library"}
        aria-label="Saved configuration library"
      >
        <SavedViewsGuide />
        <div className="sv-library-tools">
          <Field
            label="Filter saved configurations"
            placeholder="Find by title or ID…"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          />
          <Button
            onClick={() => run(controller.inspectPersonal())}
            disabled={state.target === null}
          >
            Refresh library
          </Button>
        </div>
        <ReadNotice state={state.personal} />
        {personal !== undefined && (
          <section className="wg-custom-configurations">
            <Panel
              title="Your saved configurations"
              actions={
                <Button
                  disabled={locked}
                  onClick={() => run(controller.exportPersonal().then((blob) => setExported(blob)))}
                >
                  Export chosen target
                </Button>
              }
            >
              {personal.documents.length === 0 ? (
                <div className="sv-empty">
                  <Icon name="saved" />
                  <h3>Make this workspace your own</h3>
                  <p>
                    Create a view of tickets, runs, sessions or other records. Save it privately
                    here, or publish a configuration for others to use.
                  </p>
                </div>
              ) : (
                <ul className="wg-custom-saved">
                  {personal.documents
                    .filter((item) =>
                      `${personalTitle(personal, item, state.personalLabels) ?? ""} ${item.id}`
                        .toLocaleLowerCase()
                        .includes(filter.toLocaleLowerCase()),
                    )
                    .map((item) => (
                      <li key={item.id}>
                        <div className="sv-card-heading">
                          <Icon name="saved" />
                          <div>
                            <strong>
                              {personalTitle(personal, item, state.personalLabels) ??
                                "Saved configuration"}
                            </strong>
                            <code>{item.id}</code>
                          </div>
                        </div>
                        {personal.selectedId === item.id && <Badge>Preferred</Badge>}
                        <Button
                          onClick={() => {
                            controller.editPersonal(item.id);
                            setScreen("builder");
                          }}
                          disabled={draft !== null}
                        >
                          Open
                        </Button>
                        <Button
                          disabled={locked || personal.selectedId === item.id}
                          onClick={() => run(controller.setPersonalDefault(item.id))}
                        >
                          Set preferred
                        </Button>
                        <Button
                          disabled={locked}
                          onClick={() => run(controller.removePersonal(item.id))}
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                </ul>
              )}
              {personal.documents.length > 0 &&
                filter &&
                !personal.documents.some((item) =>
                  `${personalTitle(personal, item, state.personalLabels) ?? ""} ${item.id}`
                    .toLocaleLowerCase()
                    .includes(filter.toLocaleLowerCase()),
                ) && (
                  <p className="sv-empty">
                    No saved configurations match this name. Clear the search to see the full
                    library.
                  </p>
                )}
              {draft !== null && (
                <p className="sv-help">
                  You already have a draft open. Use the Builder tab to continue it, or discard it
                  before opening another configuration. Results remain available.
                </p>
              )}
              {personal.selectedId !== null && (
                <Button disabled={locked} onClick={() => run(controller.setPersonalDefault(null))}>
                  Clear preferred selection
                </Button>
              )}
              {exported !== null && <Download blob={exported} name="workgraph-views.json" />}
              <p className="wg-hint">
                Removing a saved configuration removes only its local settings, not the tickets,
                files or other records it displays. Export downloads the settings for this
                connection and workspace; it does not export workspace data.
              </p>
              <p className="wg-hint">
                Preferred selection is an explicit saved preference. Use Open, review and Activate
                to load its source; unsupported or invalid source stays available in Raw.
              </p>
            </Panel>
          </section>
        )}
        {state.target === null ? (
          <p>Select a workspace to manage saved views.</p>
        ) : (
          <details className="wg-custom-target-details">
            <summary>Private target and activation details</summary>
            <p className="wg-hint">
              Private preferences for {state.target.connection.label} · generation{" "}
              {state.target.connection.generation} · workspace{" "}
              <code>{state.target.workspaceId}</code>. Reading a saved preference never activates it
              or sends a write.
            </p>
          </details>
        )}
      </section>
      <section
        className="sv-section sv-builder"
        hidden={visibleScreen !== "builder"}
        aria-label="Configuration builder"
      >
        {editing !== null && (
          <Panel
            title={
              editorKind === "renderer"
                ? "Renderer builder"
                : editorKind === "view"
                  ? "View builder"
                  : "Configuration source"
            }
            actions={
              <Button
                disabled={editing.busy}
                onClick={() => {
                  controller.discardDraft();
                  setScreen(state.active === null ? "library" : "results");
                }}
              >
                Discard draft
              </Button>
            }
          >
            <BuilderGuide renderer={editorKind === "renderer"} />
            <Toolbar label="Configuration editing">
              <Button
                onClick={() => controller.setMode("form")}
                aria-pressed={editing.mode === "form"}
              >
                Builder
              </Button>
              <Button
                onClick={() => controller.setMode("raw")}
                aria-pressed={editing.mode === "raw"}
              >
                Raw source
              </Button>
              <Button
                onClick={() => run(controller.savePersonal())}
                disabled={
                  (!ready && editing.origin.kind !== "personal") ||
                  editing.busy ||
                  locked ||
                  (editing.form?.errors.length ?? 0) > 0
                }
              >
                Save privately
              </Button>

              {editorKind === "view" && (
                <Button
                  tone="primary"
                  disabled={
                    !ready || document?.kind !== "view" || state.activation.kind === "loading"
                  }
                  onClick={(event) => {
                    const opener = event.currentTarget;
                    const previous = controller.get().active;
                    activationFocus.current?.abort();
                    const owner = new AbortController();
                    activationFocus.current = owner;
                    let ownsFocus = true;
                    window.document.addEventListener(
                      "focusin",
                      (change) => {
                        if (change.target !== opener && change.target !== window.document.body)
                          ownsFocus = false;
                      },
                      { signal: owner.signal },
                    );
                    window.document.addEventListener(
                      "pointerdown",
                      (change) => {
                        if (!(change.target instanceof Node) || !opener.contains(change.target))
                          ownsFocus = false;
                      },
                      { signal: owner.signal },
                    );
                    run(
                      (async () => {
                        try {
                          await controller.activate();
                          const activated = controller.get().active;
                          if (activated === null || activated === previous) return;
                          // Expose the destination before focusing it. React may otherwise
                          // commit the tab change after the next animation frame.
                          if (!owner.signal.aborted && ownsFocus)
                            flushSync(() => setScreen("results"));
                          await new Promise<void>((resolve) =>
                            requestAnimationFrame(() => {
                              const focused = window.document.activeElement;
                              if (
                                !owner.signal.aborted &&
                                ownsFocus &&
                                window.document.hasFocus() &&
                                opener.isConnected &&
                                controller.get().active === activated &&
                                (focused === opener || focused === window.document.body)
                              )
                                workingView.current?.focus();
                              resolve();
                            }),
                          );
                        } finally {
                          owner.abort();
                          if (activationFocus.current === owner) activationFocus.current = null;
                        }
                      })(),
                    );
                  }}
                >
                  Activate view
                </Button>
              )}
            </Toolbar>

            {editing.mode === "raw" ? (
              <>
                <p>
                  Unfinished Builder text remains retained when you return. Editing Raw source
                  deliberately replaces that Builder state.
                </p>
                <label>
                  Configuration source
                  <textarea
                    aria-label="Configuration source"
                    value={editing.source}
                    spellCheck={false}
                    onChange={(event) => controller.editSource(event.target.value)}
                  />
                </label>
              </>
            ) : form !== null ? (
              <>
                {editorKind === "renderer" ? (
                  <>
                    <p className="wg-hint">
                      Schema matching reads only an explicit root schema object with exactly id and
                      version strings. Missing declarations do not match; malformed declarations
                      remain generic with a diagnostic.
                    </p>
                    <RendererForm
                      references={{ context, target: editing.target }}
                      value={document?.kind === "renderer" ? document : null}
                      draft={form}
                      decoded={editing.decoded?.kind === "invalid_json" ? null : editing.decoded}
                      onChange={(value) => controller.editForm(value)}
                      onRaw={() => controller.setMode("raw")}
                    />
                  </>
                ) : (
                  <ViewForm
                    references={{ context, target: editing.target }}
                    value={document?.kind === "view" ? document : null}
                    draft={form}
                    decoded={editing.decoded?.kind === "invalid_json" ? null : editing.decoded}
                    onChange={(value) => controller.editForm(value)}
                    onRaw={() => controller.setMode("raw")}
                  />
                )}
              </>
            ) : (
              <p>Source cannot be edited with this builder. Open Raw to inspect or repair it.</p>
            )}
            {editing.busy && <p role="status">Validating bounded configuration…</p>}
            {editing.message !== null && <p role="alert">{editing.message}</p>}
            {issues(editing.decoded?.kind === "invalid_json" ? null : editing.decoded)}
            {editing.decoded?.kind === "invalid_json" && (
              <p role="alert">{editing.decoded.message}</p>
            )}
            <details className="sv-advanced-save">
              <summary>Save conflicts and advanced options</summary>
              <p>
                If local settings changed while you were editing, inspect their latest state before
                choosing a new save revision. This keeps your draft; it does not merge someone
                else’s edits or retry an uncertain save.
              </p>{" "}
              <Button
                disabled={
                  locked || personal === undefined || !sameTarget(personal.target, editing.target)
                }
                onClick={() => controller.rebasePersonal()}
              >
                Update private save guard
              </Button>
            </details>
            <details>
              <summary>Share this configuration with your workspace</summary>
              <p>
                Sharing saves this configuration as a versioned resource and adds it to a shared
                catalog. Other users can open it from that catalog. It does not copy the records in
                the view or activate it for anyone. Fill in the destination below, review the
                changes, then apply them explicitly.
              </p>
              <Field
                label="Configuration resource ID"
                hint="A resource ID for this view or renderer, for example release-ticket-view. Use a new ID unless you intend to update that existing configuration."
                value={documentResource}
                onChange={(event) => setDocumentResource(event.target.value)}
              />
              <Field
                label="Catalog resource ID"
                hint="The resource that stores the shared directory, for example team-views. Reuse your team’s catalog ID to add to its directory."
                value={catalogResource}
                onChange={(event) => setCatalogResource(event.target.value)}
              />
              <ScopeControl
                references={{ context, target: editing.target }}
                label="Index fact scope"
                scope={indexScope}
                onChange={setIndexScope}
              />
              <ScopeControl
                references={{ context, target: editing.target }}
                label="Resource link target"
                scope={link}
                onChange={setLink}
                allowed={["workspace", "project"]}
              />
              <p>
                <strong>Index fact scope</strong> is where Workgraph stores the pointer to this
                catalog, so others know where to find it. <strong>Resource link target</strong>{" "}
                connects the configuration file to a workspace or project. Start with Workspace for
                both unless you need a project-specific catalog.
              </p>
              {context.writer.actorId === null && (
                <p role="status">
                  Sharing opens the actor chooser first. Private saves do not require a workspace
                  write.
                </p>
              )}
              <Button
                requiresActor
                disabled={
                  !ready ||
                  validId(documentResource) === null ||
                  validId(catalogResource) === null ||
                  resolveScope(indexScope) === null ||
                  resolveScope(link) === null
                }
                onClick={prepare}
              >
                Review shared publication
              </Button>
            </details>
            {document?.kind === "renderer" && (
              <details>
                <summary>3 · Try your renderer with sample data</summary>
                <p>
                  Paste a small JSON value shaped like your actual content, then choose Preview
                  value. This tests the draft display without saving data or publishing the
                  renderer.
                </p>
                <label>
                  Preview JSON
                  <textarea
                    aria-label="Preview JSON"
                    value={previewText}
                    onChange={(event) => {
                      previewOwner.current?.abort();
                      setPreview(null);
                      setPreviewText(event.target.value);
                    }}
                  />
                </label>
                <Button onClick={() => run(previewValue())}>Preview value</Button>
                {previewError !== null && previewError.scope === previewScope && (
                  <p role="alert">{previewError.message}</p>
                )}
                {preview !== null && preview.scope === previewScope && (
                  <ValuePresentation
                    identity={`${editing.id}:${preview.identity}`}
                    value={preview.value}
                    renderer={document}
                    processing={context.client.processing}
                    generic={
                      <JsonView
                        value={preview.value}
                        label="Generic value"
                        identity={`${editing.id}:generic:${preview.identity}`}
                        processing={context.client.processing}
                      />
                    }
                  />
                )}
                <p>Draft preview only. This does not register or select a shared renderer.</p>
              </details>
            )}
          </Panel>
        )}
        {draft?.kind === "captured" && (
          <Panel title="Captured shared publication">
            <ManagementPresentation value={true}>
              <OperationPanel
                intention={draft.prepared.preparation.intention_id}
                operations={operations}
                processing={context.client.processing}
              />
            </ManagementPresentation>
            <Button
              onClick={() => {
                controller.discardDraft();
                setScreen(state.active === null ? "library" : "results");
              }}
            >
              Close captured review
            </Button>
          </Panel>
        )}
      </section>
      <section
        className="sv-section sv-results"
        hidden={visibleScreen !== "results"}
        aria-label="Saved view results"
      >
        <ReadNotice state={state.activation} />
        <ReadNotice state={state.page} />
        {state.active !== null && page !== undefined && coverage !== null && (
          <div ref={workingView} tabIndex={-1} aria-label="Working view results">
            <Panel
              title="Working view"
              actions={
                <Toolbar label="Captured source paging">
                  <Button onClick={() => run(controller.refresh())}>Fresh query</Button>
                  <Button
                    disabled={
                      page.next === null ||
                      state.loadedLimitReached ||
                      state.page.kind === "loading"
                    }
                    onClick={() => run(controller.continue("next"))}
                  >
                    Load more results
                  </Button>
                  <Button
                    disabled={
                      page.retry === null ||
                      state.loadedLimitReached ||
                      state.page.kind === "loading"
                    }
                    onClick={() => run(controller.continue("retry"))}
                  >
                    Retry loading results
                  </Button>
                </Toolbar>
              }
            >
              <p className="sv-result-help">
                These are read-only results from your activated configuration. Editing the Builder
                does not change them until you activate again. Fresh query replaces the current
                snapshot; Load more results adds the next available page. Coverage below tells you
                whether more records may remain.
              </p>
              <RowsPresentation
                identity={`${targetKey(state.active.target)}:${state.active.view.id}:${JSON.stringify(coverage.capture)}`}
                view={state.active.view}
                rows={state.loaded}
                coverage={coverage}
                processing={context.client.processing}
              />
              {state.loadedLimitReached && (
                <p role="status">
                  Loaded capacity reached: 512 rows. Paging is stopped. A fresh query deliberately
                  replaces these rows.
                </p>
              )}
            </Panel>
          </div>
        )}
      </section>
      {dialog === "targets" && (
        <Dialog title="Saved private targets" wide onClose={() => setDialog(null)}>
          <ReadNotice state={state.inventory} />
          {inventory !== undefined && (
            <section>
              <h3>Libraries saved on this local service</h3>
              <p>{inventory.targets.length} saved connection/workspace locations</p>
              <p>
                A target is a connection and workspace with its own private library. Select one to
                inspect its saved configurations, export them or remove them. This does not
                reconnect the daemon or move an existing draft. To work with live records, the
                matching connection must still be available.
              </p>
              {inventory.targets.length === 0 && (
                <p className="sv-empty">
                  No private libraries have been saved yet. Create a view and choose Save privately
                  to start one.
                </p>
              )}
              {inventory.targets.map((item) => (
                <p key={targetKey(item.target)}>
                  <Button
                    onClick={() => {
                      controller.selectSavedTarget(item.target);
                      setDialog(null);
                      setScreen("library");
                    }}
                  >
                    {item.target.connection.label} · generation {item.target.connection.generation}{" "}
                    · {item.target.workspaceId}
                  </Button>{" "}
                  {item.documentIds.length} documents
                </p>
              ))}
            </section>
          )}
        </Dialog>
      )}
      {dialog === "import" && (
        <Dialog title="Import portable settings" wide onClose={() => setDialog(null)}>
          <section>
            <p>
              Move your saved configurations between local installations. Paste the contents of a
              file downloaded with Export chosen target. First review the import, then choose where
              each view should look in this workspace and confirm that scope. Finally save the
              reviewed import privately. This imports settings, not workspace records, connections
              or acting actors.
            </p>
            <label>
              Portable settings JSON
              <textarea
                aria-label="Portable settings JSON"
                value={importText}
                onChange={(event) => {
                  setImportText(event.target.value);
                  setReviewedImport(null);
                }}
              />
            </label>
            <Button
              disabled={reviewingImport || !importText.trim()}
              onClick={() => {
                const source = importText;
                const before = controller.get().imported;
                setReviewedImport(null);
                setReviewingImport(true);
                run(
                  controller
                    .importSource(source)
                    .then(() => {
                      if (
                        controller.get().imported !== before &&
                        controller.get().imported !== null
                      )
                        setReviewedImport(source);
                    })
                    .finally(() => setReviewingImport(false)),
                );
              }}
            >
              {reviewingImport ? "Reviewing import…" : "Review import"}
            </Button>
            {state.message && <p role="status">{state.message}</p>}
            {state.personalSave.kind !== "idle" &&
              state.personalSave.kind !== "saved" &&
              state.personalSave.kind !== "saving" && (
                <p role="alert">{state.personalSave.message}</p>
              )}
            {state.personalSave.kind === "saved" && (
              <p role="status">
                Private settings saved. Close this dialog to find them in your library.
              </p>
            )}
            {state.imported !== null && reviewedImport === importText && !reviewingImport && (
              <>
                <ul>
                  {state.imported.documents.map((item, index) => (
                    <li key={item.id}>
                      <code>{item.id}</code> · {item.decoded.kind}
                      {item.decoded.kind === "valid" &&
                        "kind" in item.decoded.document &&
                        item.decoded.document.kind === "view" && (
                          <ImportMapping
                            {...(references ? { references } : {})}
                            label={`Local scope for ${item.id}`}
                            scope={item.mappedScope}
                            onChange={(scope) => controller.mapImport(index, scope)}
                          />
                        )}
                    </li>
                  ))}
                </ul>
                <p>
                  Confirm the destination of each supported view before saving. An imported ID that
                  already exists replaces that configuration in your private library. Other saved
                  configurations stay in place.
                </p>
                <Button
                  disabled={
                    locked ||
                    state.imported.documents.some(
                      (item) =>
                        item.decoded.kind === "valid" &&
                        "kind" in item.decoded.document &&
                        item.decoded.document.kind === "view" &&
                        item.mappedScope === null,
                    )
                  }
                  onClick={() => run(controller.adoptImport())}
                >
                  Save reviewed import privately
                </Button>
              </>
            )}
          </section>
        </Dialog>
      )}
      {dialog === "catalog" && (
        <Dialog title="Verified shared catalog" wide onClose={() => setDialog(null)}>
          <section>
            <p>
              Shared configurations are published as versioned resources and listed in a catalog.
              Choose where your team published its catalog, usually Workspace, then Read shared
              catalog. If nothing has been shared there yet, create a view and use its sharing
              section. Opening an entry creates an editable draft; choose Activate view to see
              results or Save privately to keep your own copy.
            </p>
            <ScopeControl
              {...(references ? { references } : {})}
              label="Shared index scope"
              scope={indexScope}
              onChange={setIndexScope}
            />
            <Button
              onClick={() => {
                const scope = resolveScope(indexScope);
                if (scope !== null) run(controller.loadShared(scope));
              }}
              disabled={state.target === null || resolveScope(indexScope) === null}
            >
              Read shared catalog
            </Button>
            <p className="wg-hint">
              An index is a saved pointer to the catalog. Select the same scope used when it was
              published; it is not a filter over all catalogs.
            </p>
            <ReadNotice state={state.shared} />
            {catalog !== undefined && (
              <>
                <p>
                  Verified catalog {catalog.capture.pin.resource_id} · content version{" "}
                  {catalog.capture.pin.version} · index revision {catalog.indexRevision}
                </p>
                {catalog.capture.decoded.kind === "valid" &&
                  "kind" in catalog.capture.decoded.document &&
                  catalog.capture.decoded.document.kind === "catalog" &&
                  catalog.capture.decoded.document.entries.map((entry) => (
                    <p key={entry.id}>
                      <Button
                        disabled={draft !== null}
                        onClick={() => {
                          run(controller.openShared(entry.id));
                          setScreen("builder");
                          setDialog(null);
                        }}
                      >
                        {entry.id}
                      </Button>{" "}
                      {entry.kind} · resource {entry.pin.resource_id} · content version{" "}
                      {entry.pin.version}
                    </p>
                  ))}
                {catalog.unavailable.map((item, index) => (
                  <p key={index} role="status">
                    Unavailable {item.pin.resource_id}@{item.pin.version}: {item.message}
                  </p>
                ))}
              </>
            )}
          </section>
        </Dialog>
      )}
    </div>
  );
}
