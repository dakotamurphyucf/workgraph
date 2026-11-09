import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { LazyDetails } from "../../connections/shared";
import { Button, Field, Select } from "../../../components/Primitives";
import * as d from "../../../core/protocol/decoders";
import { jsonField, type JsonValue } from "../../../core/json";
import {
  defaultValue,
  chooseVariant,
  variantLabel,
  expandSchema,
  label,
  matchesShape,
  schemaChoices,
  schemaField,
  setField,
  text,
} from "./schema";

const FIELD_HELP: Readonly<Record<string, string>> = {
  nodes:
    "Each task becomes a ticket when this template is used. Give it a short alias to connect it to other tasks.",
  parameters:
    "Inputs supplied when someone uses this template, such as a feature name or target project.",
  depends_on: "Aliases of tasks that must finish before this task is ready to begin.",
  allowed_actor_ids:
    "Optional list of actors allowed to claim this work. An actor is a person or agent identity in Workgraph.",
  capabilities:
    "Skills a run must declare before it can claim this task, such as coding or review.",
  reviewers: "People or reviewer roles whose approval is required for completion.",
  separate_actor: "Require the reviewer and the person submitting the work to be different actors.",
  prerequisites: "Aliases of tasks that must finish before this task is ready to begin.",
  parent:
    "An optional parent task that groups this work. Grouping alone does not make it a prerequisite.",
  admission: "Rules describing which actors or runs may claim this task.",
  review: "Requirements for reviewing the result before the task can be completed.",
  metadata: "Optional planning details such as priority, labels and assignment.",
};

