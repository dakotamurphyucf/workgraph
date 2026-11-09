import { useState } from "react";
import { Badge, Button, Field, Select, Toolbar } from "../../../components/Primitives";
import { jsonField } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import type { HttpClient } from "../../../core/protocol/http";
import { initialOperation, moveOperation, parameterSchema } from "./authoring";
import { SchemaForm } from "./SchemaForm";
import { useMethod } from "./useMethod";
import { PlanInputError } from "./model";
import { text } from "./schema";
import type {
  PlanDocument,
  PlanOperation,
  PlanStage,
  ReceiptBinding,
  StageExposure,
} from "./types";

const METHODS = [
  ["ticket.create", "Create work"],
  ["dependency.add", "Add prerequisite"],
  ["dependency.remove", "Remove prerequisite"],
  ["ticket.hold", "Hold or release work"],
  ["allocation.ticket_policy_put", "Actor eligibility & capacity"],
  ["review.policy.put", "Reviewers & acceptance gate"],
  ["ticket.metadata", "Planning metadata & criteria"],
  ["ticket.move", "Move placement or parent"],
  ["related.add", "Relate work"],
  ["project.create", "Create project"],
  ["milestone.create", "Create milestone"],
  ["template.instantiate", "Instantiate pinned template"],
  ["fact.put", "Write fact"],
] as const;
const pointer = (path: readonly string[]) =>
  path.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
const segments = (value: string) =>
  value.split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
