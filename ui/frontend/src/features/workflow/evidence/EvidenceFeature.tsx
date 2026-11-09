import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  Badge,
  Button,
  Field,
  Panel,
  Select,
  StatePanel,
  Toolbar,
} from "../../../components/Primitives";
import { jsonField, type JsonValue } from "../../../core/json";
import type { ReadState } from "../../../core/state/read-slot";
import { failureText } from "../../connections/failure";
import { CapturedValues } from "../../connections/CapturedValues";
import { LazyDetails, OperationPanel } from "../../connections/shared";
import { COMMANDS, definition } from "./commands";
import { StructuredField } from "./StructuredField";
import { EvidenceInputError, sameTarget, target, text } from "./model";
import type { EvidenceCapture, EvidenceDraft, EvidenceFeatureProps, EvidenceMethod } from "./types";
import { EvidenceInspector } from "./EvidenceInspector";
import { PinnedResource } from "./PinnedResource";
import "./evidence.css";

function ReadStatus<T>({ state, label }: { readonly state: ReadState<T>; readonly label: string }) {
  if (state.kind === "unexpected_error") throw state.error;
  return state.kind === "failed" ? (
    <StatePanel kind="error" title={`${label} unavailable`}>
      {failureText(state.failure)} Previous capture, if any, remains historical.
    </StatePanel>
  ) : state.kind === "loading" ? (
    <p role="status">Reading {label.toLowerCase()}…</p>
  ) : null;
}
function show(value: JsonValue | undefined): string {
  return value?.kind === "boolean" ? String(value.value) : text(value);
}
function reference(value: JsonValue | undefined, name: string): string {
  return value?.kind === "object"
    ? `${text(jsonField(value, `${name}_id`))} · revision ${text(jsonField(value, "revision"))}`
    : "None";
}
function ReviewSummary({
  capture,
  props,
}: {
  readonly props: EvidenceFeatureProps;
  readonly capture: EvidenceCapture;
}) {
  const submission = capture.submission,
    manifest = capture.manifest;
  return (
    <>
      <Panel
        title="What this work must demonstrate"
        actions={<Badge>{capture.policy.criteria.length} criteria</Badge>}
      >
        <p>
          A criterion is a named requirement. An assertion records an actual result against its
          exact source policy.
        </p>
        {capture.policy.criteria.length === 0 ? (
          <p>No named criteria are configured.</p>
        ) : (
          <ul className="ev-summary-list">
            {capture.policy.criteria.map((row, index) => {
              const criterion = jsonField(row, "criterion"),
                source = jsonField(row, "reference");
              return (
                <li key={index}>
                  <strong>
                    {text(
                      criterion === undefined ? undefined : jsonField(criterion, "description"),
                    )}
                  </strong>
                  <span>
                    {show(
                      criterion === undefined ? undefined : jsonField(criterion, "required"),
                    ) === "true"
                      ? "Required"
                      : "Informational"}{" "}
                    · key {text(criterion === undefined ? undefined : jsonField(criterion, "key"))}{" "}
                    · source policy{" "}
                    {text(source === undefined ? undefined : jsonField(source, "policy_revision"))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p>
          {capture.policy.reviewers.length} reviewer requirements ·{" "}
          {capture.policy.validators.length} validators ·{" "}
          {capture.policy.separate_actor
            ? "Reviewer must differ from submitter"
            : "No separate-actor requirement"}
        </p>
        {capture.policy.reviewers.length > 0 && (
          <ul>
            {capture.policy.reviewers.map((reviewer, index) => (
              <li key={index}>
                {text(jsonField(reviewer, "kind")) === "actor"
                  ? `Named reviewer ${text(jsonField(reviewer, "actor_id"))}`
                  : `Reviewer role ${text(jsonField(reviewer, "name"))}`}
              </li>
            ))}
          </ul>
        )}
        {capture.policy.validators.length > 0 && (
          <p>Validators: {capture.policy.validators.join(", ")}</p>
        )}
        {capture.policy.stale_override.kind !== "null" && (
          <p role="alert" className="wg-error">
            An inherited override is stale. Current inherited requirements apply.
          </p>
        )}
        {capture.assertions.length > 0 && (
          <LazyDetails
            summary={`${capture.assertions.length} recorded criterion assertions (including historical results)`}
          >
            <CapturedValues value={jsonField(capture.raw, "assertions") ?? capture.raw} />
          </LazyDetails>
        )}
      </Panel>
      <Panel
        title="Pinned output and review round"
        actions={
          <Badge>
            {submission === null
              ? "Not submitted"
              : `Generation ${text(jsonField(submission, "generation"))}`}
          </Badge>
        }
      >
        <p>
          A manifest names the exact inputs and outputs used by an attempt. A submission freezes one
          manifest for one review generation.
        </p>
        {manifest === null ? (
          <p>No manifest has been published for this ticket.</p>
        ) : (
          <>
            <p>
              Manifest <code>{text(jsonField(manifest, "manifest_id"))}</code> · revision{" "}
              {text(jsonField(manifest, "revision"))} · attempt{" "}
              <code>{text(jsonField(manifest, "attempt_id"))}</code>
            </p>
            <p>Contract {reference(jsonField(manifest, "contract"), "contract")}</p>
            {(["inputs", "outputs"] as const).map((name) => {
              const items = jsonField(manifest, name);
              return items?.kind === "array" ? (
                <div key={name}>
                  <h3>{name === "inputs" ? "Pinned inputs" : "Pinned outputs"}</h3>
                  {items.items.slice(0, 100).map((artifact, index) => {
                    const pin = jsonField(artifact, "pin");
                    return pin?.kind === "object" && text(jsonField(pin, "kind")) === "resource" ? (
                      <div
                        key={`${capture.target.connection.id}-${capture.target.connection.generation}-${capture.target.workspaceId}-${capture.revision}-${name}-${index}`}
                      >
                        <p>{text(jsonField(artifact, "name"))}</p>
                        <PinnedResource
                          http={props.context.client}
                          target={capture.target}
                          value={pin}
                          {...(props.openEvidence === undefined
                            ? {}
                            : { openEvidence: props.openEvidence })}
                        />
                      </div>
                    ) : (
                      <p key={index}>
                        {text(jsonField(artifact, "name"))} · exact{" "}
                        {pin === undefined ? "unavailable" : text(jsonField(pin, "kind"))} pin is
                        retained in source.
                      </p>
                    );
                  })}
                  {items.items.length > 100 && (
                    <p>Showing 100 pins; remaining returned pins stay in exact source.</p>
                  )}
                </div>
              ) : null;
            })}
          </>
        )}
        {submission !== null && (
          <>
            <p>
              State:{" "}
              <strong>
                {text(jsonField(jsonField(submission, "state") ?? submission, "kind"))}
              </strong>{" "}
              · submission revision {text(jsonField(submission, "revision"))}
            </p>
            <p>Submitted manifest {reference(jsonField(submission, "manifest"), "manifest")}</p>
          </>
        )}
        <p className="ev-callout">
          Approval is a reviewer’s verdict. Acceptance checks the current complete evidence gate.
          Finishing work is a separate owner action that also checks claims, holds, conditions,
          dependencies and children.
        </p>
        {capture.reviews.length === 0 ? (
          <p>No reviewer verdicts are recorded.</p>
        ) : (
          <ol className="ev-summary-list">
            {capture.reviews.map((review, index) => {
              const actor = jsonField(review, "reviewer");
              return (
                <li key={index}>
                  <strong>
                    {text(jsonField(review, "verdict"))} · generation{" "}
                    {text(jsonField(review, "generation"))}
                  </strong>
                  <span>
                    Reviewer {actor === undefined ? "" : text(jsonField(actor, "actor_id"))} ·
                    review {text(jsonField(review, "review_id"))}
                  </span>
                  <details>
                    <summary>Review evidence and exact pins</summary>
                    <CapturedValues value={review} />
                  </details>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>
      {(capture.reconciliations.length > 0 || capture.decisions.length > 0) && (
        <Panel title="Changed inputs and decisions">
          <p>
            Historical evidence stays historical. A changed input requires an explicit
            acknowledgement, continued-use reason or revised manifest.
          </p>
          {capture.reconciliations.map((item, index) => (
            <details key={`r-${index}`}>
              <summary>
                Reconciliation {text(jsonField(item, "serial"))} · revision{" "}
                {text(jsonField(item, "revision"))} ·{" "}
                {text(jsonField(jsonField(item, "state") ?? item, "kind"))}
              </summary>
              <CapturedValues value={item} />
            </details>
          ))}
          {capture.decisions.map((item, index) => (
            <details key={`d-${index}`}>
              <summary>
                {text(jsonField(item, "title"))} · decision revision{" "}
                {text(jsonField(item, "revision"))}
              </summary>
              <CapturedValues value={item} />
            </details>
          ))}
        </Panel>
      )}
    </>
  );
}
function Editor({
  draft,
  props,
}: {
  readonly draft: EvidenceDraft;
  readonly props: EvidenceFeatureProps;
}) {
  const command = definition(draft.method),
    locked = draft.phase.kind !== "editing";
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(new Set());
  const block = useCallback(
    (name: string, value: boolean) =>
      setBlocked((previous) => {
        if (previous.has(name) === value) return previous;
        const next = new Set(previous);
        if (value) next.add(name);
        else next.delete(name);
        return next;
      }),
    [],
  );
  if (draft.unexpected !== null) throw draft.unexpected.error;
  const currentTarget = (() => {
    try {
      return sameTarget(draft.target, target(props.context, props.ticketId));
    } catch (error: unknown) {
      if (error instanceof EvidenceInputError) return false;
      throw error;
    }
  })();
  return (
    <Panel title={command.title} actions={<Badge>{draft.phase.kind.replaceAll("_", " ")}</Badge>}>
      <p>{command.description}</p>
      <p className="ev-capture">
        Captured writer <strong>{draft.writer.actorId}</strong> · run {draft.writer.runId ?? "none"}{" "}
        · workspace <code>{draft.target.workspaceId}</code> · ticket{" "}
        <code>{draft.target.ticketId}</code> · connection {draft.target.connection.label} generation{" "}
        {draft.target.connection.generation}
      </p>
      {!currentTarget && (
        <p role="status" className="ev-callout">
          This editor belongs to a different captured target. Current selection changes do not
          rewrite its writer, guards or pins.
        </p>
      )}
      {draft.claim !== null && (
        <p className="wg-hint">
          Observed claimant {draft.claim.actorId} · run {draft.claim.runId ?? "none"} · token{" "}
          {draft.claim.token}. This token is an ownership fence, not a credential.
        </p>
      )}
      {draft.phase.kind === "unavailable" ? (
        <p role="alert">
          {draft.phase.message} Close this editor and open a fresh capture after resolving the
          problem.
        </p>
      ) : draft.phase.kind === "initializing" ? (
        <p role="status">Capturing the actual ticket owner and initial fields…</p>
      ) : draft.phase.kind === "registered" ? (
        <OperationPanel
          intention={draft.id}
          operations={props.operations}
          processing={props.context.client.processing}
        />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!locked && blocked.size === 0) void props.controller.prepare(draft.id);
          }}
        >
          {command.fields.map((field) => {
            const input = draft.inputs[field.name];
            if (input === undefined) return null;
            const change = (next: typeof input) =>
              props.controller.edit(draft.id, field.name, next);
            return (
              <div key={field.name} className="ev-form-field">
                {field.optional && (
                  <label className="ev-enable">
                    <input
                      type="checkbox"
                      disabled={locked}
                      checked={input.presence === "value"}
                      onChange={(event) =>
                        change({
                          ...input,
                          presence: event.currentTarget.checked ? "value" : "omit",
                        })
                      }
                    />
                    Include {field.label.toLowerCase()}
                  </label>
                )}
                {input.presence === "value" &&
                  (field.type === "json" ? (
                    <StructuredField
                      field={field}
                      input={input}
                      processing={props.context.client.processing}
                      disabled={locked}
                      onChange={change}
                      onBlocked={block}
                    />
                  ) : field.type === "boolean" ? (
                    <label className="ev-enable">
                      <input
                        type="checkbox"
                        disabled={locked}
                        checked={input.text === "true"}
                        onChange={(event) =>
                          change({ ...input, text: String(event.currentTarget.checked) })
                        }
                      />
                      {field.label}
                    </label>
                  ) : field.type === "choice" ? (
                    <Select
                      label={field.label}
                      disabled={locked}
                      value={input.text}
                      onChange={(event) => change({ ...input, text: event.currentTarget.value })}
                    >
                      {field.choices?.map((choice) => (
                        <option key={choice}>{choice}</option>
                      ))}
                    </Select>
                  ) : field.type === "multiline" ? (
                    <label className="ev-source-label">
                      {field.label}
                      <textarea
                        aria-label={field.label}
                        disabled={locked}
                        value={input.text}
                        onChange={(event) => change({ ...input, text: event.currentTarget.value })}
                      />
                    </label>
                  ) : (
                    <Field
                      label={field.label}
                      disabled={locked}
                      value={input.text}
                      {...(field.hint === undefined ? {} : { hint: field.hint })}
                      onChange={(event) => change({ ...input, text: event.currentTarget.value })}
                    />
                  ))}
              </div>
            );
          })}
          <p className="wg-hint">
            Review captures and validates this exact intention. It does not apply the change. The
            next panel offers an explicit Execute saved request action.
          </p>
          <Button type="submit" tone="primary" disabled={locked || blocked.size > 0}>
            {draft.phase.kind === "preparing" ? "Preparing review…" : "Review this action"}
          </Button>
        </form>
      )}
      {draft.issue !== null && (
        <p role="alert" className="wg-error">
          {draft.issue}
        </p>
      )}
      <Button
        disabled={draft.phase.kind === "preparing"}
        onClick={() => props.controller.discard(draft.id)}
      >
        Close editor (keep saved operation)
      </Button>
    </Panel>
  );
}
export function EvidenceFeature(props: EvidenceFeatureProps) {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.get),
    [method, setMethod] = useState<EvidenceMethod>("review.submit");
  const { context, ticketId, controller } = props;
  useEffect(() => {
    void controller.select(context, ticketId);
  }, [controller, context, ticketId]);
  if (state.unexpected !== null) throw state.unexpected.error;
  const capture =
    state.evidence.kind === "ready"
      ? state.evidence.value
      : state.evidence.kind === "loading" || state.evidence.kind === "failed"
        ? state.evidence.previous
        : undefined;
  const draft = state.drafts.find((item) => item.id === state.selectedDraft);
  return (
    <section className="ev-feature" aria-label="Review and evidence">
      <header className="ev-header">
        <div>
          <p className="ev-eyebrow">Workflow / Completion</p>
          <h2>Review & evidence</h2>
          <p>Show what changed, pin what was checked, and ask the right person to review it.</p>
        </div>
        <Button onClick={() => void controller.refresh()}>Refresh current evidence</Button>
      </header>
      <p className="wg-hint">
        Ticket <code>{ticketId}</code>.{" "}
        {props.graphRevision === undefined
          ? "No graph capture was supplied."
          : `Displayed graph planning revision ${props.graphRevision}.`}{" "}
        Evidence is read from its own namespace; these are separate captures.
      </p>
      <ReadStatus state={state.evidence} label="Ticket evidence" />
      <ReadStatus state={state.gate} label="Evidence gate" />
      {state.issue !== null && (
        <p role="alert" className="wg-error">
          {state.issue}
        </p>
      )}
      {state.gate.kind === "ready" && (
        <Panel
          title="Current evidence gate"
          actions={
            <Badge tone={state.gate.value.allowed ? "accent" : "warning"}>
              {state.gate.value.allowed
                ? "Evidence allows completion"
                : "Evidence requirements remain"}
            </Badge>
          }
        >
          <p>
            {state.gate.value.problem?.message ??
              "Current configured evidence requirements are satisfied."}
          </p>
          <p className="wg-hint">
            Evidence query revision {state.gate.value.revision}. This is separate from graph
            readiness and the full completion checks.{" "}
            {capture !== undefined && capture.revision !== state.gate.value.revision
              ? "The summary and gate were read at different evidence revisions; refresh to compare current results."
              : ""}
          </p>
        </Panel>
      )}
      {capture !== undefined && (
        <>
          <p className="wg-hint">
            Summary captured at evidence revision {capture.revision} for{" "}
            {capture.target.connection.label} generation {capture.target.connection.generation},
            workspace {capture.target.workspaceId}, ticket {capture.target.ticketId}.
          </p>
          <ReviewSummary capture={capture} props={props} />
        </>
      )}
      <Panel title="Author the next step">
        <p>
          Use the actual recorded owner for worker actions, the actual reviewer for a verdict, and
          the submitter for acceptance. Actor selection is free attribution; it does not transfer a
          claim or authenticate a reviewer.
        </p>
        <Select
          label="Review workflow step"
          value={method}
          onChange={(event) => {
            const command = COMMANDS.find((item) => item.method === event.currentTarget.value);
            if (command !== undefined) setMethod(command.method);
          }}
        >
          {["policy", "artifacts", "review", "changes", "conditions"].map((group) => (
            <optgroup key={group} label={group}>
              {COMMANDS.filter((item) => item.group === group).map((item) => (
                <option key={item.method} value={item.method}>
                  {item.title}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        <Button
          requiresActor
          tone="primary"
          onClick={() => void controller.open(context, ticketId, method)}
        >
          Open captured editor
        </Button>
        <p className="wg-hint">
          New terms: a contract names required artifacts; a pin identifies exact historical bytes or
          records; a manifest collects named pins. A review generation freezes one submitted
          manifest.
        </p>
        <p className="wg-hint">
          Allocation, run eligibility and path ownership are managed in Participants; external
          conditions below record supplied outcomes and never perform external actions.
        </p>
        <Button
          onClick={() =>
            context.navigate({
              view: "participants",
              connectionId: context.connection.id,
              workspaceId: context.route.workspaceId,
              projectId: context.route.projectId,
              entityId: null,
            })
          }
        >
          Open Participants for runs and allocation
        </Button>
      </Panel>
      {state.drafts.length > 0 && (
        <Toolbar label="Retained evidence editors">
          {state.drafts.map((item) => (
            <Button
              key={item.id}
              aria-pressed={item.id === state.selectedDraft}
              onClick={() => controller.selectDraft(item.id)}
            >
              {definition(item.method).title} · {item.target.ticketId}
            </Button>
          ))}
        </Toolbar>
      )}
      {draft !== undefined && <Editor key={draft.id} draft={draft} props={props} />}
      <EvidenceInspector
        key={JSON.stringify([
          context.connection.id,
          context.connection.generation,
          context.route.workspaceId,
          ticketId,
        ])}
        props={props}
      />
    </section>
  );
}
