import { useEffect, useEffectEvent, useState } from "react";
import { Button, Field, Select, Toolbar } from "../../../components/Primitives";
import type { JsonValue } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import type { ProtocolProcessor } from "../../../core/protocol/worker";
import { VALUE_LIMITS } from "./codecs";
import { FactInputError, parseValue } from "./model";

/** Human-readable field location; escaped JSON pointer segments remain exact internally. */
function fieldPath(path: string): string {
  return path === "$"
    ? "Value"
    : path
        .slice(2)
        .split("/")
        .map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~") || '""')
        .join(" › ");
}
function empty(kind: string): JsonValue {
  switch (kind) {
    case "object":
      return d.jsonObject([]);
    case "array":
      return d.jsonArray([]);
    case "string":
      return d.jsonString("");
    case "number":
      return d.jsonNumber("0");
    case "boolean":
      return d.jsonBoolean(false);
    default:
      return d.jsonNull();
  }
}
function NumberInput({
  value,
  path,
  disabled,
  change,
}: {
  readonly value: string;
  readonly path: string;
  readonly disabled: boolean;
  readonly change: (v: JsonValue) => void;
}) {
  return (
    <Field
      label={`${fieldPath(path)} · Number`}
      value={value}
      disabled={disabled}
      hint="Enter a number, such as 42 or 1.5. Large integers and exact number spellings are preserved."
      onChange={(event) => {
        const next = event.currentTarget.value;
        change(d.jsonNumber(next));
      }}
    />
  );
}
function ObjectField({
  name,
  path,
  disabled,
  onRename,
}: {
  readonly name: string;
  readonly path: string;
  readonly disabled: boolean;
  readonly onRename: (s: string) => void;
}) {
  const [text, setText] = useState(name);
  return (
    <div className="fact-inline">
      <Field
        label={`Field name · ${fieldPath(path)}`}
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <Button disabled={disabled || text === name} onClick={() => onRename(text)}>
        Rename field
      </Button>
    </div>
  );
}
function NodeEditor({
  value,
  path,
  change,
  disabled,
}: {
  readonly value: JsonValue;
  readonly path: string;
  readonly change: (v: JsonValue) => void;
  readonly disabled: boolean;
}) {
  const [newName, setNewName] = useState("");
  return (
    <fieldset className="fact-node" disabled={disabled}>
      <legend>{fieldPath(path)}</legend>
      <Select
        label={`${fieldPath(path)} · Type`}
        value={value.kind}
        onChange={(event) => change(empty(event.currentTarget.value))}
      >
        {["object", "array", "string", "number", "boolean", "null"].map((kind) => (
          <option key={kind} value={kind}>
            {kind === "object"
              ? "Object · named fields"
              : kind === "array"
                ? "Array · ordered list"
                : kind === "string"
                  ? "String · text"
                  : kind === "boolean"
                    ? "Boolean · true or false"
                    : kind === "null"
                      ? "Null · intentionally empty"
                      : "Number"}
          </option>
        ))}
      </Select>
      <p className="wg-hint">
        Changing the type replaces this value with an empty value of that type.
      </p>
      {value.kind === "object" && (
        <p className="wg-hint">
          Add named fields for related information, such as a summary and a ready flag. Each field
          has its own value type.
        </p>
      )}
      {value.kind === "array" && (
        <p className="wg-hint">
          Add items in order. Each item can be text, a number or a more detailed value. Item
          positions start at 0.
        </p>
      )}
      {value.kind === "string" && (
        <Field
          label={`${fieldPath(path)} · Text`}
          value={value.value}
          onChange={(event) => change(d.jsonString(event.currentTarget.value))}
        />
      )}
      {value.kind === "number" && (
        <NumberInput value={value.lexeme} path={path} disabled={disabled} change={change} />
      )}
      {value.kind === "boolean" && (
        <label>
          <input
            type="checkbox"
            checked={value.value}
            onChange={(event) => change(d.jsonBoolean(event.currentTarget.checked))}
          />
          {fieldPath(path)} is true
        </label>
      )}
      {value.kind === "null" && (
        <p className="wg-hint">
          This stores null: an intentionally empty value. It does not delete the fact.
        </p>
      )}
      {value.kind === "array" && (
        <>
          {value.items.map((item, index) => (
            <div className="fact-child" key={index}>
              <NodeEditor
                value={item}
                path={`${path}/${index}`}
                disabled={disabled}
                change={(next) =>
                  change(d.jsonArray(value.items.map((v, i) => (i === index ? next : v))))
                }
              />
              <Button
                onClick={() => change(d.jsonArray(value.items.filter((_, i) => i !== index)))}
              >
                Remove item {index}
              </Button>
            </div>
          ))}
          <Button onClick={() => change(d.jsonArray([...value.items, d.jsonNull()]))}>
            Add array item
          </Button>
        </>
      )}
      {value.kind === "object" && (
        <>
          {value.fields.map((field, index) => (
            <div className="fact-child" key={`${index}:${field.name}`}>
              <ObjectField
                name={field.name}
                path={`${path}/${field.name.replace(/~/gu, "~0").replace(/\//gu, "~1")}`}
                disabled={disabled}
                onRename={(name) =>
                  change(
                    d.jsonObject(
                      value.fields.map((f, i) => [i === index ? name : f.name, f.value]),
                    ),
                  )
                }
              />
              <NodeEditor
                value={field.value}
                path={`${path}/${field.name.replace(/~/gu, "~0").replace(/\//gu, "~1")}`}
                disabled={disabled}
                change={(next) =>
                  change(
                    d.jsonObject(
                      value.fields.map((f, i) => [f.name, i === index ? next : f.value]),
                    ),
                  )
                }
              />
              <Button
                onClick={() =>
                  change(
                    d.jsonObject(
                      value.fields.filter((_, i) => i !== index).map((f) => [f.name, f.value]),
                    ),
                  )
                }
              >
                Remove field {field.name}
              </Button>
            </div>
          ))}
          <div className="fact-inline">
            <Field
              label={`New field name · ${fieldPath(path)}`}
              placeholder="For example, summary"
              value={newName}
              onChange={(event) => setNewName(event.currentTarget.value)}
            />
            <Button
              onClick={() => {
                change(
                  d.jsonObject([
                    ...value.fields.map((f) => [f.name, f.value] as const),
                    [newName, d.jsonNull()],
                  ]),
                );
                setNewName("");
              }}
            >
              Add object field
            </Button>
          </div>
        </>
      )}
    </fieldset>
  );
}
/** Structured edits serialize the entire retained value; raw source never loses invalid input. */
export function ValueEditor({
  source,
  candidate,
  onCandidate,
  onEncoded,
  onChange,
  processing,
  disabled,
  onBlocked,
}: {
  readonly source: string;
  readonly candidate: JsonValue | undefined;
  readonly onCandidate: (value: JsonValue) => void;
  readonly onEncoded: (source: string, value: JsonValue) => void;
  readonly onChange: (s: string) => void;
  readonly processing: ProtocolProcessor;
  readonly disabled: boolean;
  readonly onBlocked: (blocked: boolean) => void;
}) {
  const [mode, setMode] = useState<"structured" | "raw">("structured");
  const [observed, setObserved] = useState<{
    readonly source: string;
    readonly candidate: JsonValue | undefined;
    readonly value: JsonValue | undefined;
    readonly issue: string | null;
    readonly unexpected: { readonly error: unknown } | null;
  } | null>(null);
  const accept = useEffectEvent(onEncoded);
  const rawSource = candidate === undefined ? source : null;
  useEffect(() => {
    const owner = new AbortController();
    const failed = (error: unknown) => {
      if (owner.signal.aborted) return;
      setObserved({
        source: rawSource ?? "",
        candidate,
        value: candidate,
        issue: error instanceof FactInputError ? error.message : null,
        unexpected: error instanceof FactInputError ? null : { error },
      });
    };
    if (candidate === undefined) {
      if (rawSource === null) throw new Error("Missing raw editor source");
      void parseValue(processing, rawSource, owner.signal)
        .then((value) => {
          if (!owner.signal.aborted)
            setObserved({ source: rawSource, candidate, value, issue: null, unexpected: null });
        })
        .catch(failed);
    } else {
      void processing
        .encode(candidate, { limits: VALUE_LIMITS, signal: owner.signal })
        .then((result) => {
          if (owner.signal.aborted) return;
          if (!result.ok) {
            failed(new FactInputError(result.failure.message));
            return;
          }
          if (!result.value.ok) {
            failed(new FactInputError(result.value.error.message));
            return;
          }
          setObserved({
            source: rawSource ?? "",
            candidate,
            value: candidate,
            issue: null,
            unexpected: null,
          });
          accept(result.value.value, candidate);
        })
        .catch(failed);
    }
    return () => owner.abort();
  }, [candidate, rawSource, processing]);
  const matches =
    observed !== null &&
    (candidate === undefined
      ? observed.source === source && observed.candidate === undefined
      : observed.candidate === candidate);
  const busy = !matches,
    issue = matches ? observed.issue : null,
    tree = candidate ?? (matches ? observed.value : undefined),
    blocked = busy || issue !== null;
  useEffect(() => {
    onBlocked(blocked);
    return () => onBlocked(false);
  }, [blocked, onBlocked]);
  if (matches && observed.unexpected !== null) throw observed.unexpected.error;
  return (
    <div className="fact-editor">
      <Toolbar label="Fact value editor mode">
        <Button aria-pressed={mode === "structured"} onClick={() => setMode("structured")}>
          Structured value
        </Button>
        <Button aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>
          Raw JSON source
        </Button>
      </Toolbar>
      <p className="wg-hint">
        Use the form for everyday edits, or JSON source to paste a complete value. Saving replaces
        the whole value, not just one field. Facts hold up to 4 KiB (4096 encoded bytes), with at
        most 16 nested levels; use a resource for larger notes or files.
      </p>
      {busy && <p role="status">Validating fact value…</p>}
      {issue !== null && (
        <p role="alert">{issue} Repair the structured value or raw source before Review.</p>
      )}
      {mode === "raw" ? (
        <div className="wg-field">
          <label htmlFor="fact-json-source">Fact JSON source</label>
          {candidate !== undefined && blocked && (
            <p role="alert">
              An unapplied structured candidate is retained. This is the previous raw source;
              editing it explicitly replaces that candidate.
            </p>
          )}
          <p className="wg-hint">
            Text uses double quotes, such as "ready". An object uses named fields, such as {"{"}
            "ready": true, "summary": "Reviewed"{"}"}. JSON null is a stored value, not a deletion.
          </p>
          <textarea
            id="fact-json-source"
            aria-label="Fact JSON source"
            value={source}
            disabled={disabled}
            rows={10}
            spellCheck={false}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </div>
      ) : tree !== undefined ? (
        <NodeEditor value={tree} path="$" disabled={disabled} change={onCandidate} />
      ) : (
        <p>Open Raw JSON source to repair this value.</p>
      )}
    </div>
  );
}