/** Bounded structured projection. Omitted rows and large scalar content remain in exact source. */
export function SchemaForm(props: {
  readonly schema: JsonValue;
  readonly value: JsonValue;
  readonly onChange: (value: JsonValue) => void;
  readonly name: string;
  readonly onPending?: (pending: boolean) => void;
}) {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const track = useCallback(
    (key: string, active: boolean) =>
      setPending((old) => {
        if (old.has(key) === active) return old;
        const next = new Set(old);
        if (active) next.add(key);
        else next.delete(key);
        return next;
      }),
    [],
  );
  const pendingOwner = useRef(props.onPending);
  useEffect(() => {
    pendingOwner.current = props.onPending;
  }, [props.onPending]);
  useEffect(() => {
    pendingOwner.current?.(pending.size > 0);
  }, [pending]);
  useEffect(() => () => pendingOwner.current?.(false), []);
  const resolved = useMemo(() => expandSchema(props.schema), [props.schema]);
  if (resolved === null)
    return (
      <p role="status">
        {props.name}: this schema reference is unsupported or exceeds the form budget. Exact values
        are retained; use exact source to edit.
      </p>
    );
  return <SchemaControls {...props} schema={resolved} trackPending={track} />;
}
function SchemaControls({
  schema,
  value,
  onChange,
  name,
  depth = 0,
  labelled = true,
  trackPending,
}: {
  readonly schema: JsonValue;
  readonly value: JsonValue;
  readonly onChange: (value: JsonValue) => void;
  readonly name: string;
  readonly depth?: number;
  /** A chosen variant is already named by its enclosing fieldset. */
  readonly labelled?: boolean;
  readonly trackPending: (key: string, pending: boolean) => void;
}) {
  const [shown, setShown] = useState(32);
  if (depth > 10)
    return <p className="wg-hint">{name}: nested content is retained in exact source.</p>;
  const choices = schemaChoices(schema);
  if (choices.length > 0) {
    const selected = choices.findIndex((choice) => matchesShape(choice, value)),
      current = selected < 0 ? null : choices[selected];
    return (
      <fieldset className="plan-value">
        <legend>{name}</legend>
        <Select
          label={`${name} kind`}
          value={selected}
          onChange={(event) => {
            const choice = choices[Number(event.currentTarget.value)];
            if (choice) onChange(chooseVariant(choice, value));
          }}
        >
          <option value={-1}>Choose a supported form</option>
          {choices.map((choice, index) => (
            <option key={index} value={index}>
              {variantLabel(choice, name, index)}
            </option>
          ))}
        </Select>
        {current && (
          <SchemaControls
            trackPending={trackPending}
            schema={current}
            labelled={false}
            value={value}
            onChange={onChange}
            name={name}
            depth={depth + 1}
          />
        )}
      </fieldset>
    );
  }
  const fixed = schemaField(schema, "const");
  if (fixed !== undefined)
    return (
      <p
        className={matchesShape(schema, value) ? "wg-hint" : "wg-error"}
        role={matchesShape(schema, value) ? undefined : "alert"}
      >
        {name}:{" "}
        {matchesShape(schema, value)
          ? text(fixed) || fixed.kind
          : `Invalid stored ${text(value) || value.kind}; expected ${text(fixed) || fixed.kind}. Exact value retained.`}
      </p>
    );
  const values = schemaField(schema, "enum");
  if (values?.kind === "array" && values.items.every((item) => item.kind === "string")) {
    const selected = values.items.findIndex(
      (item) => item.kind === "string" && value.kind === "string" && item.value === value.value,
    );
    return (
      <Select
        label={name}
        value={selected}
        onChange={(event) => {
          const choice = values.items[Number(event.currentTarget.value)];
          if (choice) onChange(choice);
        }}
      >
        {selected < 0 && (
          <option value={-1} disabled>
            Invalid stored value — retained in exact source
          </option>
        )}
        {values.items.map((item, index) => (
          <option key={index} value={index}>
            {text(item)}
          </option>
        ))}
      </Select>
    );
  }
  if (value.kind === "null") return <p className="wg-hint">{name}: explicit null</p>;
  if (value.kind === "boolean")
    return (
      <label>
        <input
          type="checkbox"
          checked={value.value}
          onChange={(event) => onChange(d.jsonBoolean(event.currentTarget.checked))}
        />
        {name}
      </label>
    );
  if (value.kind === "number")
    return (
      <NumberField
        name={name}
        value={value.lexeme}
        onChange={(lexeme) => onChange(d.jsonNumber(lexeme))}
        trackPending={trackPending}
      />
    );
  if (value.kind === "string")
    return value.value.length > 8192 ? (
      <p className="wg-hint">
        {name}: {value.value.length.toLocaleString()} characters retained; edit in exact source.
      </p>
    ) : (
      <StringField name={name} schema={schema} value={value.value} onChange={onChange} />
    );
  if (value.kind === "array") {
    const itemSchema = schemaField(schema, "items") ?? d.jsonObject([]);
    return (
      <fieldset className="plan-value">
        <legend>
          {name} · {value.items.length}
        </legend>
        {value.items.slice(0, shown).map((item, index) => (
          <div key={index} className="plan-array-row">
            <LazyDetails
              summary={`${name} ${index + 1}${item.kind === "object" && text(jsonField(item, "title")) ? ` · ${text(jsonField(item, "title"))}` : ""}`}
            >
              {" "}
              <SchemaControls
                trackPending={trackPending}
                name={`${name} ${index + 1}`}
                schema={itemSchema}
                value={item}
                onChange={(next) =>
                  onChange(d.jsonArray(value.items.map((old, i) => (i === index ? next : old))))
                }
                depth={depth + 1}
              />
            </LazyDetails>
            <Button
              onClick={() => onChange(d.jsonArray(value.items.filter((_, i) => i !== index)))}
              aria-label={`Remove ${name} ${index + 1}`}
            >
              Remove
            </Button>
          </div>
        ))}
        {value.items.length > shown && (
          <Button onClick={() => setShown(Math.min(128, shown + 32))} disabled={shown >= 128}>
            Show more {name.toLowerCase()} rows ({value.items.length - shown} retained)
          </Button>
        )}
        <Button
          disabled={value.items.length >= 128}
          onClick={() => onChange(d.jsonArray([...value.items, defaultValue(itemSchema)]))}
        >
          Add {name.toLowerCase()} row
        </Button>
      </fieldset>
    );
  }
  const properties = schemaField(schema, "properties"),
    required = schemaField(schema, "required"),
    additional = schemaField(schema, "additionalProperties");
  const known = properties?.kind === "object" ? properties.fields : [],
    names = required?.kind === "array" ? required.items.map(text) : [];
  const advancedNodeFields = new Set([
    "parent",
    "capabilities",
    "allowed_actor_ids",
    "reviewers",
    "separate_actor",
  ]);
  const isTemplateNode =
    known.some((field) => field.name === "alias") &&
    known.some((field) => field.name === "depends_on");
  const advanced = (field: (typeof known)[number]) =>
    isTemplateNode && advancedNodeFields.has(field.name);
  const renderField = (field: (typeof known)[number]) => {
    const current = jsonField(value, field.name),
      enabled = current !== undefined;
    return (
      <div key={field.name}>
        <label>
          {!names.includes(field.name) && (
            <input
              type="checkbox"
              aria-label={`Include ${label(field.name)}`}
              checked={enabled}
              onChange={(event) =>
                onChange(
                  setField(
                    value,
                    field.name,
                    event.currentTarget.checked ? defaultValue(field.value) : undefined,
                  ),
                )
              }
            />
          )}{" "}
          {!names.includes(field.name)
            ? `Include ${label(field.name)}`
            : !enabled
              ? label(field.name)
              : null}
        </label>
        {!enabled && names.includes(field.name) && (
          <Button onClick={() => onChange(setField(value, field.name, defaultValue(field.value)))}>
            Add required {label(field.name)}
          </Button>
        )}
        {FIELD_HELP[field.name] && <p className="plan-field-help">{FIELD_HELP[field.name]}</p>}
        {enabled && (
          <SchemaControls
            trackPending={trackPending}
            name={label(field.name)}
            schema={field.value}
            value={current}
            onChange={(next) => onChange(setField(value, field.name, next))}
            depth={depth + 1}
          />
        )}
      </div>
    );
  };
  return (
    <fieldset className={`plan-value ${labelled ? "" : "plan-value--unframed"}`}>
      {labelled && <legend>{name}</legend>}
      {known
        .slice(0, 64)
        .filter(
          (field) =>
            !advanced(field) &&
            (names.includes(field.name) || jsonField(value, field.name) !== undefined),
        )
        .map(renderField)}
      {isTemplateNode && (
        <details className="plan-secondary">
          <summary>Who can work, review rules and grouping</summary>
          <p className="wg-hint">
            These rules control eligibility and review. Their current values are preserved when this
            section is closed.
          </p>
          {known.slice(0, 64).filter(advanced).map(renderField)}
        </details>
      )}
      {known
        .slice(0, 64)
        .some(
          (field) =>
            !advanced(field) &&
            !names.includes(field.name) &&
            jsonField(value, field.name) === undefined,
        ) && (
        <details className="plan-secondary">
          <summary>More options</summary>
          <p className="wg-hint">
            Add only the optional fields you need. Existing values remain visible above.
          </p>
          {known
            .slice(0, 64)
            .filter(
              (field) =>
                !advanced(field) &&
                !names.includes(field.name) &&
                jsonField(value, field.name) === undefined,
            )
            .map(renderField)}
        </details>
      )}
      {value.fields
        .filter((field) => !known.some((known) => known.name === field.name))
        .slice(0, 32)
        .map((field) => (
          <div key={field.name}>
            <SchemaControls
              trackPending={trackPending}
              name={label(field.name)}
              schema={additional?.kind === "object" ? additional : d.jsonObject([])}
              value={field.value}
              onChange={(next) => onChange(setField(value, field.name, next))}
              depth={depth + 1}
            />
            <Button onClick={() => onChange(setField(value, field.name, undefined))}>
              Remove {label(field.name)}
            </Button>
          </div>
        ))}
      {known.length === 0 && (
        <DictionaryEntry
          schema={additional?.kind === "object" ? additional : d.jsonObject([])}
          onAdd={(key, next) => onChange(setField(value, key, next))}
        />
      )}
    </fieldset>
  );
}
/** Textarea preserves entered LF. HTML normalizes CR/CRLF, so those values stay source-only. */
function StringField({
  name,
  schema,
  value,
  onChange,
}: {
  readonly name: string;
  readonly schema: JsonValue;
  readonly value: string;
  readonly onChange: (value: JsonValue) => void;
}) {
  const id = useId();
  if (value.includes("\r"))
    return (
      <p role="status" className="wg-hint">
        {name}: carriage returns are retained exactly. Edit escaped JSON in Exact plan source;
        structured text editing is unavailable because HTML normalizes CR and CRLF.
      </p>
    );
  const maximum = schemaField(schema, "x-maxUtf8Bytes"),
    pattern = schemaField(schema, "pattern");
  // Match the native decimal contract exactly; do not execute arbitrary schema patterns
  // or infer a string domain from its human field label. Keep textarea editing lossless for LF.
  const decimal = pattern?.kind === "string" && pattern.value === "^(0|[1-9][0-9]*)(?![\\s\\S])";
  const bounded =
    maximum?.kind === "number" &&
    /^[0-9]{1,9}$/u.test(maximum.lexeme) &&
    BigInt(maximum.lexeme) <= 512n;
  const compact = (decimal || bounded) && !value.includes("\n") && value.length <= 512;
  return (
    <div className="wg-field">
      <label htmlFor={id}>{name}</label>
      <textarea
        id={id}
        rows={compact ? 1 : 4}
        value={value}
        onChange={(event) => onChange(d.jsonString(event.currentTarget.value))}
      />
    </div>
  );
}
function DictionaryEntry({
  schema,
  onAdd,
}: {
  readonly schema: JsonValue;
  readonly onAdd: (name: string, value: JsonValue) => void;
}) {
  const [name, setName] = useState("");
  return (
    <div className="plan-inline">
      <Field
        label="New field name"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <Button
        disabled={name.trim() === ""}
        onClick={() => {
          onAdd(name, defaultValue(schema));
          setName("");
        }}
      >
        Add field
      </Button>
    </div>
  );
}

