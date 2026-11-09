import { Dialog } from "../../components/Dialog";
import { ActorAvatar } from "../../components/ActorAvatar";
import type { FeatureContext } from "../../app/types";
import { AdvancedChoice, AdvancedGuide } from "./AdvancedDesign";
import { EXPLORER_SECTIONS, fieldChoiceKind, matchesChoiceScope } from "./design-model";
import { Icon } from "../../components/Icon";
import { changeView } from "../../app/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Badge,
  Button,
  Field,
  Panel,
  Select,
  StatePanel,
  Toolbar,
} from "../../components/Primitives";
import { ObservationNotice } from "../../components/ObservationNotice";
import { JsonPane } from "../knowledge/viewers/JsonPane";
import { createViewerWorker } from "../knowledge/viewers/worker-client";
import "../knowledge/viewers/viewers.css";
import { ContentViewer } from "../../content";
import { DestinationSummary } from "../connections/shared";
import { useClipboardCopy } from "../../content/clipboard";
import { encode } from "./parameters";
import type { ProtocolProcessor } from "../../core/protocol/worker";
import type { ContentSource } from "../../content";
import { type JsonValue } from "../../core/json";
import type { Identifier } from "../../core/protocol/types";
import type { HttpFailure } from "../../core/protocol/http";
import type { ReadState } from "../../core/state/read-slot";
import type { ManagedOperation } from "../../core/state/operations";
import { continuation } from "./controller";
import { HOST_SURFACES } from "./extras";
import { fieldType, type FieldInput, type InputResult, type JsonObject } from "./fields";
import type {
  AdvancedDraft,
  AdvancedFeatureProps,
  DiscoveryEntry,
  FieldDescriptor,
  HostSurface,
  MethodContract,
} from "./types";
import "./advanced.css";
import "./advanced-design.css";
function failureText(failure: HttpFailure): string {
  if (failure.kind === "remote") return `${failure.problem.kind}: ${failure.problem.message}`;
  return failure.kind === "aborted" ? "Read cancelled." : failure.message;
}
function State<T>({ state, label }: { readonly state: ReadState<T>; readonly label: string }) {
  if (state.kind === "unexpected_error") throw state.error;
  if (state.kind === "failed")
    return (
      <StatePanel kind="error" title={`${label} unavailable`}>
        {failureText(state.failure)}
      </StatePanel>
    );
  if (state.kind === "loading")
    return (
      <p role="status" className="wg-hint">
        Loading {label.toLowerCase()}…
      </p>
    );
  return null;
}
function JsonView({
  value,
  label,
  identity,
  processing,
}: {
  readonly value: JsonValue;
  readonly label: string;
  readonly identity: string;
  readonly processing: ProtocolProcessor;
}) {
  const [viewerWorker] = useState(() => createViewerWorker());
  useEffect(() => () => viewerWorker.dispose(), [viewerWorker]);
  const owner = useMemo(() => ({ value, label, identity }), [value, label, identity]);
  const [capture, setCapture] = useState<{
      readonly owner: typeof owner;
      readonly source: ContentSource | null;
      readonly failure: string;
      readonly unexpected: { error: unknown } | null;
    } | null>(null),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void encode(processing, owner.value, abort.signal, "observation")
      .then((result) => {
        if (abort.signal.aborted) return;
        setCapture({
          owner,
          source: result.ok
            ? {
                key: `advanced-json-${crypto.randomUUID()}`,
                label: `${owner.label} source`,
                bytes: new TextEncoder().encode(result.value),
                completeness: "complete",
                hints: { mime: "application/json", intent: "code" },
              }
            : null,
          failure: result.ok ? "" : result.message,
          unexpected: null,
        });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setCapture({ owner, source: null, failure: "", unexpected: { error } });
      });
    return () => abort.abort();
  }, [owner, processing, attempt]);
  if (capture?.owner === owner && capture.unexpected) throw capture.unexpected.error;
  if (capture?.owner !== owner)
    return (
      <p className="wg-hint" role="status">
        Formatting decoded JSON…
      </p>
    );
  return capture.source ? (
    <section className="adv-json-result" aria-label={`Content: ${label}`}>
      <h3>{label}</h3>
      <JsonPane
        source={capture.source}
        worker={viewerWorker}
        description="Expand fields to explore the response. Numbers remain exact. Open JSON source and download below to copy or inspect the encoded source."
      />
      <Disclosure title="JSON source and download">
        <ContentViewer source={capture.source} />
      </Disclosure>
    </section>
  ) : (
    <StatePanel
      kind="error"
      title="JSON formatting unavailable"
      action={<Button onClick={() => setAttempt((n) => n + 1)}>Retry formatting</Button>}
    >
      {capture.failure}
    </StatePanel>
  );
}
function TextView({ text, label }: { readonly text: string; readonly label: string }) {
  const source = useMemo<ContentSource>(
    () => ({
      key: `advanced-text-${crypto.randomUUID()}`,
      label,
      bytes: new TextEncoder().encode(text),
      completeness: "complete",
      hints: { intent: "prose" },
    }),
    [text, label],
  );
  return <ContentViewer source={source} />;
}
function CopyCommand({ owner, command }: { readonly owner: object; readonly command: string }) {
  const { copy, notice } = useClipboardCopy(owner, {
    copied: "Command copied. Review it before running it on your host.",
    unavailable: "Clipboard unavailable. Select and copy the command text.",
  });
  return (
    <>
      <div className="adv-command">
        <code>{command}</code>
        <Button
          onClick={() => {
            void copy(command);
          }}
        >
          Copy command
        </Button>
      </div>
      {notice && (
        <p role="status" className="wg-hint">
          {notice}
        </p>
      )}
    </>
  );
}
function Helper({ entry }: { readonly entry: DiscoveryEntry | HostSurface }) {
  return (
    <Panel title={entry.name}>
      <p className="adv-section-kicker">
        <Icon name={"kind" in entry ? "workflow" : "connection"} />
        {"kind" in entry ? "Guided CLI workflow" : "Run on your machine"}
      </p>
      <p className="adv-lead">{entry.summary}</p>
      {"kind" in entry ? (
        <>
          <Badge>{entry.kind}</Badge>
          <p>{entry.use_when}</p>
          {entry.effect && (
            <p>
              <strong>Effect</strong> · {entry.effect}
            </p>
          )}
          {entry.steps.length > 0 && (
            <ol className="adv-steps">
              {entry.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          )}
          <CopyCommand owner={entry} command={`workgraph help ${entry.name}`} />
          <p className="wg-hint">
            <strong>Next step</strong> · {entry.next}
          </p>
          {entry.related.length > 0 && (
            <p className="wg-hint">Related: {entry.related.join(", ")}</p>
          )}
        </>
      ) : (
        <>
          <Badge tone="warning">Host / offline</Badge>
          <p>{entry.guidance}</p>
          <CopyCommand owner={entry} command={entry.command} />
        </>
      )}
      <p className="wg-hint">
        Reference: <code>{entry.reference}</code>
      </p>
      <p className="wg-hint">
        Commands are copyable instructions. The browser does not execute them.
      </p>
    </Panel>
  );
}
function Disclosure({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{title}</summary>
      {open ? children : null}
    </details>
  );
}
function MethodHelp({
  contract,
  processing,
}: {
  readonly contract: MethodContract;
  readonly processing: ProtocolProcessor;
}) {
  return (
    <>
      <div className="adv-heading">
        <div>
          <h2>{contract.method.name}</h2>
          <p>{contract.method.summary}</p>
        </div>
        <Badge tone={contract.method.mode === "read" ? "neutral" : "warning"}>
          {contract.method.mode}
        </Badge>
      </div>
      <p className="adv-effect" data-effect={contract.method.mode === "read" ? "read" : "write"}>
        <Icon name={contract.method.mode === "read" ? "search" : "work"} />
        {contract.method.mode === "read"
          ? "Read-only operation. Sending this request retrieves information; it does not apply a write."
          : "This operation can change saved data. Prepare the request, review its destination and inputs, then explicitly execute it."}
      </p>
      <Disclosure title="Usage guide and examples">
        <TextView text={contract.help} label={`${contract.method.name} help`} />
      </Disclosure>
      <Disclosure title="API schemas · allowed inputs and returned data">
        <p className="wg-hint">
          These technical definitions describe the request, result and complete validation rules.
          You can fill the form without reading them.
        </p>
        <JsonView
          processing={processing}
          value={contract.method.params}
          label="Request schema"
          identity={`${contract.method.name}-params`}
        />
        <JsonView
          processing={processing}
          value={contract.method.result}
          label="Result schema"
          identity={`${contract.method.name}-result`}
        />
        <JsonView
          processing={processing}
          value={contract.fields.validation_schema}
          label="Full validation schema"
          identity={`${contract.method.name}-validation`}
        />
      </Disclosure>
    </>
  );
}
function FormField({
  busy,
  context,
  field,
  draft,
  params,
  onStage,
  onApply,
}: {
  readonly busy: boolean;
  readonly context: FeatureContext;
  readonly field: FieldDescriptor;
  readonly draft: AdvancedDraft;
  readonly params: InputResult<JsonObject>;
  readonly onStage: (name: string, input: FieldInput) => void;
  readonly onApply: (name: string) => void;
}) {
  const edit = Object.hasOwn(draft.fieldEdits, field.name)
    ? draft.fieldEdits[field.name]
    : undefined;
  const input =
      edit ??
      (draft.parameters.kind === "ready" && Object.hasOwn(draft.parameters.value.inputs, field.name)
        ? (draft.parameters.value.inputs[field.name] ?? { presence: "omit" as const, text: "" })
        : { presence: "omit" as const, text: "" }),
    error = Object.hasOwn(draft.fieldErrors, field.name)
      ? draft.fieldErrors[field.name]
      : undefined,
    type = fieldType(field),
    multiline =
      type === "string" &&
      (input.text.includes("\n") ||
        input.text.includes("\r") ||
        input.text.length > 160 ||
        ["description", "instructions", "text", "body", "content", "summary"].includes(field.name));
  const choiceKind = fieldChoiceKind(
    draft.contract.method.name,
    draft.contract.method.mode,
    field.name,
  );
  const choicesAllowed = params.ok && matchesChoiceScope(context, draft, params.value);
  return (
    <fieldset className="adv-field" disabled={busy}>
      <div className="adv-field-title">
        <strong>{field.name.replaceAll("_", " ")}</strong>
        <code>{field.name}</code>
        <Badge>{field.requirement}</Badge>
        {edit && <Badge tone="warning">Unapplied</Badge>}
      </div>
      <p className="wg-hint">
        {field.descriptions[0] ??
          `Enter a ${type === "json" ? "JSON" : type} value when this field is included.`}
      </p>
      <div className="adv-field-controls">
        <Select
          label={`${field.name} presence`}
          value={input.presence}
          disabled={draft.locked || draft.preparing}
          onChange={(event) =>
            onStage(field.name, {
              ...input,
              presence: event.currentTarget.value as FieldInput["presence"],
            })
          }
        >
          <option value="omit">Do not send this field</option>
          <option value="value">Provide a value</option>
          <option value="null">Send null (if supported)</option>
        </Select>
        {input.presence === "value" &&
          (type === "string" ? (
            choiceKind && choicesAllowed ? (
              <AdvancedChoice
                context={context}
                draft={draft}
                kind={choiceKind}
                label={`${field.name} value`}
                value={input.text}
                onChange={(text) => onStage(field.name, { presence: "value", text })}
              />
            ) : multiline ? (
              <label className="adv-json-field">
                {field.name} value
                <textarea
                  aria-label={`${field.name} value`}
                  value={input.text}
                  disabled={draft.locked || draft.preparing}
                  onChange={(event) =>
                    onStage(field.name, { ...input, text: event.currentTarget.value })
                  }
                />
                {input.text.includes("\r") && (
                  <span className="wg-hint">
                    This value contains carriage returns. Use Raw JSON to preserve exact line
                    endings while editing.
                  </span>
                )}
              </label>
            ) : (
              <Field
                label={`${field.name} value`}
                value={input.text}
                disabled={draft.locked || draft.preparing}
                onChange={(event) =>
                  onStage(field.name, { ...input, text: event.currentTarget.value })
                }
              />
            )
          ) : (
            <label className="adv-json-field">
              {field.name} · {type === "json" ? "JSON" : type}
              <textarea
                aria-label={`${field.name} JSON value`}
                value={input.text}
                spellCheck={false}
                disabled={draft.locked || draft.preparing}
                onChange={(event) =>
                  onStage(field.name, { ...input, text: event.currentTarget.value })
                }
              />
            </label>
          ))}
        <Button
          disabled={draft.locked || draft.preparing || !params.ok || edit === undefined}
          onClick={() => onApply(field.name)}
        >
          Apply {field.name}
        </Button>
      </div>
      {error && (
        <p role="alert" className="wg-error">
          {error}
        </p>
      )}
      {edit && (
        <p className="adv-staged-hint">
          Apply saves this field into the draft only. Nothing is sent to the daemon yet.
        </p>
      )}
      <Disclosure title="Field format and constraints">
        <p className="wg-hint">{field.summary}</p>
        {field.descriptions.slice(1).map((text, i) => (
          <p className="wg-hint" key={i}>
            {text}
          </p>
        ))}
      </Disclosure>
    </fieldset>
  );
}
function OperationView({
  entry,
  act,
  processing,
}: {
  readonly processing: ProtocolProcessor;
  readonly entry: ManagedOperation;
  readonly act: (action: "inspect" | "execute" | "retry" | "recover" | "prepare") => void;
}) {
  if (entry.phase.kind === "unexpected_error") throw entry.phase.error;
  const op = entry.operation,
    pending = entry.phase.kind === "pending";
  return (
    <Panel
      title="Captured operation"
      actions={
        <Badge tone={op?.state.kind === "outcome_unknown" ? "warning" : "neutral"}>
          <span role="status" aria-live="polite" aria-atomic="true">
            {entry.phase.kind === "unconfirmed"
              ? "Observation unconfirmed"
              : (op?.state.kind ?? entry.phase.kind)}
          </span>
        </Badge>
      }
    >
      <p className="adv-effect" data-effect="write">
        <Icon name="saved" />
        This saved request keeps its original author and destination. Inspect checks its state;
        Execute applies it only if it is prepared and unsent.
      </p>
      <p className="wg-hint">
        Intention <code>{entry.preparation.intention_id}</code> · writer{" "}
        <code>{entry.preparation.context.writer.actor_id}</code> · run{" "}
        <code>{entry.preparation.context.writer.run_id ?? "none"}</code>
      </p>
      <DestinationSummary preparation={entry.preparation} operation={op} />
      {entry.phase.kind === "unconfirmed" && (
        <p role="alert" className="wg-error">
          Observation unconfirmed: {failureText(entry.phase.failure)}. Preserve this intention;
          inspect before choosing a retry. An uncertain outcome does not mean the write failed.
        </p>
      )}
      {pending && <p role="status">{entry.phase.action} in progress…</p>}
      {op === null ? (
        <Button disabled={pending} onClick={() => act("prepare")}>
          Validate & prepare same intention
        </Button>
      ) : (
        <>
          <p className="wg-hint">
            {op.connection.label} · generation {op.connection.generation} ·{" "}
            <code>{op.connection.socket}</code>
          </p>
          <p className="wg-hint">
            Journal: <code>{op.journal_path ?? "No saved journal path reported"}</code>
          </p>
          {op.state.kind === "sending" && <ObservationNotice status={entry.observation} />}
          <p className="wg-hint">
            If a response was lost, Recover receipt checks for a recorded outcome when available.
            Retry exact saved request reuses the same identity rather than creating another write.
          </p>
          <Toolbar label="Explicit operation actions">
            <Button disabled={pending} onClick={() => act("inspect")}>
              Inspect
            </Button>
            <Button
              tone="primary"
              disabled={
                pending || entry.phase.kind !== "observed" || op.state.kind !== "prepared_unsent"
              }
              onClick={() => act("execute")}
            >
              Execute saved request
            </Button>
            <Button
              disabled={pending || op.state.kind !== "outcome_unknown"}
              onClick={() => act("retry")}
            >
              Retry exact saved request
            </Button>
            <Button
              disabled={pending || !op.receipt_lookup_supported}
              onClick={() => act("recover")}
            >
              Recover receipt
            </Button>
          </Toolbar>
          {!op.receipt_lookup_supported && (
            <p className="wg-hint">This method has no receipt lookup. Recovery is unavailable.</p>
          )}
          {(op.state.kind === "rejected" || op.state.kind === "outcome_unknown") && (
            <p role="alert" className="wg-error">
              {op.state.problem.kind}: {op.state.problem.message}
            </p>
          )}
          {op.diagnostic && (
            <p className="wg-hint">
              {op.diagnostic.kind}: {op.diagnostic.message}
            </p>
          )}
          <Disclosure title="Exact saved JSON request">
            <JsonView
              processing={processing}
              value={op.request}
              label="Saved request JSON (decoded)"
              identity={`${op.operation_id}-request`}
            />
          </Disclosure>
          {(op.state.kind === "committed" || op.state.kind === "observed") && (
            <JsonView
              processing={processing}
              value={op.state.response.data}
              label="Operation response (decoded JSON)"
              identity={`${op.operation_id}-${op.revision}`}
            />
          )}
        </>
      )}
    </Panel>
  );
}
export function AdvancedFeature({ context, operations, controller }: AdvancedFeatureProps) {
  const processing = context.client.processing;
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get);
  const [mode, setMode] = useState<"home" | "method" | "draft" | "helper" | "saved">(() =>
      controller.get().activeDraftId === null ? "home" : "draft",
    ),
    [savedId, setSavedId] = useState<Identifier | null>(null),
    [savedLimit, setSavedLimit] = useState(20),
    [section, setSection] = useState<"methods" | "helpers" | "host" | "saved">("methods"),
    [guideOpen, setGuideOpen] = useState(false),
    [fillingDraftId, setFillingDraftId] = useState<Identifier | null>(null),
    [effect, setEffect] = useState("all"),
    [query, setQuery] = useState(""),
    [family, setFamily] = useState("all"),
    [helper, setHelper] = useState<DiscoveryEntry | HostSurface | null>(null),
    [editor, setEditor] = useState<"form" | "raw">("form"),
    [unexpected, setUnexpected] = useState<{ owner: object; error: unknown } | null>(null);
  const catalog =
    state.catalog.kind === "ready"
      ? state.catalog.value
      : state.catalog.kind === "loading" || state.catalog.kind === "failed"
        ? state.catalog.previous
        : undefined;
  const draft = state.drafts.find((d) => d.id === state.activeDraftId),
    contract = state.contract.kind === "ready" ? state.contract.value : null,
    entry = draft ? operations.get(draft.id) : undefined;
  const params: InputResult<JsonObject> =
    draft?.parameters.kind === "ready"
      ? { ok: true, value: draft.parameters.value.params }
      : {
          ok: false,
          message:
            draft?.parameters.kind === "failed"
              ? draft.parameters.message
              : "Parameter decoding is in progress.",
        };
  const staged = draft ? Object.keys(draft.fieldEdits).length : 0;
  const saved = operations.list().slice().reverse(),
    savedEntry = savedId === null ? undefined : operations.get(savedId);
  const viewOwner = useMemo(
    () => ({
      mode,
      active: state.activeDraftId,
      method: state.selectedMethod,
      helper,
      source: draft?.source,
      edits: draft?.fieldEdits,
      parameters: draft?.parameters,
      reading: draft?.reading,
      preparing: draft?.preparing,
    }),
    [
      mode,
      state.activeDraftId,
      state.selectedMethod,
      helper,
      draft?.source,
      draft?.fieldEdits,
      draft?.parameters,
      draft?.reading,
      draft?.preparing,
    ],
  );
  const launch = (task: Promise<unknown>) => {
    const owner = viewOwner;
    void task.catch((error: unknown) => setUnexpected({ owner, error }));
  };
  useEffect(() => {
    if (controller.get().catalog.kind === "idle")
      void controller
        .loadCatalog()
        .catch((error: unknown) => setUnexpected({ owner: viewOwner, error }));
  }, [controller, viewOwner]);
  if (unexpected?.owner === viewOwner) throw unexpected.error;
  if (state.catalog.kind === "unexpected_error") throw state.catalog.error;
  if (draft?.parameters.kind === "unexpected_error") throw draft.parameters.error;
  if (draft?.preparationError) throw draft.preparationError.error;
  const matches = (name: string, summary: string) =>
    `${name} ${summary}`.toLowerCase().includes(query.toLowerCase());
  const methods = (catalog?.methods ?? []).filter(
    (m) =>
      (family === "all" || (m.name.includes(".") ? m.name.split(".")[0] : "general") === family) &&
      (effect === "all" || (effect === "read" ? m.mode === "read" : m.mode !== "read")) &&
      matches(m.name, m.summary),
  );
  const groups = new Map<string, typeof methods>();
  for (const method of methods) {
    const group = method.name.includes(".") ? (method.name.split(".")[0] ?? "general") : "general";
    const items = groups.get(group) ?? [];
    items.push(method);
    groups.set(group, items);
  }
  const visibleSaved = saved.filter((e) =>
    matches(
      e.preparation.method,
      `${e.preparation.intention_id} ${e.preparation.context.writer.actor_id}`,
    ),
  );
  const switchSection = (next: typeof section) => {
    setSection(next);
    setQuery("");
    setMode("home");
  };
  return (
    <div className="adv-root">
      <header className="adv-top">
        <div>
          <p className="adv-eyebrow">
            <Icon name="advanced" /> Explore, inspect and recover
          </p>
          <h1>Advanced</h1>
          <p>Find an operation, prepare its inputs, and understand exactly what it will do.</p>
        </div>
        <div>
          <Button tone="quiet" onClick={() => setGuideOpen(true)}>
            How Advanced works
          </Button>
          <Badge>
            {catalog
              ? `${catalog.methods.length} methods · ${catalog.helpers.length + catalog.workflows.length + HOST_SURFACES.length} helper / host surfaces`
              : "Executable catalogue"}
          </Badge>
          <Button onClick={() => launch(controller.loadCatalog())}>Refresh catalogue</Button>
        </div>
      </header>
      <nav className="adv-section-nav" aria-label="Catalogue kind">
        {(["methods", "helpers", "host", "saved"] as const).map((kind) => (
          <Button
            key={kind}
            aria-pressed={section === kind}
            data-tone={EXPLORER_SECTIONS[kind].tone}
            onClick={() => switchSection(kind)}
          >
            <Icon name={EXPLORER_SECTIONS[kind].icon} />
            {kind === "saved" ? `Saved (${saved.length})` : EXPLORER_SECTIONS[kind].title}
          </Button>
        ))}
      </nav>
      <div className="adv-section-intro" data-tone={EXPLORER_SECTIONS[section].tone}>
        <Icon name={EXPLORER_SECTIONS[section].icon} />
        <div>
          <h2>{EXPLORER_SECTIONS[section].title}</h2>
          <p>{EXPLORER_SECTIONS[section].description}</p>
        </div>
      </div>
      <div className={`adv-layout${mode === "home" ? " adv-landing" : ""}`}>
        <aside className="adv-sidebar" aria-label="API catalogue">
          <h2 className="adv-module-heading">
            <Icon name={EXPLORER_SECTIONS[section].icon} />
            {section === "methods" ? "Method explorer" : EXPLORER_SECTIONS[section].title}
          </h2>
          <Field
            label="Search catalogue"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={
              section === "saved" ? "Method, request ID or author" : "Search by name or purpose"
            }
          />
          <State state={state.catalog} label="Catalogue" />
          {section === "methods" && (
            <>
              <Select
                label="Method family"
                value={family}
                onChange={(event) => setFamily(event.currentTarget.value)}
              >
                <option value="all">All families</option>
                {[
                  ...new Set(
                    (catalog?.methods ?? []).map((m) =>
                      m.name.includes(".") ? (m.name.split(".")[0] ?? "general") : "general",
                    ),
                  ),
                ]
                  .sort()
                  .map((group) => (
                    <option key={group}>{group}</option>
                  ))}
              </Select>
              <Select
                label="Operation type"
                value={effect}
                onChange={(event) => setEffect(event.currentTarget.value)}
              >
                <option value="all">Reads and writes</option>
                <option value="read">Read-only operations</option>
                <option value="write">Operations that can write</option>
              </Select>
              {[...groups].map(([group, items]) => (
                <section className="adv-group" key={group}>
                  <h3>
                    {group}
                    <span>{items.length}</span>
                  </h3>
                  {items.map((method) => (
                    <button
                      type="button"
                      className={`adv-item ${state.selectedMethod === method.name && mode === "method" ? "is-active" : ""}`}
                      key={method.name}
                      onClick={() => {
                        setMode("method");
                        launch(controller.selectMethod(method.name));
                      }}
                    >
                      <span>
                        <code>{method.name}</code>
                        <small
                          className="adv-mode-badge"
                          data-effect={method.mode === "read" ? "read" : "write"}
                        >
                          {method.mode === "read" ? "Read" : "Write"}
                        </small>
                      </span>
                      <p>{method.summary}</p>
                    </button>
                  ))}
                </section>
              ))}
            </>
          )}
          {section === "helpers" &&
            [...(catalog?.helpers ?? []), ...(catalog?.workflows ?? [])]
              .filter((e) => matches(e.name, `${e.summary} ${e.search_terms.join(" ")}`))
              .map((e) => (
                <button
                  type="button"
                  className={`adv-item ${helper === e && mode === "helper" ? "is-active" : ""}`}
                  key={e.name}
                  onClick={() => {
                    setHelper(e);
                    setMode("helper");
                  }}
                >
                  <span>
                    <code>{e.name}</code>
                    <small>{e.kind}</small>
                  </span>
                  <p>{e.summary}</p>
                </button>
              ))}
          {section === "host" &&
            HOST_SURFACES.filter((e) => matches(e.name, e.summary)).map((e) => (
              <button
                type="button"
                className={`adv-item ${helper === e && mode === "helper" ? "is-active" : ""}`}
                key={e.name}
                onClick={() => {
                  setHelper(e);
                  setMode("helper");
                }}
              >
                <code>{e.name}</code>
                <p>{e.summary}</p>
              </button>
            ))}
          {catalog && section === "methods" && methods.length === 0 && (
            <p className="wg-hint">No matching methods. Try another family or phrase.</p>
          )}
          {section === "saved" && (
            <section className="adv-saved" aria-label="Saved intentions">
              <h3>
                Saved intentions <span>{saved.length}</span>
              </h3>
              <p className="wg-hint">
                A saved request, also called an intention, retains its original writer and inputs
                across navigation. Only native-prepared operations have durable journals; unprepared
                captures do not survive reload.
              </p>
              {visibleSaved.slice(0, savedLimit).map((e) => (
                <button
                  type="button"
                  className="adv-item"
                  key={e.preparation.intention_id}
                  onClick={() => {
                    setSavedId(e.preparation.intention_id);
                    setMode("saved");
                  }}
                >
                  <span>
                    <code>{e.preparation.method}</code>
                    <small>
                      {e.phase.kind === "unconfirmed"
                        ? "unconfirmed"
                        : (e.operation?.state.kind ?? e.phase.kind)}
                    </small>
                  </span>
                  <p>
                    {e.preparation.intention_id} · {e.preparation.context.writer.actor_id}
                  </p>
                </button>
              ))}
              {visibleSaved.length > savedLimit && (
                <Button onClick={() => setSavedLimit((n) => n + 20)}>
                  Show more saved intentions
                </Button>
              )}
              {visibleSaved.length === 0 && (
                <p className="wg-hint">
                  {saved.length === 0
                    ? "No saved requests yet. Preparing a write adds it here; nothing is sent until you execute it."
                    : "No matching saved requests. Try another method or author."}
                </p>
              )}
            </section>
          )}
          {section === "helpers" &&
            catalog &&
            ![...catalog.helpers, ...catalog.workflows].some((e) =>
              matches(e.name, `${e.summary} ${e.search_terms.join(" ")}`),
            ) && (
              <p className="wg-hint">No matching guides. Try a task such as upload or planning.</p>
            )}
          {section === "host" && !HOST_SURFACES.some((e) => matches(e.name, e.summary)) && (
            <p className="wg-hint">
              No matching host tools. Clear the search to browse the available commands.
            </p>
          )}
          {query && (
            <Button tone="quiet" onClick={() => setQuery("")}>
              Clear search
            </Button>
          )}
          <details className="adv-capabilities">
            <summary>Feature categories</summary>
            {catalog?.capabilities.map((c) => (
              <div key={c.id}>
                <strong>{c.title}</strong>
                <p className="wg-hint">{c.summary}</p>
                <code>{c.groups.join(", ")}</code>
              </div>
            ))}
          </details>
        </aside>
        <div className="adv-main">
          {(mode !== "home" || state.drafts.length > 0) && (
            <nav aria-label="Advanced drafts" className="adv-drafts">
              <Button onClick={() => setMode("home")}>
                <Icon name="chevron" />
                Explorer
              </Button>
              <Button
                disabled={state.selectedMethod === null}
                aria-pressed={mode === "method"}
                onClick={() => setMode("method")}
              >
                Method contract
              </Button>
              {state.drafts.map((d) => (
                <Button
                  key={d.id}
                  aria-pressed={mode === "draft" && d.id === draft?.id}
                  onClick={() => {
                    controller.selectDraft(d.id);
                    setMode("draft");
                  }}
                >
                  {d.contract.method.name} · {d.locked ? "saved" : "draft"}
                  <span className="adv-shortid"> {d.id.slice(-6)}</span>
                </Button>
              ))}
            </nav>
          )}
          {state.notice && (
            <p role="status" className="adv-notice">
              {state.notice}
            </p>
          )}
          {mode === "home" ? (
            <section className="adv-hub" aria-label="Recovery and host tools">
              <div className="adv-start">
                <span className="adv-section-kicker">
                  <Icon name="advanced" /> Start here
                </span>
                <h2>Go beyond the everyday views</h2>
                <p>
                  Choose a method from the explorer, or use a shortcut below. A method is a single
                  API operation; its inputs tell Workgraph what to read or change.
                </p>
                <ol>
                  <li>
                    <b>Choose</b>
                    <span>Read its purpose and examples.</span>
                  </li>
                  <li>
                    <b>Prepare</b>
                    <span>Create a draft and fill the inputs.</span>
                  </li>
                  <li>
                    <b>Review</b>
                    <span>Run a read, or prepare and explicitly execute a write.</span>
                  </li>
                </ol>
              </div>
              <h2 className="adv-module-heading">Recovery & host tools</h2>
              <div className="adv-hub-links">
                <Button
                  onClick={() => {
                    switchSection("saved");
                  }}
                >
                  <Icon name="refresh" />
                  <span>
                    <strong>Saved intentions</strong>
                    <small>
                      Inspect captured requests, outcomes and exact retries in this browser session.
                    </small>
                  </span>
                  <Icon name="chevron" />
                </Button>
                <Button onClick={() => context.navigate(changeView(context.route, "overview"))}>
                  <Icon name="connection" />
                  <span>
                    <strong>Workspace & daemon management</strong>
                    <small>
                      Open Overview, then Manage Workspace or Manage Project for lifecycle and
                      maintenance tools.
                    </small>
                  </span>
                  <Icon name="chevron" />
                </Button>
                <Button onClick={() => context.navigate(changeView(context.route, "resources"))}>
                  <Icon name="resources" />
                  <span>
                    <strong>Resource transfers</strong>
                    <small>Browse publications, upload files and inspect transfer progress.</small>
                  </span>
                  <Icon name="chevron" />
                </Button>
                <Button
                  onClick={() => {
                    switchSection("helpers");
                  }}
                >
                  <Icon name="advanced" />
                  <span>
                    <strong>CLI helpers & recipes</strong>
                    <small>
                      Discover guided workflows and copy host commands. No shell commands run in the
                      browser.
                    </small>
                  </span>
                  <Icon name="chevron" />
                </Button>
              </div>
              <p className="adv-hub-note">
                Select a method to read its contract. Capture a draft, review its exact destination
                and parameters, then explicitly read or execute. Existing intentions retain their
                original author and connection.
              </p>
            </section>
          ) : mode === "saved" && savedEntry ? (
            <OperationView
              processing={processing}
              entry={savedEntry}
              act={(action) => launch(controller.act(savedEntry.preparation.intention_id, action))}
            />
          ) : mode === "helper" && helper ? (
            <Helper entry={helper} />
          ) : mode === "method" ? (
            <>
              <State state={state.contract} label="Method contract" />
              {contract ? (
                <>
                  <MethodHelp contract={contract} processing={processing} />
                  <Panel title="Capture a draft">
                    <p>
                      Create an editable request attached to the current connection and actor. You
                      will fill its inputs next. Opening a draft does not send a request or change
                      workspace data.
                    </p>
                    <p className="wg-hint">
                      {context.connection.label} · generation {context.connection.generation} ·
                      writer {context.writer.actorId ?? "not selected"} · run{" "}
                      {context.writer.runId ?? "none"}
                    </p>
                    <Button
                      requiresActor={contract.method.mode !== "read"}
                      tone="primary"
                      disabled={context.profileState !== "current"}
                      onClick={() => {
                        if (controller.createDraft(context)) setMode("draft");
                      }}
                    >
                      New draft for {contract.method.name}
                    </Button>
                    {context.profileState !== "current" && (
                      <p className="wg-hint">
                        The connection directory is {context.profileState}; refresh it before
                        capturing a new draft.
                      </p>
                    )}
                  </Panel>
                </>
              ) : state.contract.kind === "idle" ? (
                <StatePanel kind="empty" title="Choose a method">
                  The catalogue comes from the current executable. Schemas load only for the
                  selected method.
                </StatePanel>
              ) : null}
            </>
          ) : draft ? (
            <>
              <MethodHelp contract={draft.contract} processing={processing} />
              <Panel
                title="1 · Destination and author"
                actions={<Badge>{draft.locked ? "Immutable intention" : "Editable draft"}</Badge>}
              >
                <div className="adv-context">
                  <div>
                    <small>Connection</small>
                    <strong>{draft.selection.connection.label}</strong>
                    <code>
                      {draft.selection.connection.id} / {draft.selection.connection.generation}
                    </code>
                  </div>
                  <div>
                    <small>Draft selection: workspace / project</small>
                    <strong>
                      {draft.selection.workspaceId ?? "none"} /{" "}
                      {draft.selection.projectId ?? "none"}
                    </strong>
                  </div>
                  <div>
                    <small>Author / run</small>
                    <strong>
                      <ActorAvatar actor={draft.selection.actorId} />
                      {draft.selection.actorId ?? "not selected"} /{" "}
                      {draft.selection.runId ?? "none"}
                    </strong>
                  </div>
                </div>
                <p className="wg-hint">
                  Selection changes do not retarget this draft. Method targets remain explicit in
                  parameters. Create a new draft to use another connection or writer.
                </p>
                <Toolbar label="Draft actions">
                  <Button
                    onClick={() => {
                      if (controller.cloneDraft(draft.id)) setMode("draft");
                    }}
                  >
                    Clone captured draft
                  </Button>
                  <Button
                    disabled={draft.preparing}
                    onClick={() => {
                      if (!controller.discardDraft(draft.id)) return;
                      if (entry) {
                        setSavedId(draft.id);
                        setSection("saved");
                        setMode("saved");
                      } else {
                        setMode(controller.get().activeDraftId === null ? "home" : "draft");
                      }
                    }}
                  >
                    {entry ? "Close editor; keep saved intention" : "Discard unsent draft"}
                  </Button>
                </Toolbar>
              </Panel>
              <Panel
                title="2 · Request inputs"
                actions={
                  <Toolbar label="Parameter editor">
                    <Button aria-pressed={editor === "form"} onClick={() => setEditor("form")}>
                      Form
                    </Button>
                    <Button aria-pressed={editor === "raw"} onClick={() => setEditor("raw")}>
                      Raw JSON
                    </Button>
                  </Toolbar>
                }
              >
                <p className="wg-hint">
                  The form shows the fields supported by this method. Use its descriptions to choose
                  inputs; validation checks their combined meaning before a write is sent.
                </p>
                <p className="wg-hint">
                  Choose “Provide a value” to fill a field, then Apply to save it into this draft.
                  “Do not send” leaves the field out; null sends an explicitly empty value when the
                  method supports it. Neither is the same as an empty string. Exact numbers are
                  preserved. Nothing is executed automatically.
                </p>
                {staged > 0 && (
                  <div className="adv-notice" role="status">
                    {staged} staged field edit(s) remain unapplied. They survive navigation. Apply
                    each field in Form or explicitly discard them before submitting or editing raw
                    source.{" "}
                    <Button onClick={() => controller.discardFieldEdits(draft.id)}>
                      Discard staged field edits
                    </Button>
                  </div>
                )}
                {editor === "raw" ? (
                  <label className="adv-raw-label">
                    Exact parameter source
                    <textarea
                      className="adv-raw"
                      aria-label="Exact parameter source"
                      spellCheck={false}
                      value={draft.source}
                      disabled={
                        draft.locked || draft.preparing || staged > 0 || fillingDraftId === draft.id
                      }
                      onChange={(event) =>
                        controller.editSource(draft.id, event.currentTarget.value)
                      }
                    />
                  </label>
                ) : (
                  <>
                    <Button
                      disabled={
                        draft.locked ||
                        draft.preparing ||
                        staged > 0 ||
                        !params.ok ||
                        fillingDraftId === draft.id
                      }
                      onClick={() => {
                        const id = draft.id;
                        setFillingDraftId(id);
                        launch(
                          controller
                            .fillScopeFields(id)
                            .finally(() =>
                              setFillingDraftId((current) => (current === id ? null : current)),
                            ),
                        );
                      }}
                    >
                      {fillingDraftId === draft.id
                        ? "Filling captured fields…"
                        : "Fill scope fields from captured context"}
                    </Button>
                    <p className="wg-hint">
                      Fills declared workspace, project, actor and run fields from this draft’s
                      original selection, replacing any values already entered. Missing selections
                      remove those fields. The daemon supplies the request’s retry identity when
                      omitted.
                    </p>
                    <>
                      <div className="adv-fields-heading">
                        <Icon name="work" />
                        <div>
                          <h3>Required inputs</h3>
                          <p>Start with the fields every request needs.</p>
                        </div>
                      </div>
                      {draft.contract.fields.fields
                        .filter((field) => field.requirement === "required")
                        .map((field) => (
                          <FormField
                            key={JSON.stringify([draft.id, field.name])}
                            context={context}
                            busy={fillingDraftId === draft.id || !params.ok}
                            field={field}
                            draft={draft}
                            params={params}
                            onStage={(name, input) => controller.stageField(draft.id, name, input)}
                            onApply={(name) => launch(controller.applyField(draft.id, name))}
                          />
                        ))}
                      {draft.contract.fields.fields.some(
                        (field) => field.requirement !== "required",
                      ) && (
                        <Disclosure
                          key={`${draft.id}-optional`}
                          title="Optional and conditional inputs"
                        >
                          <p className="wg-hint">
                            Optional fields refine the request. Conditional fields may be required
                            by another choice; read their descriptions. Leave a field out to use the
                            method’s documented behavior.
                          </p>
                          {draft.contract.fields.fields
                            .filter((field) => field.requirement !== "required")
                            .map((field) => (
                              <FormField
                                key={JSON.stringify([draft.id, field.name])}
                                context={context}
                                busy={fillingDraftId === draft.id || !params.ok}
                                field={field}
                                draft={draft}
                                params={params}
                                onStage={(name, input) =>
                                  controller.stageField(draft.id, name, input)
                                }
                                onApply={(name) => launch(controller.applyField(draft.id, name))}
                              />
                            ))}
                        </Disclosure>
                      )}
                    </>
                  </>
                )}
                {!params.ok && (
                  <div>
                    <p
                      role={draft.parameters.kind === "loading" ? "status" : "alert"}
                      className={draft.parameters.kind === "loading" ? "wg-hint" : "wg-error"}
                    >
                      {params.message}
                    </p>
                    {draft.parameters.kind === "failed" && (
                      <Button onClick={() => launch(controller.validateParameters(draft.id))}>
                        Retry parameter validation
                      </Button>
                    )}
                  </div>
                )}
                {draft.contract.method.mode === "read" ? (
                  <>
                    <Disclosure title="Read scheduling (optional)">
                      <p className="wg-hint">
                        Choose how the UI schedules this query. Visible is appropriate for ordinary
                        reads; History, Search and Wait separate longer-running requests. This does
                        not change the method or its inputs.
                      </p>
                      <Select
                        label="Read lane"
                        value={draft.lane}
                        onChange={(event) =>
                          controller.setLane(
                            draft.id,
                            event.currentTarget.value as AdvancedDraft["lane"],
                          )
                        }
                      >
                        <option value="visible">Visible</option>
                        <option value="history">History</option>
                        <option value="search">Search</option>
                        <option value="wait">Wait</option>
                      </Select>
                    </Disclosure>
                    <Toolbar label="Read actions">
                      <Button
                        tone="primary"
                        disabled={
                          draft.reading || !params.ok || staged > 0 || fillingDraftId === draft.id
                        }
                        onClick={() => launch(controller.runRead(draft.id))}
                      >
                        Run read
                      </Button>
                      <Button
                        disabled={!draft.reading}
                        onClick={() => controller.cancelRead(draft.id)}
                      >
                        Cancel read
                      </Button>
                    </Toolbar>
                  </>
                ) : !entry ? (
                  <Button
                    tone="primary"
                    disabled={
                      staged > 0 || !params.ok || draft.preparing || fillingDraftId === draft.id
                    }
                    onClick={() => launch(controller.prepare(draft.id))}
                  >
                    Validate & prepare
                  </Button>
                ) : null}
              </Panel>
              {draft.contract.method.mode === "read" ? (
                <Panel title="3 · Read result">
                  <State state={draft.read} label="Read" />
                  {draft.read.kind === "ready" ? (
                    <>
                      <JsonView
                        processing={processing}
                        value={draft.read.value.response.data}
                        label="Read response (decoded JSON)"
                        identity={draft.read.key}
                      />
                      <Disclosure title="Response metadata / exact pagination">
                        <JsonView
                          processing={processing}
                          value={draft.read.value.response.meta}
                          label="Response metadata"
                          identity={`${draft.read.key}-meta`}
                        />
                        {draft.read.value.pagination && (
                          <JsonView
                            processing={processing}
                            value={draft.read.value.pagination}
                            label="Exact pagination"
                            identity={`${draft.read.key}-pagination`}
                          />
                        )}
                      </Disclosure>
                      <Toolbar label="Exact continuation">
                        <Button
                          disabled={
                            !catalog ||
                            continuation(draft.read.value, "next_request", catalog) === null
                          }
                          onClick={() => launch(controller.continueRead(draft.id, "next_request"))}
                        >
                          Follow next request
                        </Button>
                        <Button
                          disabled={
                            !catalog ||
                            continuation(draft.read.value, "retry_request", catalog) === null
                          }
                          onClick={() => launch(controller.continueRead(draft.id, "retry_request"))}
                        >
                          Follow retry request
                        </Button>
                      </Toolbar>
                      <p className="wg-hint">
                        Only the exact native Read continuation is followed on this captured
                        connection. Each response replaces this observation; no inferred merging or
                        automatic pagination.
                      </p>
                    </>
                  ) : (draft.read.kind === "loading" || draft.read.kind === "failed") &&
                    draft.read.previous !== undefined ? (
                    <>
                      <p className="wg-hint">
                        Previous successful observation for this exact query. The refresh state is
                        shown above.
                      </p>
                      <JsonView
                        processing={processing}
                        value={draft.read.previous.response.data}
                        label="Previous read response (decoded JSON)"
                        identity={`${draft.read.key}-previous`}
                      />
                    </>
                  ) : draft.read.kind === "idle" ? (
                    <p className="wg-hint">
                      No result yet. Fill and apply the inputs above, then choose Run read. This
                      contacts the captured daemon and displays one response; it does not
                      continuously refresh.
                    </p>
                  ) : null}
                </Panel>
              ) : entry ? (
                <OperationView
                  processing={processing}
                  entry={entry}
                  act={(action) => launch(controller.act(draft.id, action))}
                />
              ) : null}
            </>
          ) : (
            <StatePanel kind="empty" title="No active draft">
              Choose a method and create a draft.
            </StatePanel>
          )}
        </div>
      </div>
      {guideOpen && (
        <Dialog
          title="How Advanced works"
          description="A guided route through methods, drafts and saved requests."
          wide
          onClose={() => setGuideOpen(false)}
        >
          <AdvancedGuide />
        </Dialog>
      )}
    </div>
  );
}
