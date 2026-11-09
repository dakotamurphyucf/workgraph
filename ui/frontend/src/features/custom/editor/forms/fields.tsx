import { useLayoutEffect, useRef, useId, type ReactNode } from "react";
import { Button, Field, Select } from "../../../../components/Primitives";
import * as d from "../../../../core/protocol/decoders";
import type { JsonValue } from "../../../../core/json";
import { ScopeChoice, type ConfigurationReferences } from "../ScopeChoice";
import type { ReferenceKind } from "../../../discussions/reference-choices";
import { fieldHelp } from "./help";
import type { FormDraft } from "./types";
import { arrayEdit, at, change, numberText, pathKey, textAt, variant, type Path } from "./model";
export interface FieldsProps {
  readonly references?: ConfigurationReferences;
  readonly draft: FormDraft;
  readonly onChange: (value: FormDraft) => void;
}
const str = d.jsonString,
  obj = d.jsonObject,
  arr = d.jsonArray;
const valueAt = (draft: FormDraft, path: Path) => at(draft.candidate, path);
export function Text({
  references,
  draft,
  onChange,
  path,
  label,
  number = false,
  hint,
}: FieldsProps & {
  readonly path: Path;
  readonly label: string;
  readonly number?: boolean;
  readonly hint?: string;
}) {
  const issue = draft.errors.find((issue) => pathKey(issue.path) === pathKey(path));
  const filterField =
    path[0] === "filters" && typeof path[1] === "number"
      ? textAt(draft, ["filters", path[1], "field"])
      : "";
  const refKinds: Readonly<Record<string, ReferenceKind | "actor">> = {
    project_id: "project",
    milestone_id: "milestone",
    ticket_id: "ticket",
    run_id: "run",
    target_run_id: "run",
    parent_run_id: "run",
    session_id: "session",
    actor_id: "actor",
    assignee_id: "actor",
    board_id: "board",
    thread_id: "thread",
    resource_id: "resource",
  };
  const refKind =
    path[0] === "filters" && (path[2] === "value" || path[2] === "values")
      ? refKinds[filterField]
      : path.at(-1) === "resource_id"
        ? "resource"
        : undefined;
  if (references && refKind && !number)
    return (
      <div>
        <ScopeChoice
          references={references}
          kind={refKind}
          label={label}
          value={textAt(draft, path)}
          onChange={(id) => onChange(change(draft, path, str(id)))}
        />
        {hint && <p className="wg-hint">{hint}</p>}
      </div>
    );
  return (
    <Field
      label={label}
      value={textAt(draft, path)}
      {...((hint ?? fieldHelp(path)) === undefined ? {} : { hint: hint ?? fieldHelp(path)! })}
      {...(issue === undefined ? {} : { error: issue.message })}
      onChange={(event) =>
        onChange(
          number
            ? numberText(draft, path, event.target.value)
            : change(draft, path, str(event.target.value)),
        )
      }
    />
  );
}
export function Choice({
  draft,
  onChange,
  path,
  label,
  choices,
  onSelect,
  nullable = false,
}: FieldsProps & {
  readonly path: Path;
  readonly label: string;
  readonly choices: readonly string[];
  readonly onSelect?: (value: string) => void;
  readonly nullable?: boolean;
}) {
  const helpId = useId();
  const help = fieldHelp(path);
  const current = valueAt(draft, path),
    selected =
      current?.kind === "string"
        ? current.value
        : current?.kind === "null" && nullable
          ? ""
          : "__missing";
  return (
    <div className="sv-choice">
      <Select
        label={label}
        aria-describedby={help ? helpId : undefined}
        value={selected}
        onChange={(event) =>
          onSelect
            ? onSelect(event.target.value)
            : onChange(
                change(
                  draft,
                  path,
                  nullable && event.target.value === "" ? d.jsonNull() : str(event.target.value),
                ),
              )
        }
      >
        {nullable && <option value="">None</option>}
        {!choices.includes(selected) && !(nullable && selected === "") && (
          <option value={selected}>
            {selected === "__missing" ? "Choose a value" : `Unsupported: ${selected}`}
          </option>
        )}
        {choices.map((value) => (
          <option key={value} value={value}>
            {(
              {
                server: "On the service · before loading",
                loaded: "Already loaded records",
                field: "Known record field",
                pointer: "JSON path · advanced",
                asc: "Ascending · A–Z / oldest first",
                desc: "Descending · Z–A / newest first",
                unix_ms: "Timestamp · milliseconds since 1970",
                enum: "Labeled categories",
                entity_ref: "Link to a record",
                resource_pin: "Link to an exact resource version",
                bytes: "File size",
                ms: "Milliseconds",
                us: "Microseconds",
                ns: "Nanoseconds",
                s: "Seconds",
              } as Readonly<Record<string, string>>
            )[value] ?? value.replace(/_/gu, " ")}
          </option>
        ))}
      </Select>
      {help && (
        <p id={helpId} className="wg-hint">
          {help}
        </p>
      )}
    </div>
  );
}
export function Optional({
  draft,
  onChange,
  path,
  label,
  initial,
  children,
}: FieldsProps & {
  readonly path: Path;
  readonly label: string;
  readonly initial: JsonValue;
  readonly children: ReactNode;
}) {
  const present = valueAt(draft, path) !== undefined;
  return (
    <div className="wg-custom-optional">
      <label>
        <input
          type="checkbox"
          checked={present}
          onChange={(event) =>
            onChange(change(draft, path, event.target.checked ? initial : undefined))
          }
        />{" "}
        {label}
      </label>
      {present && children}
    </div>
  );
}
export function Rows({
  draft,
  onChange,
  path,
  label,
  maximum,
  initial,
  children,
}: FieldsProps & {
  readonly path: Path;
  readonly label: string;
  readonly maximum: number;
  readonly initial: () => JsonValue;
  readonly children: (path: Path, index: number) => ReactNode;
}) {
  const host = useRef<HTMLElement>(null),
    pending = useRef<{ index: number; action: "up" | "down" | "remove" } | null>(null);
  useLayoutEffect(() => {
    const target = pending.current;
    if (target === null || host.current === null) return;
    pending.current = null;
    const rows = host.current.querySelectorAll(":scope > fieldset"),
      row = rows[Math.min(target.index, rows.length - 1)];
    const preferred = row?.querySelector<HTMLButtonElement>(
      `button[data-row-action="${target.action}"]`,
    );
    const control =
      preferred !== null && preferred !== undefined && !preferred.disabled
        ? preferred
        : (row?.querySelector<HTMLElement>(
            "input:not(:disabled),select:not(:disabled),button:not(:disabled)",
          ) ?? host.current.querySelector<HTMLButtonElement>(":scope > button"));
    control?.focus();
  }, [draft]);
  const value = valueAt(draft, path),
    items = value?.kind === "array" ? value.items : [];
  const indices = items.map((_, index) => index);
  function move(index: number, delta: number) {
    const order = [...indices],
      other = order[index + delta];
    if (other === undefined) return;
    order[index + delta] = index;
    order[index] = other;
    pending.current = { index: index + delta, action: delta < 0 ? "up" : "down" };
    onChange(arrayEdit(draft, path, order));
  }
  return (
    <section ref={host} className="wg-custom-rows" aria-label={label}>
      {value?.kind !== "array" && (
        <p className="wg-hint">
          This collection is missing or malformed. Add an item explicitly to repair it; Raw retains
          the original until then.
        </p>
      )}
      {items.map((_, index) => (
        <fieldset className="wg-custom-row" key={index}>
          <legend>
            {label} {index + 1}
          </legend>
          {children([...path, index], index)}
          <div className="wg-toolbar">
            <Button
              data-row-action="up"
              aria-label={`Move ${label} ${index + 1} up`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              ↑
            </Button>
            <Button
              data-row-action="down"
              aria-label={`Move ${label} ${index + 1} down`}
              disabled={index === items.length - 1}
              onClick={() => move(index, 1)}
            >
              ↓
            </Button>
            <Button
              data-row-action="remove"
              onClick={() => {
                pending.current = { index, action: "remove" };
                onChange(
                  arrayEdit(
                    draft,
                    path,
                    indices.filter((i) => i !== index),
                  ),
                );
              }}
            >
              Remove {label} {index + 1}
            </Button>
          </div>
        </fieldset>
      ))}
      <Button
        disabled={items.length >= maximum}
        onClick={() => onChange(arrayEdit(draft, path, indices, [initial()]))}
      >
        Add {label}
      </Button>
      <span className="wg-hint">
        {" "}
        {items.length}/{maximum}
      </span>
    </section>
  );
}
const formats = [
  "text",
  "multiline",
  "boolean",
  "number",
  "bytes",
  "unix_ms",
  "json",
  "entity_ref",
  "resource_pin",
  "duration",
  "enum",
] as const;

export function FormatFields(props: FieldsProps & { readonly path: Path; readonly label: string }) {
  const { draft, onChange, path, label } = props,
    type = textAt(draft, [...path, "type"]);
  return (
    <>
      <Choice
        {...props}
        path={[...path, "type"]}
        label={`${label} format`}
        choices={formats}
        onSelect={(next) =>
          onChange(
            variant(
              draft,
              path,
              ["type", "unit", "values"],
              [
                ["type", str(next)],
                ...(next === "duration"
                  ? [["unit", str("ms")] as const]
                  : next === "enum"
                    ? [
                        [
                          "values",
                          arr([
                            obj([
                              ["value", str("")],
                              ["label", str("Label")],
                              ["tone", str("neutral")],
                            ]),
                          ]),
                        ] as const,
                      ]
                    : []),
              ],
            ),
          )
        }
      />
      {type === "duration" && (
        <Choice
          {...props}
          path={[...path, "unit"]}
          label={`${label} duration unit`}
          choices={["ns", "us", "ms", "s"]}
        />
      )}
      {type === "enum" && (
        <Rows
          {...props}
          path={[...path, "values"]}
          label={`${label} enum value`}
          maximum={32}
          initial={() =>
            obj([
              ["value", str("")],
              ["label", str("Label")],
              ["tone", str("neutral")],
            ])
          }
        >
          {(p, i) => (
            <>
              <Text {...props} path={[...p, "value"]} label={`${label} value ${i + 1}`} />
              <Text {...props} path={[...p, "label"]} label={`${label} label ${i + 1}`} />
              <Choice
                {...props}
                path={[...p, "tone"]}
                label={`${label} tone ${i + 1}`}
                choices={["neutral", "info", "success", "warning", "danger"]}
              />
            </>
          )}
        </Rows>
      )}
    </>
  );
}
export function Scalar(props: FieldsProps & { readonly path: Path; readonly label: string }) {
  const { draft, path, onChange, label } = props,
    current = valueAt(draft, path);
  const kind = current?.kind ?? "missing";
  return (
    <>
      <Select
        label={`${label} type`}
        title="Match the type stored in the record: text, a number, true/false, or an explicit empty value."
        value={kind}
        onChange={(event) => {
          const type = event.target.value;
          onChange(
            change(
              draft,
              path,
              type === "null"
                ? d.jsonNull()
                : type === "boolean"
                  ? d.jsonBoolean(false)
                  : type === "number"
                    ? d.jsonNumber("0")
                    : str(""),
            ),
          );
        }}
      >
        {!["string", "number", "boolean", "null"].includes(kind) && (
          <option value={kind}>Unsupported {kind}</option>
        )}
        {["string", "number", "boolean", "null"].map((kind) => (
          <option key={kind} value={kind}>
            {kind}
          </option>
        ))}
      </Select>
      {(kind === "string" || kind === "number") && <Text {...props} number={kind === "number"} />}
      {kind === "boolean" && (
        <Select
          label={label}
          value={current?.kind === "boolean" && current.value ? "true" : "false"}
          onChange={(event) =>
            onChange(change(draft, path, d.jsonBoolean(event.target.value === "true")))
          }
        >
          <option>true</option>
          <option>false</option>
        </Select>
      )}
      <p className="wg-hint">
        Use the same type as the stored value. For server ticket filters, priority is text 0–4 and
        status is text such as todo or done; include archived and unresolved use true/false.
      </p>
      {kind === "null" && (
        <p className="wg-hint">
          Null matches an explicitly empty value; it does not mean ignore this filter.
        </p>
      )}
    </>
  );
}
export function PinFields(props: FieldsProps & { readonly path: Path; readonly label: string }) {
  return (
    <div className="wg-custom-grid">
      {["resource_id", "version", "digest", "size_bytes"].map((field) => (
        <Text
          {...props}
          key={field}
          path={[...props.path, field]}
          label={`${props.label} ${field.replace(/_/gu, " ")}`}
        />
      ))}
    </div>
  );
}
