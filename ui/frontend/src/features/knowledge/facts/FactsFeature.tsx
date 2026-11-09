import { ManagementPresentation } from "../../connections/management-presentation";
import { FactChoice, FactSection, FactsGuide } from "./FactDesign";
import { Dialog } from "../../../components/Dialog";
import { Icon } from "../../../components/Icon";
import { ActorAvatar } from "../../../components/ActorAvatar";
import { RecordedTime } from "../../discussions/RecordedTime";
import { FactStructure } from "./FactStructure";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Badge, Button, Field, Panel, Select, Toolbar } from "../../../components/Primitives";
import type { ReadState } from "../../../core/state/read-slot";
import { failureText } from "../../connections/failure";
import { JsonView, LazyDetails, OperationPanel } from "../../connections/shared";
import { FactInputError, identifier, parseValue, targetKey } from "./model";
import { factRoute } from "./navigation";
import { canonicalJson } from "../../../core/json";
import { VALUE_LIMITS } from "./codecs";
import type {
  FactCapture,
  FactDraft,
  FactObservation,
  FactPredicate,
  FactReference,
  FactScope,
  FactsFeatureProps,
  FactsState,
} from "./types";
import { ValueEditor } from "./ValueEditor";
import "./facts.css";

function Read<T>({
  state,
  children,
}: {
  readonly state: ReadState<T>;
  readonly children: (value: T) => ReactNode;
}) {
  if (state.kind === "unexpected_error") throw state.error;
  const value =
    state.kind === "ready" ? state.value : state.kind === "idle" ? undefined : state.previous;
  return (
    <>
      {state.kind === "failed" && (
        <p role="alert">
          {failureText(state.failure)}
          {value !== undefined ? " Previous capture retained." : ""}
        </p>
      )}
      {state.kind === "loading" && value === undefined && (
        <p role="status">Reading captured facts…</p>
      )}
      {value !== undefined && children(value)}
    </>
  );
}
function ScopeName({ scope }: { readonly scope: FactScope }) {
  return (
    <>
      {scope.kind}
      {scope.kind !== "workspace" && (
        <>
          {" "}
          <code>{scope.id}</code>
        </>
      )}
    </>
  );
}
function Summary({ fact }: { readonly fact: FactObservation }) {
  if (fact.kind === "missing") return <Badge>Missing</Badge>;
  if (fact.kind === "deleted")
    return <Badge tone="warning">Deleted · revision {fact.revision}</Badge>;
  return (
    <Badge>
      {fact.valueType} · revision {fact.revision}
    </Badge>
  );
}
function FactValue({
  capture,
  processing,
  identity,
  renderValue,
}: {
  readonly renderValue?: FactsFeatureProps["renderValue"];
  readonly capture: FactCapture<FactObservation>;
  readonly processing: FactsFeatureProps["context"]["client"]["processing"];
  readonly identity: string;
}) {
  const fact = capture.value;
  const [mode, setMode] = useState<"structure" | "json">("structure");
  const generic = (
    <>
      <Toolbar label="Fact value presentation">
        <Button aria-pressed={mode === "structure"} onClick={() => setMode("structure")}>
          Structure
        </Button>
        <Button aria-pressed={mode === "json"} onClick={() => setMode("json")}>
          JSON
        </Button>
      </Toolbar>
      {mode === "structure" && fact.kind === "value" ? (
        <FactStructure value={fact.value} />
      ) : (
        <JsonView
          value={fact.kind === "value" ? fact.value : { kind: "null" }}
          label={`Fact ${fact.key}`}
          identity={identity}
          processing={processing}
        />
      )}
    </>
  );
  return (
    <>
      {fact.kind === "missing" ? (
        <p>This key has not been created here yet.</p>
      ) : fact.kind === "deleted" ? (
        <p>
          This fact was deleted. Its earlier values and related links are still available in
          History. Edit it to save a new current value.
        </p>
      ) : renderValue ? (
        renderValue(capture, generic)
      ) : (
        generic
      )}
      {capture.partial && (
        <p role="alert">
          Some information was not returned. Refresh this fact before relying on its complete value.
        </p>
      )}
    </>
  );
}
function ReferenceFields({
  draft,
  change,
  context,
}: {
  readonly context: FactsFeatureProps["context"];
  readonly draft: FactDraft;
  readonly change: (input: FactDraft["input"]) => void;
}) {
  const refs = draft.input.references,
    disabled = draft.phase.kind !== "editing",
    existing = draft.base.value.kind === "missing" ? [] : draft.base.value.references;
  const replace = (
    items: readonly { readonly kind: "ticket" | "resource"; readonly id: string }[],
  ) => change({ ...draft.input, references: { kind: "replace", items } });
  return (
    <fieldset disabled={disabled} className="fact-reference-editor">
      <legend>Related tickets and resources</legend>
      {refs.kind === "preserve" ? (
        <>
          <p>
            Keep the existing links. Add a ticket or resource when it helps explain where this fact
            came from or what it relates to.
          </p>
          <Button onClick={() => replace(existing)}>Edit references</Button>
        </>
      ) : (
        <>
          <p className="wg-hint">
            Links point to the current ticket or resource, not a frozen version. Removing a link
            does not delete the linked record.
          </p>
          {refs.items.map((ref, index) => (
            <div className="fact-inline" key={index}>
              <Select
                label={`Reference ${index + 1} kind`}
                value={ref.kind}
                onChange={(event) =>
                  replace(
                    refs.items.map((r, i) =>
                      i === index
                        ? {
                            ...r,
                            kind: event.currentTarget.value === "ticket" ? "ticket" : "resource",
                            id: "",
                          }
                        : r,
                    ),
                  )
                }
              >
                <option value="ticket">Ticket</option>
                <option value="resource">Resource</option>
              </Select>
              <FactChoice
                context={context}
                target={draft.target}
                kind={ref.kind}
                label={`Reference ${index + 1} ID`}
                value={ref.id}
                disabled={disabled}
                onChange={(id) =>
                  replace(refs.items.map((r, i) => (i === index ? { ...r, id } : r)))
                }
              />
              <Button onClick={() => replace(refs.items.filter((_, i) => i !== index))}>
                Remove reference {index + 1}
              </Button>
            </div>
          ))}
          <Toolbar label="Fact reference controls">
            <Button
              disabled={refs.items.length >= 32}
              onClick={() => replace([...refs.items, { kind: "ticket", id: "" }])}
            >
              Add reference
            </Button>
            <Button onClick={() => replace([])}>Clear all references</Button>
            <Button onClick={() => change({ ...draft.input, references: { kind: "preserve" } })}>
              Keep existing references instead
            </Button>
          </Toolbar>
        </>
      )}
    </fieldset>
  );
}
function Draft({ draft, props }: { readonly draft: FactDraft; readonly props: FactsFeatureProps }) {
  const [blocked, setBlocked] = useState(false),
    { controller, context, operations } = props;
  if (draft.unexpected !== null) throw draft.unexpected.error;
  return (
    <div className="fact-draft">
      <div className="fact-draft-owner">
        <ActorAvatar actor={draft.writer.actorId} />
        <span>
          Saving as <strong>{draft.writer.actorId}</strong>
        </span>
        <Badge>
          <ScopeName scope={draft.target.scope} />
        </Badge>
        <span>{draft.target.connection.label}</span>
      </div>
      <p className="fact-lead">
        {draft.method === "fact.delete"
          ? "Delete the current value without erasing its history. Review the deletion, then apply it when you are ready."
          : draft.base.value.kind === "missing"
            ? "Create a small piece of shared context. Choose a value type, fill in the value, then review and apply your change."
            : "Edit this fact’s complete value. Fields you leave unchanged are kept. Review validates the draft; only applying the reviewed action changes the shared fact."}
      </p>
      <p className="wg-hint">
        Based on{" "}
        {draft.base.value.kind === "missing"
          ? "a confirmed missing key"
          : `version ${draft.base.value.revision}`}
        . If another writer changes it first, your save will be rejected instead of overwriting
        their work. Closing this editor keeps the draft in this UI session.
      </p>
      {draft.method === "fact.put" ? (
        <>
          <FactSection
            title="1 · Set the value"
            description="Choose text, a number, a true/false switch, named fields or a list. The form handles JSON syntax for you."
            tone="purple"
          >
            <ValueEditor
              source={draft.input.source}
              candidate={draft.input.structured}
              onCandidate={(structured) =>
                controller.edit(draft.id, { ...draft.input, structured })
              }
              onEncoded={(source, structured) => {
                const current = controller.get().drafts.find((d) => d.id === draft.id);
                if (current?.input.structured === structured && current.input.source !== source)
                  controller.edit(draft.id, { ...current.input, source, structured });
              }}
              onChange={(source) =>
                controller.edit(draft.id, { source, references: draft.input.references })
              }
              processing={context.client.processing}
              disabled={draft.phase.kind !== "editing"}
              onBlocked={setBlocked}
            />
          </FactSection>
          <FactSection
            title="2 · Add context (optional)"
            description="Connect this fact to the work or supporting material it describes."
            icon="resources"
          >
            <ReferenceFields
              context={context}
              draft={draft}
              change={(input) => controller.edit(draft.id, input)}
            />
          </FactSection>
        </>
      ) : (
        <p className="fact-delete-note">
          The key will be marked deleted and hidden from the normal list. Include deleted keys in
          filters to find it later. Earlier versions and links remain available; restoring creates a
          new version.
        </p>
      )}
      {draft.issue !== null && <p role="alert">{draft.issue}</p>}
      {draft.phase.kind === "editing" && (
        <Toolbar label="Fact draft controls">
          <Button
            tone="primary"
            disabled={blocked && draft.method === "fact.put"}
            onClick={() => void controller.review(draft.id)}
          >
            Review {draft.method === "fact.delete" ? "deletion" : "replacement"}
          </Button>
          <Button onClick={() => controller.discard(draft.id)}>Discard unsent draft</Button>
        </Toolbar>
      )}
      {draft.phase.kind === "validating" && <p role="status">Validating captured replacement…</p>}
      {draft.phase.kind === "registered" && (
        <ManagementPresentation value={true}>
          <OperationPanel
            operations={operations}
            intention={draft.id}
            processing={context.client.processing}
          />
        </ManagementPresentation>
      )}
      <details className="fact-help fact-conflict">
        <summary>Compare with the latest saved value</summary>
        <p>
          Use this after a conflict or when someone else may have edited the fact. Reading the
          latest value does not change your draft. Creating a new draft keeps your local value but
          uses the latest version as its starting point; review it carefully before applying.
        </p>
        <Toolbar label="Fact conflict comparison">
          <Button onClick={() => void controller.compareCurrent(draft.id)}>
            Read current value for comparison
          </Button>
          {draft.current !== null && (
            <Button onClick={() => controller.rebase(draft.id)}>
              Create new draft using latest version
            </Button>
          )}
        </Toolbar>
        {draft.current !== null && (
          <div className="fact-comparison">
            <section>
              <h3>Originally saved value</h3>
              <Summary fact={draft.base.value} />
              <FactValue
                capture={draft.base}
                processing={context.client.processing}
                identity={`${draft.id}-base`}
              />
            </section>
            <section>
              <h3>Your draft (JSON)</h3>
              <pre className="fact-source">{draft.input.source}</pre>
            </section>
            <section>
              <h3>Latest saved value</h3>
              <Summary fact={draft.current.value} />
              <FactValue
                capture={draft.current}
                processing={context.client.processing}
                identity={`${draft.id}-current-${draft.current.revision}`}
              />
            </section>
          </div>
        )}
      </details>
    </div>
  );
}
export function FactsFeature(props: FactsFeatureProps) {
  const { context, controller, selection } = props,
    state = useSyncExternalStore(controller.subscribe, controller.get);
  useEffect(() => controller.select(context, selection), [controller, context, selection]);
  const identity = state.target === null ? "none" : targetKey(state.target);
  return <FactsBody key={identity} props={props} state={state} />;
}
function FactsBody({
  props,
  state,
}: {
  readonly props: FactsFeatureProps;
  readonly state: FactsState;
}) {
  const { context, controller } = props,
    [scopeKind, setScopeKind] = useState<FactScope["kind"]>(
      state.target?.scope.kind ?? "workspace",
    ),
    [scopeId, setScopeId] = useState(
      state.target?.scope.kind === "workspace" ? "" : (state.target?.scope.id ?? ""),
    ),
    [prefix, setPrefix] = useState(state.query.prefix),
    [includeDeleted, setIncludeDeleted] = useState(state.query.includeDeleted),
    [predicates, setPredicates] = useState<
      readonly { readonly pointer: string; readonly scalar: string }[]
    >(() =>
      state.query.predicates.map((predicate) => {
        const encoded = canonicalJson(predicate.equals, VALUE_LIMITS);
        if (!encoded.ok)
          throw new Error("Validated fact filter exceeds its scalar encoding bounds.");
        return { pointer: predicate.pointer, scalar: encoded.value };
      }),
    ),
    [newKey, setNewKey] = useState(""),
    [dialog, setDialog] = useState<
      "filters" | "create" | "history" | "references" | "drafts" | "help" | null
    >(null),
    [listFilter, setListFilter] = useState(""),
    [issue, setIssue] = useState<string | null>(null),
    [filtering, setFiltering] = useState(false),
    [refKind, setRefKind] = useState<FactReference["kind"]>("ticket"),
    [refId, setRefId] = useState(""),
    [unexpected, setUnexpected] = useState<{ readonly error: unknown } | null>(null),
    filterOwner = useRef<AbortController | null>(null);
  useEffect(() => () => filterOwner.current?.abort(), []);
  if (state.unexpected !== null) throw state.unexpected.error;
  if (unexpected !== null) throw unexpected.error;
  const inputFailure = (error: unknown) =>
    error instanceof FactInputError ? setIssue(error.message) : setUnexpected({ error });
  const scopeApply = () => {
    try {
      const target = state.target;
      if (target === null) return;
      context.navigate(
        factRoute({
          ...target,
          key: null,
          scope:
            scopeKind === "workspace"
              ? { kind: "workspace" }
              : { kind: scopeKind, id: identifier(scopeId) },
        }),
      );
      setIssue(null);
      setDialog(null);
    } catch (error) {
      inputFailure(error);
    }
  };
  const openKey = (key: string) => {
    if (state.target === null) return;
    try {
      context.navigate(
        factRoute({
          ...state.target,
          key,
          ...(props.selection?.atRevision === undefined
            ? {}
            : { atRevision: props.selection.atRevision }),
        }),
      );
      setDialog(null);
    } catch (error) {
      inputFailure(error);
    }
  };
  const applyFilters = async () => {
    const before = controller.get().target;
    if (before === null) return;
    filterOwner.current?.abort();
    const owner = new AbortController();
    filterOwner.current = owner;
    setFiltering(true);
    setIssue(null);
    try {
      const captured = { prefix, includeDeleted, rows: predicates.map((row) => ({ ...row })) },
        parsed: FactPredicate[] = [];
      for (const row of captured.rows)
        parsed.push({
          pointer: row.pointer,
          equals: await parseValue(context.client.processing, row.scalar, owner.signal),
        });
      const after = controller.get().target;
      if (
        owner.signal.aborted ||
        filterOwner.current !== owner ||
        after === null ||
        targetKey(before) !== targetKey(after)
      )
        return;
      controller.query({
        prefix: captured.prefix,
        includeDeleted: captured.includeDeleted,
        predicates: parsed,
      });
      setDialog(null);
    } catch (error) {
      if (!owner.signal.aborted) inputFailure(error);
    } finally {
      if (filterOwner.current === owner) {
        filterOwner.current = null;
        setFiltering(false);
      }
    }
  };
  const selectedDraft = state.drafts.find((d) => d.id === state.selectedDraftId),
    current = state.target,
    batched = state.values.kind === "ready" ? state.values.value : undefined,
    valueSizes = new Map(
      batched?.value.items.flatMap((v) =>
        v.kind === "value" ? [[v.key, v.canonicalBytes] as const] : [],
      ) ?? [],
    );
  return (
    <div className="fact-feature" data-selected={state.selectedKey !== null}>
      <header className="fact-topbar">
        <div className="fact-page-heading">
          <h1>
            <Icon name="facts" />
            Facts
          </h1>
          <p>Small pieces of shared knowledge, with a clear history of every change.</p>
        </div>
        <Toolbar label="Fact workspace actions">
          <Button tone="quiet" onClick={() => setDialog("help")}>
            About facts
          </Button>
          <Button tone="quiet" onClick={() => setDialog("filters")}>
            <Icon name="filter" />
            Scope & filters
          </Button>
          <Button tone="quiet" onClick={() => setDialog("references")}>
            <Icon name="search" />
            Find references
          </Button>
          {state.drafts.length > 0 && (
            <Button tone="quiet" onClick={() => setDialog("drafts")}>
              Drafts · {state.drafts.length}
            </Button>
          )}
          <Button tone="quiet" aria-label="Refresh facts" onClick={() => controller.refresh()}>
            <Icon name="refresh" />
          </Button>
          <Button tone="primary" requiresActor onClick={() => setDialog("create")}>
            <Icon name="plus" />
            New or existing fact
          </Button>
        </Toolbar>
      </header>
      {state.historicalGeneration && (
        <p role="alert">
          Viewing a retained endpoint generation. Reads remain on this endpoint; new changes require
          explicitly opening that target.
        </p>
      )}
      {(issue ?? state.issue) !== null && <p role="alert">{issue ?? state.issue}</p>}
      <div className="fact-split">
        <aside className="fact-directory" aria-label="Fact key directory">
          <h2 className="fact-directory-title">
            <Icon name="list" />
            Fact library
          </h2>
          <Field
            label="Filter loaded keys"
            placeholder="Find a key on this page…"
            value={listFilter}
            onChange={(event) => setListFilter(event.currentTarget.value)}
          />
          {current !== null && (
            <p className="fact-scope-label">
              <ScopeName scope={current.scope} />
            </p>
          )}
          {(state.query.prefix ||
            state.query.includeDeleted ||
            state.query.predicates.length > 0) && (
            <p className="fact-filter-summary">
              {state.query.prefix && `Prefix: ${state.query.prefix} · `}
              {state.query.includeDeleted ? "Including deletions" : "Active values"} ·{" "}
              {state.query.predicates.length} scalar predicates
            </p>
          )}
          <Read state={state.keys}>
            {(capture) => (
              <>
                <p className="wg-hint">
                  {capture.value.items.length} {capture.value.items.length === 1 ? "key" : "keys"}{" "}
                  on this page · {capture.value.remaining} more available.
                  {capture.partial &&
                    " Some results are not loaded. Use Next to continue the same snapshot."}
                </p>
                {capture.value.items.length === 0 ? (
                  <p>
                    No facts match here yet. Choose another scope, clear your filters, or create a
                    fact.
                  </p>
                ) : (
                  <>
                    {!capture.value.items.some((fact) =>
                      fact.key.toLocaleLowerCase().includes(listFilter.toLocaleLowerCase()),
                    ) && (
                      <p className="fact-no-match">
                        No loaded keys match “{listFilter}”. Clear this search or use Scope &
                        filters to search by prefix across this scope.
                      </p>
                    )}
                    <ul className="fact-keys">
                      {capture.value.items
                        .filter((fact) =>
                          fact.key.toLocaleLowerCase().includes(listFilter.toLocaleLowerCase()),
                        )
                        .map((fact) => (
                          <li key={fact.key}>
                            <Button
                              className={state.selectedKey === fact.key ? "fact-key-selected" : ""}
                              aria-pressed={state.selectedKey === fact.key}
                              onClick={() => {
                                openKey(fact.key);
                              }}
                            >
                              <code>{fact.key}</code>
                              <small>
                                <Badge tone={fact.kind === "deleted" ? "warning" : "neutral"}>
                                  {fact.kind === "deleted" ? "Deleted" : fact.valueType}
                                </Badge>
                                <span>revision {fact.revision}</span>
                              </small>
                              <span className="wg-hint">
                                <ActorAvatar actor={fact.actorId} />
                                {fact.actorId} · {fact.references.length} links
                                {batched?.revision === capture.revision && valueSizes.has(fact.key)
                                  ? ` · ${valueSizes.get(fact.key)} canonical bytes`
                                  : ""}
                              </span>
                            </Button>
                          </li>
                        ))}
                    </ul>
                  </>
                )}
                <Toolbar label="Fact key pages">
                  <Button
                    aria-label="Previous key page"
                    disabled={
                      state.keyPreviousOffsets.length === 0 || state.keys.kind === "loading"
                    }
                    onClick={() => controller.previousKeys()}
                  >
                    Previous
                  </Button>
                  <span className="wg-hint">Page {state.keyPreviousOffsets.length + 1}</span>
                  <Button
                    aria-label="Next key page"
                    disabled={capture.value.nextOffset === null || state.keys.kind === "loading"}
                    onClick={() => controller.nextKeys()}
                  >
                    Next
                  </Button>
                </Toolbar>
              </>
            )}
          </Read>
          <Read state={state.values}>
            {(capture) =>
              capture.partial ? (
                <p className="wg-hint">
                  Some values are not loaded. Open a key to read its value directly.
                </p>
              ) : null
            }
          </Read>
        </aside>
        <section className="fact-reader" aria-label="Selected fact">
          <Button
            className="fact-back"
            tone="quiet"
            onClick={() => {
              if (current !== null) context.navigate(factRoute({ ...current, key: null }));
            }}
          >
            ← All facts
          </Button>
          {state.selectedKey === null && <FactsGuide />}
          <Read state={state.detail}>
            {(capture) => (
              <article className="fact-document">
                <header className="fact-document-heading">
                  <span className="fact-scope-label">
                    <Icon name="facts" />
                    <ScopeName scope={capture.target.scope} />
                  </span>
                  <h2>{capture.value.key}</h2>
                  <div className="fact-document-meta">
                    <Summary fact={capture.value} />
                    {capture.value.kind !== "missing" && (
                      <>
                        <ActorAvatar actor={capture.value.actorId} />
                        <span>{capture.value.actorId}</span>
                        <RecordedTime value={capture.value.timestamp} />
                      </>
                    )}
                  </div>
                </header>
                {context.writer.actorId === null && (
                  <p className="fact-help-note">
                    Creating, editing, deleting or restoring a fact opens the actor chooser first.
                    Reading is available without one.
                  </p>
                )}
                <Toolbar label="Selected fact actions">
                  {(props.selection?.factRevision !== undefined ||
                    props.selection?.atRevision !== undefined) && (
                    <Button
                      onClick={() =>
                        context.navigate(factRoute({ ...capture.target, key: capture.value.key }))
                      }
                    >
                      Return to current value
                    </Button>
                  )}
                  <Button
                    requiresActor
                    disabled={false}
                    onClick={() => void controller.open(context, capture.value.key, "fact.put")}
                  >
                    <Icon name="settings" />
                    Edit selected fact
                  </Button>
                  <Button
                    requiresActor
                    disabled={capture.value.kind !== "value"}
                    onClick={() => void controller.open(context, capture.value.key, "fact.delete")}
                  >
                    <Icon name="archive" />
                    Delete selected fact
                  </Button>
                  <Button
                    disabled={capture.value.kind === "missing"}
                    onClick={() => {
                      setDialog("history");
                      controller.history();
                    }}
                  >
                    <Icon name="history" />
                    Read fact history
                  </Button>
                </Toolbar>
                <FactValue
                  {...(props.renderValue === undefined ? {} : { renderValue: props.renderValue })}
                  capture={capture}
                  processing={context.client.processing}
                  identity={`fact-${capture.target.connection.id}-${capture.target.connection.generation}-${capture.revision}-${capture.value.key}-${capture.value.kind === "missing" ? "missing" : capture.value.revision}`}
                />
                {capture.value.kind !== "missing" && (
                  <details className="fact-references">
                    <summary>
                      Related tickets and resources · {capture.value.references.length}
                    </summary>
                    <p>
                      Supporting links for this fact. Opening a link shows the current record;
                      finding related facts searches for other facts linked to the same record in
                      this scope.
                    </p>
                    {capture.value.references.length === 0 ? (
                      <p>No links yet. Edit the fact to connect a ticket or resource.</p>
                    ) : (
                      <ul>
                        {capture.value.references.map((ref) => (
                          <li key={`${ref.kind}:${ref.id}`}>
                            <span>
                              {ref.kind} <code>{ref.id}</code> (current)
                            </span>
                            {props.openReference === undefined ||
                            (props.canOpenReference !== undefined &&
                              !props.canOpenReference(capture.target, ref)) ? (
                              <span> · navigation unavailable</span>
                            ) : (
                              <Button onClick={() => props.openReference?.(capture.target, ref)}>
                                Open referenced {ref.kind}
                              </Button>
                            )}
                            <Button
                              onClick={() => {
                                setDialog("references");
                                controller.references(ref);
                              }}
                            >
                              Find facts referencing this entity
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
                )}
              </article>
            )}
          </Read>
        </section>
      </div>
      {dialog === "help" && (
        <Dialog wide title="About facts" onClose={() => setDialog(null)}>
          <FactsGuide />
        </Dialog>
      )}
      {dialog === "filters" && (
        <Dialog wide title="Fact scope & filters" onClose={() => setDialog(null)}>
          {issue && <p role="alert">{issue}</p>}
          <FactSection
            title="Where to look"
            description="A scope is the place a fact belongs. Project facts are separate from workspace facts; selecting a project does not include its tickets’ facts."
            icon="filter"
          >
            <Toolbar label="Fact scope">
              <Select
                label="Fact scope"
                value={scopeKind}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (
                    value === "workspace" ||
                    value === "project" ||
                    value === "milestone" ||
                    value === "ticket"
                  ) {
                    setScopeKind(value);
                    setScopeId("");
                  }
                }}
              >
                {["workspace", "project", "milestone", "ticket"].map((kind) => (
                  <option key={kind} value={kind}>
                    {kind[0]?.toUpperCase()}
                    {kind.slice(1)}
                  </option>
                ))}
              </Select>
              {scopeKind !== "workspace" && current !== null && (
                <FactChoice
                  context={context}
                  target={current}
                  kind={scopeKind}
                  label="Fact scope ID"
                  value={scopeId}
                  onChange={setScopeId}
                />
              )}
            </Toolbar>
            <Toolbar label="Browse selected fact scope">
              <Button
                tone="primary"
                disabled={scopeKind !== "workspace" && !scopeId.trim()}
                onClick={scopeApply}
              >
                Browse scope
              </Button>
            </Toolbar>
            {current !== null && (
              <p>
                Browsing <ScopeName scope={current.scope} /> · values never inherit from another
                scope.
              </p>
            )}
          </FactSection>
          <FactSection
            title="Narrow the current scope"
            description="Filter saved key names or show deleted keys. Apply fact filters changes the list you are browsing; it does not change any saved facts."
            tone="purple"
          >
            <div className="fact-inline">
              <Field
                label="Literal key prefix"
                value={prefix}
                placeholder="For example, release."
                hint="Match the beginning of a key, exactly as written. Leave blank for all keys; * is not a wildcard."
                onChange={(event) => setPrefix(event.currentTarget.value)}
              />
              <label>
                <input
                  type="checkbox"
                  checked={includeDeleted}
                  onChange={(event) => setIncludeDeleted(event.currentTarget.checked)}
                />
                Include deleted keys
              </label>
            </div>
            <LazyDetails summary={`Match a field value · advanced (${predicates.length}/8)`}>
              <p>
                Look inside a fact’s value. For example, pointer /ready with value true finds
                objects with a ready field set to true. A blank pointer matches the whole value.
                Every condition must match. Text needs JSON quotes, such as "approved"; numbers,
                true, false and null do not. Missing fields never match null, and 1 and 1.0 are
                distinct exact values.
              </p>
              {predicates.map((row, index) => (
                <div className="fact-inline" key={index}>
                  <Field
                    label={`Predicate ${index + 1} pointer`}
                    placeholder="/ready"
                    hint="Path to a field; use /name for a top-level field."
                    value={row.pointer}
                    onChange={(event) =>
                      setPredicates(
                        predicates.map((r, i) =>
                          i === index ? { ...r, pointer: event.currentTarget.value } : r,
                        ),
                      )
                    }
                  />
                  <Field
                    label={`Predicate ${index + 1} scalar JSON`}
                    placeholder="true"
                    hint="One text, number, boolean or null value."
                    value={row.scalar}
                    onChange={(event) =>
                      setPredicates(
                        predicates.map((r, i) =>
                          i === index ? { ...r, scalar: event.currentTarget.value } : r,
                        ),
                      )
                    }
                  />
                  <Button onClick={() => setPredicates(predicates.filter((_, i) => i !== index))}>
                    Remove predicate {index + 1}
                  </Button>
                </div>
              ))}
              <Button
                disabled={predicates.length >= 8}
                onClick={() => setPredicates([...predicates, { pointer: "", scalar: "null" }])}
              >
                Add predicate
              </Button>
            </LazyDetails>
            <Toolbar label="Apply fact filters">
              <Button tone="primary" disabled={filtering} onClick={() => void applyFilters()}>
                {filtering ? "Validating filters…" : "Apply fact filters"}
              </Button>
              <Button
                disabled={filtering}
                onClick={() => {
                  setPrefix("");
                  setIncludeDeleted(false);
                  setPredicates([]);
                  controller.query({ prefix: "", includeDeleted: false, predicates: [] });
                  setDialog(null);
                }}
              >
                Clear filters
              </Button>
            </Toolbar>
          </FactSection>
        </Dialog>
      )}
      {dialog === "create" && (
        <Dialog wide title="Open or create a fact" onClose={() => setDialog(null)}>
          {issue && <p role="alert">{issue}</p>}
          <FactSection
            title="Give this information a name"
            description="A key is a reusable name for one small value. If the key already exists in this scope, you can read or edit it; otherwise you can create its first value."
            tone="purple"
          >
            {current !== null && (
              <p>
                Location: <ScopeName scope={current.scope} />. Use Scope & filters first if this
                belongs somewhere else.
              </p>
            )}
            <Toolbar label="Create fact">
              <Field
                label="New or existing fact key"
                placeholder="release.ready"
                hint="Choose a clear, consistent name, such as review.summary or environment.region. The key is separate from its value."
                value={newKey}
                onChange={(event) => setNewKey(event.currentTarget.value)}
              />
              <Button
                disabled={!newKey.trim()}
                onClick={() => {
                  openKey(newKey);
                }}
              >
                Inspect exact key
              </Button>
              <Button
                tone="primary"
                requiresActor
                disabled={!newKey.trim()}
                onClick={() => {
                  setDialog(null);
                  void controller.open(context, newKey, "fact.put");
                }}
              >
                Edit or create fact
              </Button>
            </Toolbar>
            <p className="wg-hint">
              Inspect only reads. Edit or create opens an unsaved draft; nothing is stored until you
              review and apply it.
            </p>
            {context.writer.actorId === null && (
              <p className="fact-help-note">
                Editing opens the actor chooser first. You can still inspect a key.
              </p>
            )}
          </FactSection>
        </Dialog>
      )}
      {dialog === "history" && (
        <Dialog wide title="Fact history" onClose={() => setDialog(null)}>
          <p className="fact-lead">
            Every saved change has a version, an author and a time. Open a version to read it, or
            restore a previous value by reviewing and applying a new draft. Restoring does not erase
            later history.
          </p>
          <Read state={state.history}>
            {(capture) => (
              <section className="fact-history-content" aria-label="Recorded fact versions">
                <p className="wg-hint">
                  Versions are listed oldest first. Deleted values remain part of this history.
                </p>
                <ol className="fact-history-list">
                  {capture.value.items.map((version) => (
                    <li key={version.revision}>
                      <header className="fact-history-author">
                        <ActorAvatar actor={version.actorId} />
                        <div>
                          <strong>{version.actorId}</strong>
                          <RecordedTime value={version.timestamp} />
                        </div>
                        <Summary fact={version} />
                      </header>
                      <LazyDetails summary={`Value at fact revision ${version.revision}`}>
                        <FactValue
                          capture={{ ...capture, value: version }}
                          processing={context.client.processing}
                          identity={`history-${capture.target.connection.generation}-${version.key}-${version.revision}`}
                        />
                      </LazyDetails>
                      <Toolbar label={`Fact revision ${version.revision} actions`}>
                        <Button
                          onClick={() => {
                            context.navigate(
                              factRoute({
                                ...capture.target,
                                key: version.key,
                                factRevision: version.revision,
                              }),
                            );
                            setDialog(null);
                          }}
                        >
                          Open this version
                        </Button>
                        <Button
                          requiresActor
                          disabled={version.kind === "deleted"}
                          onClick={() => {
                            setDialog(null);
                            void controller.open(context, version.key, "fact.put", version);
                          }}
                        >
                          Restore this value into a new draft
                        </Button>
                      </Toolbar>
                    </li>
                  ))}
                </ol>
                <Toolbar label="Fact history pages">
                  <Button
                    disabled={
                      state.historyPreviousOffsets.length === 0 || state.history.kind === "loading"
                    }
                    onClick={() => controller.previousHistory()}
                  >
                    Previous history page
                  </Button>
                  <span className="wg-hint">Page {state.historyPreviousOffsets.length + 1}</span>
                  <Button
                    disabled={capture.value.nextOffset === null || state.history.kind === "loading"}
                    onClick={() => controller.nextHistory()}
                  >
                    Next history page
                  </Button>
                </Toolbar>
              </section>
            )}
          </Read>
        </Dialog>
      )}
      {dialog === "references" && (
        <Dialog wide title="Find referencing facts" onClose={() => setDialog(null)}>
          <section aria-label="Reverse reference lookup">
            {issue && <p role="alert">{issue}</p>}
            <FactSection
              title="Find the context behind a record"
              description="Choose a ticket or resource to find facts explicitly linked to it in the current scope. This searches saved links, not mentions inside a value."
              icon="search"
            >
              {current && (
                <p>
                  Searching <ScopeName scope={current.scope} />. Change Scope & filters to look
                  elsewhere.
                </p>
              )}
              <div className="fact-reference-form" role="group" aria-label="Reverse fact reference">
                <Select
                  label="Referenced entity kind"
                  value={refKind}
                  onChange={(event) => {
                    setRefKind(event.currentTarget.value === "ticket" ? "ticket" : "resource");
                    setRefId("");
                  }}
                >
                  <option value="ticket">Ticket</option>
                  <option value="resource">Resource</option>
                </Select>
                {current && (
                  <FactChoice
                    context={context}
                    target={current}
                    kind={refKind}
                    label="Referenced entity ID"
                    value={refId}
                    onChange={setRefId}
                  />
                )}
                <Button
                  tone="primary"
                  disabled={!refId.trim()}
                  onClick={() => {
                    try {
                      controller.references({ kind: refKind, id: identifier(refId) });
                    } catch (error) {
                      inputFailure(error);
                    }
                  }}
                >
                  Find referencing facts
                </Button>
              </div>
            </FactSection>
            <Read state={state.references}>
              {(capture) => (
                <>
                  <p>
                    Current facts in <ScopeName scope={capture.target.scope} /> referencing{" "}
                    {state.referenceQuery?.kind} <code>{state.referenceQuery?.id}</code> · planning
                    snapshot {capture.revision}
                  </p>
                  {capture.value.items.length === 0 ? (
                    <p>No active referencing facts in this captured scope.</p>
                  ) : (
                    <ul className="fact-reference-list">
                      {capture.value.items.map((version) => (
                        <li key={version.key}>
                          <Button
                            onClick={() => {
                              setDialog(null);
                              openKey(version.key);
                            }}
                          >
                            <code>{version.key}</code>
                          </Button>
                          <Summary fact={version} />
                        </li>
                      ))}
                    </ul>
                  )}
                  <Toolbar label="Referencing fact pages">
                    <Button
                      aria-label="Previous referencing facts"
                      disabled={
                        state.referencePreviousOffsets.length === 0 ||
                        state.references.kind === "loading"
                      }
                      onClick={() => controller.previousReferences()}
                    >
                      Previous
                    </Button>
                    <span className="wg-hint">
                      Page {state.referencePreviousOffsets.length + 1}
                    </span>
                    <Button
                      aria-label="Next referencing facts"
                      disabled={
                        capture.value.nextOffset === null || state.references.kind === "loading"
                      }
                      onClick={() => controller.nextReferences()}
                    >
                      Next
                    </Button>
                  </Toolbar>
                </>
              )}
            </Read>
          </section>
        </Dialog>
      )}
      {dialog === "drafts" && (
        <Dialog wide title="Retained fact drafts" onClose={() => setDialog(null)}>
          {" "}
          {state.drafts.length > 0 && (
            <Panel title="Retained fact drafts">
              <p>
                Closing an editor keeps its draft here in this UI session. Reopen it to continue, or
                discard an unsent draft from its editor. Drafts keep their original workspace and
                author even if you switch elsewhere. They are not shared facts until applied.
              </p>
              <div className="fact-draft-library" role="group" aria-label="Choose fact draft">
                {state.drafts.map((draft) => (
                  <Button
                    key={draft.id}
                    aria-pressed={draft.id === state.selectedDraftId}
                    onClick={() => {
                      setDialog(null);
                      controller.chooseDraft(draft.id);
                    }}
                  >
                    <span>
                      <strong>{draft.key}</strong>
                      <small>
                        <ScopeName scope={draft.target.scope} /> · {draft.writer.actorId}
                      </small>
                    </span>
                    <Badge>
                      {draft.phase.kind === "editing"
                        ? "Unsaved draft"
                        : draft.phase.kind === "validating"
                          ? "Checking value"
                          : "Saved action"}
                    </Badge>
                  </Button>
                ))}
              </div>
            </Panel>
          )}
        </Dialog>
      )}
      {selectedDraft !== undefined && (
        <Dialog
          wide
          title={`${selectedDraft.method === "fact.delete" ? "Delete fact" : selectedDraft.base.value.kind === "missing" ? "Create fact" : "Edit fact"} · ${selectedDraft.key}`}
          onClose={() => controller.chooseDraft(null)}
        >
          <Draft key={selectedDraft.id} draft={selectedDraft} props={props} />
        </Dialog>
      )}
    </div>
  );
}
