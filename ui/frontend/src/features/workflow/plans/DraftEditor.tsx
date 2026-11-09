import { useCallback, useState } from "react";
import { Badge, Button, Field, Toolbar } from "../../../components/Primitives";
import { jsonField } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import { OperationPanel } from "../../connections/shared";
import { initialStage, templateSourceOperation } from "./authoring";
import { PlanInputError } from "./model";
import { StageEditor } from "./StageEditor";
import { SchemaForm } from "./SchemaForm";
import { useMethod } from "./useMethod";
import { setField, text } from "./schema";
import type { PlanDraft, PlansFeatureProps } from "./types";

export function DraftEditor({
  draft,
  context,
  controller,
  operations,
  launch,
  onIssue,
}: {
  readonly draft: PlanDraft;
  readonly launch: (task: Promise<unknown>) => void;
  readonly onIssue: (error: unknown) => void;
} & Omit<PlansFeatureProps, "view">) {
  const [pendingForms, setPendingForms] = useState<ReadonlySet<string>>(new Set());
  const reportPending = useCallback((key: string, active: boolean) => {
    setPendingForms((old) => {
      if (old.has(key) === active) return old;
      const next = new Set(old);
      if (active) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const [selected, setSelected] = useState(0),
    document = draft.document,
    current =
      document !== null &&
      (draft.structuredRevision === draft.revision || draft.active === "parsing"),
    sourceOp = templateSourceOperation(document),
    blocked = draft.active === "preparing";
  if (draft.unexpected) throw draft.unexpected.error;
  if (
    draft.persistenceFailure !== null &&
    !(draft.persistenceFailure.error instanceof DOMException) &&
    !(draft.persistenceFailure.error instanceof PlanInputError)
  )
    throw draft.persistenceFailure.error;
  const update = (next: NonNullable<typeof document>) =>
    launch(controller.replaceDocument(draft.id, next));
  return (
    <article className="plan-editor" aria-label="Workflow draft editor">
      <header className="plan-editor-heading">
        <div>
          <span className="work-eyebrow">
            {sourceOp ? "TEMPLATE IN PROGRESS" : "WORKFLOW DRAFT"}
          </span>
          <h3>{document?.title ?? "Source needs parsing"}</h3>
        </div>
        <Badge tone={draft.persisted === "saved" ? "neutral" : "warning"}>
          {draft.persisted === "saved"
            ? "Saved in this browser"
            : draft.persisted === "pending"
              ? "Saving locally…"
              : "Local recovery unavailable"}
        </Badge>
      </header>
      <p className="plan-capture">
        Editing as <strong>{draft.capture.context.writer.actor_id}</strong>
        {draft.capture.context.writer.run_id && ` / ${draft.capture.context.writer.run_id}`} ·{" "}
        {draft.capture.connection.label} · {draft.capture.context.workspace_id}
      </p>
      {(context.writer.actorId !== draft.capture.context.writer.actor_id ||
        context.writer.runId !== draft.capture.context.writer.run_id ||
        context.connection.id !== draft.capture.connection.id ||
        context.connection.generation !== draft.capture.connection.generation) && (
        <p className="plan-notice" role="status">
          This editor keeps its original connection and writer. Switching the shell does not
          retarget its publication.
        </p>
      )}
      {draft.persistenceFailure && (
        <p role="alert" className="wg-error">
          Local recovery save failed for source revision {draft.persistenceFailure.revision}:{" "}
          {draft.persistenceFailure.error instanceof Error
            ? draft.persistenceFailure.error.message
            : "Unexpected storage failure"}
          . Keep this editor open and export a copy.
        </p>
      )}
      {pendingForms.size > 0 && (
        <p className="plan-notice" role="status">
          Apply or revert pending scalar edits before reviewing or preparing this batch.
        </p>
      )}
      {draft.issue && (
        <p className="wg-error" role="alert">
          {draft.issue}
        </p>
      )}
      {draft.active && (
        <p role="status">
          {draft.active === "preparing"
            ? "Saving exact native operation…"
            : draft.active === "template"
              ? "Building native canonical preview…"
              : draft.active === "preflight"
                ? "Checking this exact batch with the daemon…"
                : draft.active === "restoring"
                  ? "Inspecting retained native journals…"
                  : "Saving structured source…"}
        </p>
      )}
      <p className="plan-editor-guidance">
        {sourceOp
          ? "Name your template, add its tasks, then build a publication draft to review. Your work is saved automatically."
          : "Add the changes you want below, then review the batch. Your work is saved automatically; nothing is applied just by editing."}
      </p>
      <fieldset disabled={blocked} className="plan-edit-fields">
        {current && document ? (
          <>
            <Field
              label={sourceOp ? "Template source name" : "Workflow name"}
              value={document.title}
              onChange={(event) => update({ ...document, title: event.currentTarget.value })}
            />
            {sourceOp ? (
              <TemplateSourceEditor
                {...{ draft, context, controller, operations, launch, onIssue }}
              />
            ) : (
              <>
                <div className="plan-stage-tabs" role="group" aria-label="Explicit batches">
                  {document.stages.map((stage, index) => {
                    const frozen = draft.frozen.find((f) => f.stageId === stage.id);
                    return (
                      <Button
                        key={`${index}-${stage.id}`}
                        aria-pressed={Math.min(selected, document.stages.length - 1) === index}
                        onClick={() => setSelected(index)}
                      >
                        {index + 1}. {stage.title}{" "}
                        {frozen?.prepared ? "· saved" : frozen?.captured ? "· captured" : ""}
                      </Button>
                    );
                  })}
                  <Button
                    disabled={document.stages.length >= 32}
                    onClick={() => {
                      update({
                        ...document,
                        stages: [
                          ...document.stages,
                          initialStage(document.stages.length, draft.capture.context.project_id),
                        ],
                      });
                      setSelected(document.stages.length);
                    }}
                  >
                    Add batch
                  </Button>
                </div>
                <details className="plan-secondary">
                  <summary>How batches work</summary>
                  <p>
                    A batch is applied all at once. Separate batches are applied independently, so
                    an earlier batch can succeed even if a later one fails. Each batch can contain
                    up to 128 expanded changes. Templates may expand into several changes.
                  </p>
                </details>
                <AliasTable draft={draft} />
                {(() => {
                  const index = Math.min(selected, document.stages.length - 1),
                    stage = document.stages[index],
                    frozen = draft.frozen.find((f) => f.stageId === stage?.id),
                    locked =
                      frozen !== undefined &&
                      (frozen.captured ||
                        frozen.prepared ||
                        operations.get(frozen.intentionId) !== undefined);
                  return (
                    stage && (
                      <>
                        <StageEditor
                          http={context.client}
                          projectId={draft.capture.context.project_id}
                          document={document}
                          index={index}
                          locked={locked}
                          onChange={update}
                          onIssue={onIssue}
                          onPending={reportPending}
                        />
                        <Toolbar label="Batch review actions">
                          <Button
                            disabled={
                              locked ||
                              draft.parsedRevision !== draft.revision ||
                              draft.active !== null ||
                              pendingForms.size > 0
                            }
                            tone="primary"
                            onClick={() => launch(controller.preview(draft.id, stage.id))}
                          >
                            Review batch {index + 1}
                          </Button>
                          <Button
                            disabled={
                              document.stages.length <= 1 ||
                              locked ||
                              document.stages.some((item) =>
                                item.bindings.some((binding) => binding.stage === stage.id),
                              )
                            }
                            onClick={() => {
                              update({
                                ...document,
                                stages: document.stages.filter((_, i) => i !== index),
                              });
                              setSelected(Math.max(0, index - 1));
                            }}
                          >
                            Remove this batch
                          </Button>
                        </Toolbar>
                        {frozen && (
                          <section className="plan-review" aria-label={`Frozen review ${stage.id}`}>
                            <h3>Review this batch</h3>
                            {draft.active !== "preparing" && (
                              <OperationPanel
                                operations={operations}
                                intention={frozen.intentionId}
                                processing={context.client.processing}
                              />
                            )}
                            <p>
                              <strong>
                                {frozen.preview.expandedOperationCount} changes after expanding
                                templates
                              </strong>{" "}
                              · Planned operations:{" "}
                              {(() => {
                                const source = jsonField(frozen.params, "operations");
                                return source?.kind === "array"
                                  ? source.items.length
                                  : "unavailable";
                              })()}
                              .
                            </p>
                            <p className="wg-hint">
                              Review checks use the recorded state. Workgraph checks current
                              requirements again when you apply. Generated IDs are only reserved
                              after the changes are committed.
                            </p>
                            {!frozen.prepared && (
                              <Button
                                disabled={draft.active !== null || pendingForms.size > 0}
                                onClick={() => launch(controller.prepare(draft.id, stage.id))}
                              >
                                {frozen.captured
                                  ? "Inspect or continue exact captured preparation"
                                  : "Save native operation (do not execute)"}
                              </Button>
                            )}
                          </section>
                        )}
                      </>
                    )
                  );
                })()}
              </>
            )}
          </>
        ) : (
          <p className="plan-notice">
            Structured controls are unavailable for this exact source. Parse or repair the source
            below; previously captured operations remain retained.
          </p>
        )}
      </fieldset>
      <details className="plan-secondary">
        <summary>Copy or restore saved actions</summary>
        <p>
          Copy makes a separate draft. Restore checks saved action journals without applying or
          retrying them.
        </p>
        <Toolbar label="Draft recovery actions">
          <Button disabled={blocked} onClick={() => controller.copy(draft.id)}>
            Copy into a new draft
          </Button>
          <Button disabled={blocked} onClick={() => launch(controller.restoreOperations(draft.id))}>
            Restore saved actions
          </Button>
        </Toolbar>
      </details>
      <details className="plan-raw">
        <summary>Advanced: edit plan source</summary>
        <label>
          Plan source
          <textarea
            aria-label="Exact plan source"
            value={draft.source}
            disabled={blocked}
            spellCheck={false}
            onChange={(event) => controller.edit(draft.id, event.currentTarget.value)}
          />
        </label>
        <Button disabled={blocked} onClick={() => launch(controller.parse(draft.id))}>
          Parse current source
        </Button>
      </details>
      <details className="plan-secondary">
        <summary>If saving an action is interrupted</summary>
        <p className="wg-hint">
          If saving an action is interrupted, keep the saved action identity. If no journal ID
          returned, use Administration journal recovery to locate its exact intention; do not
          rebuild an uncertain write.
        </p>
      </details>
    </article>
  );
}
function TemplateSourceEditor({
  draft,
  context,
  controller,
  launch,
}: { readonly draft: PlanDraft; readonly launch: (task: Promise<unknown>) => void } & Omit<
  PlansFeatureProps,
  "view"
> & { readonly onIssue: (error: unknown) => void }) {
  const contract = useMethod(context.client, "template.register"),
    source = templateSourceOperation(draft.document),
    specSchema = contract.value?.fields.fields.find((field) => field.name === "spec")?.schema;
  if (source === null || draft.document === null) return null;
  const document = draft.document;
  const field = (name: string, value: string) =>
    launch(
      controller.replaceDocument(draft.id, {
        ...document,
        stages: document.stages.map((stage) => ({
          ...stage,
          operations: [{ ...source, params: setField(source.params, name, d.jsonString(value)) }],
        })),
      }),
    );
  return (
    <section aria-label="Template source editor">
      <h3>Reusable workflow template</h3>
      <p>
        Describe the tasks, their order, who can work on them and who should review them. An alias
        is a short name used to connect tasks before they have real ticket IDs. Build publication
        draft creates a separate reviewable plan; it does not publish the template.
      </p>
      <div className="plan-grid">
        <Field
          label="Template ID"
          value={text(jsonField(source.params, "resource_id"))}
          onChange={(event) => field("resource_id", event.currentTarget.value)}
        />
        <details className="plan-secondary">
          <summary>Updating an existing template?</summary>
          <p>
            Leave the revision at 0 for a new template. When replacing an existing resource, use its
            current metadata revision so another edit cannot be overwritten.
          </p>
          <Field
            label="Expected resource metadata revision"
            value={text(jsonField(source.params, "expected_revision"))}
            onChange={(event) => field("expected_revision", event.currentTarget.value)}
            hint="0 creates a new resource. This is not its template content version."
          />
        </details>
        <Field
          label="Published template title"
          value={text(jsonField(source.params, "title"))}
          onChange={(event) => field("title", event.currentTarget.value)}
        />
      </div>
      {contract.issue && <p role="alert">{contract.issue}</p>}
      {specSchema && draft.templateSpec ? (
        <SchemaForm
          schema={specSchema}
          value={draft.templateSpec}
          name="Template specification"
          onChange={(spec) => {
            if (spec.kind === "object") launch(controller.replaceTemplateSpec(draft.id, spec));
          }}
        />
      ) : (
        <p role="status">Load or repair the template specification to use structured controls.</p>
      )}
      <Button
        tone="primary"
        disabled={draft.parsedRevision !== draft.revision || draft.active !== null}
        onClick={() => launch(controller.canonicalizeTemplate(draft.id))}
      >
        Build publication draft
      </Button>
      <p className="wg-hint">
        The native helper computes canonical content/version/digest from the exact resource guard.
        This preview is not journaled until its separate publication draft is saved as a native
        operation. Native instance expansion/count limits remain authoritative.
      </p>
    </section>
  );
}
function AliasTable({ draft }: { readonly draft: PlanDraft }) {
  const [shown, setShown] = useState(100),
    rows =
      draft.document?.stages.flatMap((stage, index) =>
        stage.operations.flatMap((op, at) =>
          op.method === "ticket.create"
            ? [
                {
                  key: `${index}:${at}`,
                  stage: stage.title,
                  alias: op.alias === null ? "No alias" : `$${op.alias}`,
                  title: text(jsonField(op.params, "title")),
                  parent: text(jsonField(op.params, "parent_ticket_id")),
                  dependencies: stage.operations
                    .filter(
                      (edge) =>
                        edge.method === "dependency.add" &&
                        text(jsonField(edge.params, "ticket_id")) === `$${op.alias}`,
                    )
                    .map((edge) => text(jsonField(edge.params, "prerequisite_id")))
                    .join(", "),
                },
              ]
            : [],
        ),
      ) ?? [];
  return (
    <details className="plan-aliases">
      <summary>
        Preview planned tickets and dependencies · {rows.length} proposed work items
      </summary>
      <p className="wg-hint">
        Local declarations only. Aliases are scoped to their batch; these are not Workgraph ticket
        IDs or live readiness.
      </p>
      <table>
        <thead>
          <tr>
            <th>Batch</th>
            <th>Local alias</th>
            <th>Proposed title</th>
            <th>Parent</th>
            <th>Prerequisites</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, shown).map((row) => (
            <tr key={row.key}>
              <td>{row.stage}</td>
              <td>
                <code>{row.alias}</code>
              </td>
              <td>{row.title}</td>
              <td>{row.parent || "None declared"}</td>
              <td>{row.dependencies || "None declared"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown < rows.length && (
        <Button onClick={() => setShown(shown + 100)}>Show next100 proposed items</Button>
      )}
    </details>
  );
}