function NumberField({
  name,
  value,
  onChange,
  trackPending,
}: {
  readonly name: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly trackPending: (key: string, pending: boolean) => void;
}) {
  const [source, setSource] = useState(value),
    [base, setBase] = useState(value),
    key = useId(),
    owner = useRef(trackPending),
    dirty = source !== base,
    stale = value !== base;
  const valid = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(source);
  useEffect(() => {
    owner.current = trackPending;
  }, [trackPending]);
  useEffect(() => {
    owner.current(key, dirty || stale);
    return () => owner.current(key, false);
  }, [key, dirty, stale]);
  return (
    <div className="plan-number">
      <Field
        label={name}
        value={source}
        onChange={(event) => setSource(event.currentTarget.value)}
        {...(dirty && !valid
          ? { error: "Enter a complete JSON number; the existing value is unchanged." }
          : {})}
      />
      <Button
        disabled={!dirty || !valid || stale}
        onClick={() => {
          setBase(source);
          onChange(source);
        }}
      >
        Apply numeric value
      </Button>
      {(dirty || stale) && (
        <Button
          onClick={() => {
            setBase(value);
            setSource(value);
          }}
        >
          Revert numeric edit
        </Button>
      )}
      {dirty && (
        <p className="wg-hint">
          Unapplied numeric edit. Apply it to retain the value before reviewing this batch.
        </p>
      )}
      {stale && (
        <p role="alert">
          The source number changed. Revert this editor before applying another value.
        </p>
      )}
    </div>
  );
}