export function StageEditor({
  http,
  document,
  index,
  locked,
  onChange,
  onIssue,
  onPending,
  projectId,
}: {
  readonly http: HttpClient;
  readonly projectId: string | null;
  readonly document: PlanDocument;
  readonly index: number;
  readonly locked: boolean;
  readonly onChange: (document: PlanDocument) => void;
  readonly onIssue: (error: unknown) => void;
  readonly onPending: (key: string, pending: boolean) => void;
}) {
  const [activated, setActivated] = useState<ReadonlySet<number>>(new Set());
  const stage = document.stages[index],
    [method, setMethod] = useState<string>("ticket.create");
  if (stage === undefined) return null;
  const edit = (patch: Partial<PlanStage>) =>
    onChange({
      ...document,
      stages: document.stages.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    });
  const operation = (at: number, next: PlanOperation) =>
    edit({ operations: stage.operations.map((item, i) => (i === at ? next : item)) });
  const declaration = (at: number, next: StageExposure | undefined) =>
    edit({
      exposures: [
        ...stage.exposures.filter((entry) => entry.operation !== at),
        ...(next === undefined ? [] : [next]),
      ],
    });
  const move = (at: number, to: number, position: number) => {
    try {
      onChange(moveOperation(document, index, at, to, position));
    } catch (error) {
      onIssue(error);
    }
  };
  return (
    <fieldset className="plan-stage" disabled={locked}>
      <legend>
        {stage.title} {locked && "· captured, immutable"}
      </legend>
      <div className="plan-grid">
        <Field
          label="Batch title"
          value={stage.title}
          onChange={(event) => edit({ title: event.currentTarget.value })}
        />
      </div>
      <details className="plan-secondary">
        <summary>Batch settings and later steps</summary>
        <p>
          Most drafts need just one batch. These settings help when you deliberately split a larger
          workflow into separate applications.
        </p>
        <Field
          label="Batch local ID"
          value={stage.id}
          onChange={(event) => edit({ id: event.currentTarget.value })}
        />
        <Field
          label="What remains if later batches are not applied?"
          value={stage.exposure}
          placeholder="What remains incomplete if later batches do not commit?"
          onChange={(event) => edit({ exposure: event.currentTarget.value })}
        />
        <p className="wg-hint">
          Applying this batch does not create the changes planned in later batches. If a task still
          needs more rules or links, keep it on hold until those changes are ready.
        </p>
      </details>
      <div className="plan-section-heading">
        <h3>Changes in this batch</h3>
        <p>Open a change to fill in its details. Add more below when you need them.</p>
      </div>
      {stage.operations.map((op, at) => (
        <details
          className="plan-op"
          key={at}
          onToggle={(event) => {
            if (event.currentTarget.open)
              setActivated((old) => (old.has(at) ? old : new Set([...old, at])));
          }}
        >
          <summary>
            <span>
              {at + 1}. {METHODS.find(([method]) => method === op.method)?.[1] ?? op.method}
            </span>
            <strong>
              {text(jsonField(op.params, "title")) ||
                op.alias ||
                text(jsonField(op.params, "ticket_id")) ||
                "Configure operation"}
            </strong>
            <Badge>{op.alias ? `$${op.alias}` : op.method}</Badge>
          </summary>
          {activated.has(at) && (
            <OperationEditor
              http={http}
              value={op}
              onPending={(active) => onPending(`${stage.id}:${at}`, active)}
              onChange={(next) => operation(at, next)}
            />
          )}
          <details className="plan-secondary">
            <summary>Reorder or remove this change</summary>
            <Toolbar label={`Move operation ${at + 1}`}>
              <Button disabled={at === 0} onClick={() => move(at, index, at - 1)}>
                Move up
              </Button>
              <Button
                disabled={at === stage.operations.length - 1}
                onClick={() => move(at, index, at + 1)}
              >
                Move down
              </Button>
              <Select
                label="Move to batch"
                value=""
                onChange={(event) => {
                  if (event.currentTarget.value !== "")
                    move(
                      at,
                      Number(event.currentTarget.value),
                      document.stages[Number(event.currentTarget.value)]?.operations.length ?? 0,
                    );
                }}
              >
                <option value="">Choose another batch…</option>
                {document.stages.map((other, i) =>
                  i === index ? null : (
                    <option key={other.id} value={i}>
                      {i + 1}. {other.title}
                    </option>
                  ),
                )}
              </Select>
              <Button
                disabled={
                  stage.operations.length === 1 ||
                  stage.bindings.some((binding) => binding.operation === at)
                }
                onClick={() => {
                  if (
                    document.stages.some((other) =>
                      other.bindings.some((binding) => binding.stage === stage.id),
                    )
                  ) {
                    onIssue(
                      new PlanInputError(
                        "Review downstream receipt bindings before removing a producer operation.",
                      ),
                    );
                    return;
                  }
                  edit({
                    operations: stage.operations.filter((_, i) => i !== at),
                    bindings: stage.bindings.map((binding) => ({
                      ...binding,
                      operation: binding.operation > at ? binding.operation - 1 : binding.operation,
                    })),
                    exposures: stage.exposures
                      .filter((entry) => entry.operation !== at)
                      .map((entry) => ({
                        ...entry,
                        operation: entry.operation > at ? entry.operation - 1 : entry.operation,
                      })),
                  });
                }}
              >
                Remove operation
              </Button>
            </Toolbar>
          </details>
          {["ticket.create", "template.instantiate"].includes(op.method) && (
            <Exposure
              value={stage.exposures.find((entry) => entry.operation === at)}
              operation={at}
              template={op.method === "template.instantiate"}
              onChange={(next) => declaration(at, next)}
            />
          )}
        </details>
      ))}
      <Toolbar label="Add planned operation">
        <Select
          label="Operation to add"
          value={method}
          onChange={(event) => setMethod(event.currentTarget.value)}
        >
          {METHODS.map(([name, label]) => (
            <option key={name} value={name}>
              {label}
            </option>
          ))}
        </Select>
        <Button
          disabled={stage.operations.length >= 128}
          onClick={() =>
            edit({
              operations: [
                ...stage.operations,
                initialOperation(method, stage.operations.length, projectId),
              ],
            })
          }
        >
          Add operation
        </Button>
        <span>
          {stage.operations.length}/128 source operations; native expanded count may be larger.
        </span>
      </Toolbar>
      <details className="plan-bindings">
        <summary>Advanced: use results from an earlier batch</summary>
        <p className="wg-hint">
          A binding copies an ID or revision returned by an earlier successful batch into a later
          operation. For example, use the ID of a newly created ticket when adding a dependency.
          Preview IDs cannot be used because the changes have not been committed.
        </p>
        {stage.bindings.map((binding, at) => (
          <BindingRow
            key={at}
            value={binding}
            stages={document.stages.slice(0, index)}
            onChange={(next) =>
              edit({ bindings: stage.bindings.map((old, i) => (i === at ? next : old)) })
            }
            remove={() => edit({ bindings: stage.bindings.filter((_, i) => i !== at) })}
          />
        ))}
        <Button
          disabled={index === 0}
          onClick={() =>
            edit({
              bindings: [
                ...stage.bindings,
                {
                  operation: 0,
                  path: ["ticket_id"],
                  stage: document.stages[index - 1]!.id,
                  receiptPath: ["results", "0", "data", "ticket_id"],
                },
              ],
            })
          }
        >
          Add receipt binding
        </Button>
      </details>
    </fieldset>
  );
}
function OperationEditor({
  http,
  value,
  onChange,
  onPending,
}: {
  readonly http: HttpClient;
  readonly value: PlanOperation;
  readonly onChange: (operation: PlanOperation) => void;
  readonly onPending: (pending: boolean) => void;
}) {
  const contract = useMethod(http, value.method);
  return (
    <>
      <details className="plan-secondary">
        <summary>Advanced: operation name and alias</summary>
        <p>
          An alias is a short name other changes in this batch can use before the ticket has an ID.
        </p>
        <div className="plan-grid">
          <Field
            label="API operation"
            value={value.method}
            onChange={(event) => onChange({ ...value, method: event.currentTarget.value })}
          />
          <Field
            label="Short name / alias (optional)"
            value={value.alias ?? ""}
            onChange={(event) =>
              onChange({
                ...value,
                alias: event.currentTarget.value === "" ? null : event.currentTarget.value,
              })
            }
          />
        </div>
      </details>
      {contract.issue && <p role="alert">{contract.issue}</p>}
      {contract.value === null && !contract.issue ? (
        <p role="status">Loading fields…</p>
      ) : (
        contract.value && (
          <>
            <p className="wg-hint">{contract.value.method.summary}</p>
            <SchemaForm
              schema={parameterSchema(contract.value)}
              value={value.params}
              name="Operation fields"
              onPending={onPending}
              onChange={(params) => {
                if (params.kind === "object") onChange({ ...value, params });
              }}
            />
          </>
        )
      )}
    </>
  );
}
function Exposure({
  value,
  operation,
  template,
  onChange,
}: {
  readonly value: StageExposure | undefined;
  readonly operation: number;
  readonly template: boolean;
  readonly onChange: (value: StageExposure | undefined) => void;
}) {
  return (
    <fieldset className="plan-value">
      <legend>When can agents start this work?</legend>
      <Select
        label="Intended availability"
        value={value?.disposition ?? ""}
        onChange={(event) =>
          onChange(
            event.currentTarget.value === ""
              ? undefined
              : {
                  operation,
                  disposition: event.currentTarget.value === "held" ? "held" : "runnable",
                  deferred:
                    event.currentTarget.value === "held" ? "Review deferred obligations" : "",
                  templateDigest: value?.templateDigest ?? null,
                },
          )
        }
      >
        <option value="">Not declared</option>
        <option value="held">Held until later configuration</option>
        <option value="runnable">Declared runnable intent</option>
      </Select>
      {value && (
        <>
          <Field
            label="Deferred obligations"
            value={value.deferred}
            onChange={(event) => onChange({ ...value, deferred: event.currentTarget.value })}
          />
          {template && (
            <Field
              label="Exact template Spec digest"
              value={value.templateDigest ?? ""}
              onChange={(event) => {
                const digest = d.digest.decode(d.jsonString(event.currentTarget.value));
                onChange({ ...value, templateDigest: digest.ok ? digest.value : null });
              }}
            />
          )}
          <p className="wg-hint">
            Runnable is an intent, never a readiness assertion. Held work needs a final nonempty
            hold in this same atomic batch. Held instances need literal placement or a binding to a
            prior committed receipt.
          </p>
        </>
      )}
    </fieldset>
  );
}
function BindingRow({
  value,
  stages,
  onChange,
  remove,
}: {
  readonly value: ReceiptBinding;
  readonly stages: readonly PlanStage[];
  readonly onChange: (value: ReceiptBinding) => void;
  readonly remove: () => void;
}) {
  return (
    <fieldset className="plan-value">
      <legend>Exact durable receipt substitution</legend>
      <div className="plan-grid">
        <Field
          label="Destination operation (1-based)"
          value={value.operation + 1}
          type="number"
          min={1}
          max={128}
          onChange={(event) => {
            const index = event.currentTarget.valueAsNumber;
            if (Number.isInteger(index) && index >= 1 && index <= 128)
              onChange({ ...value, operation: index - 1 });
          }}
        />
        <Field
          label="Destination field pointer"
          value={pointer(value.path)}
          onChange={(event) => onChange({ ...value, path: segments(event.currentTarget.value) })}
        />
        <Select
          label="Committed source batch"
          value={value.stage}
          onChange={(event) => onChange({ ...value, stage: event.currentTarget.value })}
        >
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.title}
            </option>
          ))}
        </Select>
        <Field
          label="Receipt pointer"
          value={pointer(value.receiptPath)}
          onChange={(event) =>
            onChange({ ...value, receiptPath: segments(event.currentTarget.value) })
          }
        />
      </div>
      <Button onClick={remove}>Remove binding</Button>
    </fieldset>
  );
}
