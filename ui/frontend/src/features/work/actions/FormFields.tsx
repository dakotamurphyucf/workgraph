import { PRIORITY_LABEL, STATUS_LABEL } from "../views/labels";
import { useId } from "react";
import { Button, Field, Select } from "../../../components/Primitives";
import type { FormField, FormInput, PathRow, PinRow, ScalarField, ScalarInput } from "./types";

const PIN_KINDS = [
  "resource",
  "event",
  "commit",
  "checksum",
  "comment",
  "amendment",
  "contract",
  "decision",
] as const;
function ScalarControl({
  field,
  value,
  disabled,
  change,
}: {
  readonly field: ScalarField;
  readonly value: ScalarInput;
  readonly disabled: boolean;
  readonly change: (value: FormInput) => void;
}) {
  const id = useId(),
    unavailable = disabled;
  const text = value.presence === "value" ? value.text : "";
  const update = (text: string) => change({ ...value, presence: "value", text });
  return (
    <div className="work-action-field">
      {field.name === "priority" ? (
        <Select
          label="Priority"
          value={text}
          disabled={unavailable}
          onChange={(event) => update(event.target.value)}
        >
          <option value="">Leave unchanged</option>
          {Object.entries(PRIORITY_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      ) : field.type === "multiline" ? (
        <div className="wg-field">
          <label htmlFor={id}>{field.label}</label>
          <textarea
            id={id}
            value={text}
            disabled={unavailable}
            rows={field.name === "description" || field.name === "source_body" ? 4 : 3}
            onChange={(event) => update(event.target.value)}
          />
        </div>
      ) : field.type === "enum" || field.type === "boolean" ? (
        <Select
          label={field.label}
          value={text}
          disabled={unavailable}
          onChange={(event) => update(event.target.value)}
        >
          <option value="">Choose…</option>
          {(field.type === "boolean" ? ["true", "false"] : (field.choices ?? [])).map((choice) => (
            <option value={choice} key={choice}>
              {choice === "new"
                ? "Create a new record"
                : choice === "loaded"
                  ? "Edit a loaded record"
                  : choice === "true"
                    ? "Yes"
                    : choice === "false"
                      ? "No"
                      : (STATUS_LABEL[choice as keyof typeof STATUS_LABEL] ?? choice)}
            </option>
          ))}
        </Select>
      ) : (
        <Field
          label={field.label}
          value={text}
          disabled={unavailable}
          inputMode={field.type === "counter" ? "numeric" : undefined}
          autoComplete="off"
          spellCheck={field.type === "text"}
          onChange={(event) => update(event.target.value)}
        />
      )}
      {(field.optional || field.nullable) && (
        <details className="work-field-options">
          <summary>
            {value.presence === "null"
              ? "Cleared"
              : value.presence === "omit"
                ? "Not set · options"
                : "Change options"}
          </summary>
          <Select
            label={`${field.label} update`}
            value={value.presence}
            disabled={disabled}
            onChange={(event) => {
              const presence = event.target.value;
              if (presence === "omit" || presence === "null" || presence === "value")
                change({ ...value, presence });
            }}
          >
            {field.optional && <option value="omit">Keep existing / leave unspecified</option>}
            <option value="value">Set value</option>
            {field.nullable && <option value="null">Clear value</option>}
          </Select>
        </details>
      )}
      {field.hint && <p className="wg-hint">{field.hint}</p>}
    </div>
  );
}
export function FormFields({
  fields,
  values,
  disabled,
  change,
  secondaryFields = [],
  secondaryLabel = "Optional details",
}: {
  readonly secondaryFields?: readonly string[];
  readonly secondaryLabel?: string;
  readonly fields: readonly FormField[];
  readonly values: Readonly<Record<string, FormInput>>;
  readonly disabled: boolean;
  readonly change: (name: string, value: FormInput) => void;
}) {
  if (secondaryFields.length > 0) {
    const secondary = new Set(secondaryFields);
    return (
      <>
        <FormFields
          fields={fields.filter((field) => !secondary.has(field.name))}
          values={values}
          disabled={disabled}
          change={change}
        />
        <details className="work-action-secondary">
          <summary>{secondaryLabel}</summary>
          <FormFields
            fields={fields.filter((field) => secondary.has(field.name))}
            values={values}
            disabled={disabled}
            change={change}
          />
        </details>
      </>
    );
  }
  return (
    <div className="work-action-fields">
      {fields.map((field) => {
        const value = values[field.name];
        if (value === undefined || value.kind !== field.kind)
          throw new Error(`Generated form input differs from its definition: ${field.name}`);
        if (field.kind === "scalar" && value.kind === "scalar") {
          const source = values.source_kind;
          if (
            source?.kind === "scalar" &&
            ((field.name === "source_body" && source.text !== "text") ||
              (["resource_id", "resource_revision", "resource_digest"].includes(field.name) &&
                source.text !== "resource"))
          )
            return null;
          return (
            <ScalarControl
              key={field.name}
              field={field}
              value={value}
              disabled={disabled}
              change={(next) => change(field.name, next)}
            />
          );
        }
        if (field.kind === "paths" && value.kind === "paths") {
          const update = (index: number, patch: Partial<PathRow>) =>
            change(field.name, {
              kind: "paths",
              rows: value.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
            });
          return (
            <fieldset key={field.name} className="work-action-collection" disabled={disabled}>
              <legend>
                {field.label} ({value.rows.length}/{field.maxRows})
              </legend>
              {value.rows.map((row, index) => (
                <div key={index} className="work-action-row">
                  <Field
                    label={`Path ${index + 1} worktree`}
                    value={row.worktreeId}
                    onChange={(event) => update(index, { worktreeId: event.target.value })}
                  />
                  <Select
                    label={`Path ${index + 1} kind`}
                    value={row.kind}
                    onChange={(event) => {
                      if (event.target.value === "file" || event.target.value === "subtree")
                        update(index, { kind: event.target.value });
                    }}
                  >
                    <option value="file">File</option>
                    <option value="subtree">Subtree</option>
                  </Select>
                  <Field
                    label={`Path ${index + 1} relative path`}
                    value={row.path}
                    onChange={(event) => update(index, { path: event.target.value })}
                  />
                  <Select
                    label={`Path ${index + 1} mode`}
                    value={row.mode}
                    onChange={(event) => {
                      if (event.target.value === "exclusive" || event.target.value === "shared")
                        update(index, { mode: event.target.value });
                    }}
                  >
                    <option value="exclusive">Exclusive</option>
                    <option value="shared">Shared</option>
                  </Select>
                  <Button
                    onClick={() =>
                      change(field.name, {
                        kind: "paths",
                        rows: value.rows.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove path {index + 1}
                  </Button>
                </div>
              ))}
              <Button
                disabled={value.rows.length >= field.maxRows}
                onClick={() =>
                  change(field.name, {
                    kind: "paths",
                    rows: [
                      ...value.rows,
                      { worktreeId: "", kind: "file", path: "", mode: "exclusive" },
                    ],
                  })
                }
              >
                Add logical path
              </Button>
              {field.hint && <p className="wg-hint">{field.hint}</p>}
            </fieldset>
          );
        }
        if (field.kind === "amendments" && value.kind === "amendments")
          return (
            <fieldset key={field.name} className="work-action-collection" disabled={disabled}>
              <legend>
                {field.label} ({value.rows.length}/{field.maxRows})
              </legend>
              {value.rows.map((row, index) => (
                <div className="work-action-row" key={index}>
                  <Field
                    label={`Superseded amendment ${index + 1} ID`}
                    value={row.amendmentId}
                    onChange={(event) =>
                      change(field.name, {
                        kind: "amendments",
                        rows: value.rows.map((item, i) =>
                          i === index ? { ...item, amendmentId: event.target.value } : item,
                        ),
                      })
                    }
                  />
                  <Field
                    label={`Superseded amendment ${index + 1} version`}
                    value={row.revision}
                    inputMode="numeric"
                    onChange={(event) =>
                      change(field.name, {
                        kind: "amendments",
                        rows: value.rows.map((item, i) =>
                          i === index ? { ...item, revision: event.target.value } : item,
                        ),
                      })
                    }
                  />
                  <Button
                    onClick={() =>
                      change(field.name, {
                        kind: "amendments",
                        rows: value.rows.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove superseded amendment {index + 1}
                  </Button>
                </div>
              ))}
              <Button
                disabled={value.rows.length >= field.maxRows}
                onClick={() =>
                  change(field.name, {
                    kind: "amendments",
                    rows: [...value.rows, { amendmentId: "", revision: "" }],
                  })
                }
              >
                Add superseded amendment
              </Button>
            </fieldset>
          );
        if (field.kind === "pins" && value.kind === "pins") {
          const update = (index: number, patch: Partial<PinRow>) =>
            change(field.name, {
              kind: "pins",
              rows: value.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
            });
          return (
            <fieldset key={field.name} className="work-action-collection" disabled={disabled}>
              <legend>
                {field.label} ({value.rows.length}/{field.maxRows})
              </legend>
              {value.rows.map((row, index) => (
                <div className="work-action-row" key={index}>
                  <Select
                    label={`Evidence ${index + 1} kind`}
                    value={row.kind}
                    onChange={(event) => {
                      const kind = PIN_KINDS.find((kind) => kind === event.target.value);
                      if (kind !== undefined) update(index, { kind });
                    }}
                  >
                    {PIN_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </Select>
                  {row.kind !== "commit" && row.kind !== "checksum" && (
                    <Field
                      label={`Evidence ${index + 1} identity`}
                      value={row.identity}
                      onChange={(event) => update(index, { identity: event.target.value })}
                    />
                  )}
                  {row.kind !== "commit" && row.kind !== "checksum" && (
                    <Field
                      label={`Evidence ${index + 1} ${row.kind === "event" ? "sequence" : "version"}`}
                      value={row.revision}
                      inputMode="numeric"
                      onChange={(event) => update(index, { revision: event.target.value })}
                    />
                  )}
                  {(row.kind === "resource" ||
                    row.kind === "commit" ||
                    row.kind === "checksum") && (
                    <Field
                      label={`Evidence ${index + 1} ${row.kind === "commit" ? "commit object ID" : "SHA-256"}`}
                      value={row.digest}
                      onChange={(event) => update(index, { digest: event.target.value })}
                    />
                  )}
                  {(row.kind === "commit" || row.kind === "checksum") && (
                    <Field
                      label={`Evidence ${index + 1} ${row.kind === "commit" ? "repository" : "source"}`}
                      value={row.source}
                      onChange={(event) => update(index, { source: event.target.value })}
                    />
                  )}
                  <Button
                    onClick={() =>
                      change(field.name, {
                        kind: "pins",
                        rows: value.rows.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove evidence {index + 1}
                  </Button>
                </div>
              ))}
              <Button
                disabled={value.rows.length >= field.maxRows}
                onClick={() =>
                  change(field.name, {
                    kind: "pins",
                    rows: [
                      ...value.rows,
                      { kind: "resource", identity: "", revision: "", digest: "", source: "" },
                    ],
                  })
                }
              >
                Add evidence pin
              </Button>
            </fieldset>
          );
        }
        throw new Error(`Generated form collection differs from its definition: ${field.name}`);
      })}
    </div>
  );
}
