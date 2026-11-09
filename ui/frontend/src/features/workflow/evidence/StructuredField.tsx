import { useEffect, useRef, useState } from "react";
import { Button, Field, Select } from "../../../components/Primitives";
import { jsonField, type JsonValue } from "../../../core/json";
import * as d from "../../../core/protocol/decoders";
import type { JsonObject } from "../../../core/protocol/types";
import type { ProtocolProcessor } from "../../../core/protocol/worker";
import { HTTP_LIMITS } from "../../../core/protocol/worker/jobs";
import { EvidenceInputError, encoded, objectFields, text } from "./model";
import type { EvidenceField, FieldInput } from "./types";

const obj = (value: JsonValue): JsonObject | null => (value.kind === "object" ? value : null);
const bool = (value: JsonValue, name: string) => {
  const item = jsonField(value, name);
  return item?.kind === "boolean" && item.value;
};
const get = (value: JsonValue, name: string) => text(jsonField(value, name));
const set = (value: JsonObject, name: string, next: JsonValue) =>
  d.jsonObject([...objectFields(value).filter(([key]) => key !== name), [name, next]]);
const record = (fields: readonly (readonly [string, string])[]) =>
  d.jsonObject(fields.map(([name, value]) => [name, d.jsonString(value)]));
const input = (label: string, value: string, change: (value: string) => void) => (
  <Field label={label} value={value} onChange={(event) => change(event.currentTarget.value)} />
);
function Scope({
  value,
  onChange,
  domain = "entity",
}: {
  readonly value: JsonValue;
  readonly onChange: (value: JsonValue) => void;
  readonly domain?: "entity" | "policy" | "inherited-project";
}) {
  const object = obj(value);
  if (object === null)
    return <p role="alert">A scope must be an object. Repair its source below.</p>;
  const kind = get(value, "kind"),
    kinds =
      domain === "inherited-project"
        ? ["project"]
        : domain === "policy"
          ? ["ticket", "project"]
          : ["workspace", "project", "milestone", "ticket", "resource"];
  return (
    <div className="ev-row">
      <Select
        label="Scope kind"
        value={kind}
        onChange={(event) => {
          const next = event.currentTarget.value;
          onChange(
            next === "workspace"
              ? record([["kind", next]])
              : record([
                  ["kind", next],
                  [`${next}_id`, ""],
                ]),
          );
        }}
      >
        <option value="">Choose a scope</option>
        {kinds.map((item) => (
          <option key={item}>{item}</option>
        ))}
      </Select>
      {!kinds.includes(kind) && (
        <p role="alert">
          {domain === "inherited-project"
            ? "Inherited overrides require a project policy source."
            : "This scope kind is unsupported here."}{" "}
          The exact source is preserved below; repair its scope to continue.
        </p>
      )}
      {kind !== "workspace" &&
        kinds.includes(kind) &&
        input("Exact scope ID", get(value, `${kind}_id`), (next) =>
          onChange(set(object, `${kind}_id`, d.jsonString(next))),
        )}
    </div>
  );
}
function Reference({
  value,
  kind,
  onChange,
}: {
  readonly value: JsonValue;
  readonly kind: "resource" | "contract" | "manifest";
  readonly onChange: (value: JsonValue) => void;
}) {
  const object = obj(value);
  if (object === null) return <p role="alert">An exact reference must be an object.</p>;
  return (
    <div className="ev-row">
      {input(`${kind} ID`, get(value, `${kind}_id`), (next) =>
        onChange(set(object, `${kind}_id`, d.jsonString(next))),
      )}
      {input(
        kind === "resource" ? "Content version" : "Object revision",
        get(value, "revision"),
        (next) => onChange(set(object, "revision", d.jsonString(next))),
      )}
      {kind === "resource" &&
        input("SHA-256 of exact content", get(value, "digest"), (next) =>
          onChange(set(object, "digest", d.jsonString(next))),
        )}
    </div>
  );
}
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
function emptyPin(kind: string): JsonObject {
  if (kind === "resource")
    return record([
      ["kind", kind],
      ["resource_id", ""],
      ["revision", ""],
      ["digest", ""],
    ]);
  if (kind === "event")
    return record([
      ["kind", kind],
      ["session_id", ""],
      ["sequence", ""],
    ]);
  if (kind === "commit")
    return record([
      ["kind", kind],
      ["repository", ""],
      ["object_id", ""],
    ]);
  if (kind === "checksum")
    return record([
      ["kind", kind],
      ["source", ""],
      ["digest", ""],
    ]);
  return record([
    ["kind", kind],
    [`${kind}_id`, ""],
    ["revision", ""],
  ]);
}
function Pin({
  value,
  onChange,
}: {
  readonly value: JsonValue;
  readonly onChange: (value: JsonValue) => void;
}) {
  const object = obj(value);
  if (object === null)
    return <p role="alert">A pin must be an exact historical reference object.</p>;
  const kind = get(value, "kind"),
    names =
      kind === "resource"
        ? ["resource_id", "revision", "digest"]
        : kind === "event"
          ? ["session_id", "sequence"]
          : kind === "commit"
            ? ["repository", "object_id"]
            : kind === "checksum"
              ? ["source", "digest"]
              : [`${kind}_id`, "revision"];
  return (
    <div className="ev-pin">
      <Select
        label="Pin kind"
        value={kind}
        onChange={(event) => onChange(emptyPin(event.currentTarget.value))}
      >
        <option value="">Choose a pin</option>
        {PIN_KINDS.map((item) => (
          <option key={item}>{item}</option>
        ))}
      </Select>
      <div className="ev-row">
        {names.map((name) => (
          <div key={name}>
            {input(
              name === "revision" && kind === "resource"
                ? "Content version (not metadata revision)"
                : name.replaceAll("_", " "),
              get(value, name),
              (next) => onChange(set(object, name, d.jsonString(next))),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
function Rows({
  value,
  onChange,
  kind,
}: {
  readonly value: JsonValue;
  readonly onChange: (value: JsonValue) => void;
  readonly kind: "reviewers" | "criteria" | "strings" | "artifacts" | "pins" | "entities";
}) {
  if (value.kind !== "array" || value.items.length > 100)
    return <p role="alert">Use an array of at most 100 rows. Repair its source below.</p>;
  const replace = (index: number, next: JsonValue) =>
    onChange(d.jsonArray(value.items.map((item, i) => (i === index ? next : item))));
  const fresh = () =>
    kind === "strings"
      ? d.jsonString("")
      : kind === "reviewers"
        ? record([
            ["kind", "actor"],
            ["actor_id", ""],
          ])
        : kind === "criteria"
          ? d.jsonObject([
              ["key", d.jsonString("")],
              ["description", d.jsonString("")],
              ["required", d.jsonBoolean(true)],
            ])
          : kind === "artifacts"
            ? d.jsonObject([
                ["name", d.jsonString("")],
                ["pin", emptyPin("resource")],
              ])
            : kind === "pins"
              ? emptyPin("resource")
              : record([
                  ["kind", "ticket"],
                  ["ticket_id", ""],
                ]);
  return (
    <>
      <div className="ev-rows">
        {value.items.map((item, index) => {
          const object = obj(item);
          return (
            <fieldset key={index} className="ev-item">
              <legend>Row {index + 1}</legend>
              {kind === "strings" ? (
                input("Name", text(item), (next) => replace(index, d.jsonString(next)))
              ) : kind === "pins" ? (
                <Pin value={item} onChange={(next) => replace(index, next)} />
              ) : kind === "entities" ? (
                <Scope value={item} onChange={(next) => replace(index, next)} />
              ) : object === null ? (
                <p role="alert">Expected a row object. Repair its source below.</p>
              ) : kind === "artifacts" ? (
                <>
                  {input("Artifact name", get(item, "name"), (next) =>
                    replace(index, set(object, "name", d.jsonString(next))),
                  )}
                  <Pin
                    value={jsonField(item, "pin") ?? d.jsonNull()}
                    onChange={(next) => replace(index, set(object, "pin", next))}
                  />
                </>
              ) : kind === "criteria" ? (
                <>
                  {input("Criterion key", get(item, "key"), (next) =>
                    replace(index, set(object, "key", d.jsonString(next))),
                  )}
                  {input("What must be demonstrated", get(item, "description"), (next) =>
                    replace(index, set(object, "description", d.jsonString(next))),
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={bool(item, "required")}
                      onChange={(event) =>
                        replace(
                          index,
                          set(object, "required", d.jsonBoolean(event.currentTarget.checked)),
                        )
                      }
                    />
                    Required for acceptance
                  </label>
                </>
              ) : (
                <>
                  <Select
                    label="Reviewer requirement"
                    value={get(item, "kind")}
                    onChange={(event) =>
                      replace(
                        index,
                        event.currentTarget.value === "role"
                          ? d.jsonObject([
                              ["kind", d.jsonString("role")],
                              ["name", d.jsonString("")],
                              ["member_ids", d.jsonArray([])],
                            ])
                          : record([
                              ["kind", "actor"],
                              ["actor_id", ""],
                            ]),
                      )
                    }
                  >
                    <option value="actor">Named actor</option>
                    <option value="role">Reviewer role</option>
                  </Select>
                  {get(item, "kind") === "role" ? (
                    <>
                      {input("Role name", get(item, "name"), (next) =>
                        replace(index, set(object, "name", d.jsonString(next))),
                      )}
                      <Rows
                        kind="strings"
                        value={jsonField(item, "member_ids") ?? d.jsonArray([])}
                        onChange={(next) => replace(index, set(object, "member_ids", next))}
                      />
                    </>
                  ) : (
                    input("Reviewer actor ID", get(item, "actor_id"), (next) =>
                      replace(index, set(object, "actor_id", d.jsonString(next))),
                    )
                  )}
                </>
              )}
              <Button
                onClick={() => onChange(d.jsonArray(value.items.filter((_, i) => i !== index)))}
              >
                Remove row {index + 1}
              </Button>
            </fieldset>
          );
        })}
      </div>
      <Button
        disabled={value.items.length >= 100}
        onClick={() => onChange(d.jsonArray([...value.items, fresh()]))}
      >
        Add{" "}
        {kind === "reviewers"
          ? "reviewer"
          : kind === "criteria"
            ? "criterion"
            : kind === "artifacts"
              ? "artifact"
              : kind === "pins"
                ? "pin"
                : kind === "entities"
                  ? "scope"
                  : "name"}
      </Button>
    </>
  );
}
function Controls({
  name,
  value,
  onChange,
  policyScope = false,
}: {
  readonly name: string;
  readonly policyScope?: boolean;
  readonly value: JsonValue;
  readonly onChange: (value: JsonValue) => void;
}) {
  if (name === "reviewers" || name === "criteria")
    return <Rows kind={name} value={value} onChange={onChange} />;
  if (
    ["validators", "required_inputs", "required_outputs", "supersedes", "recipients"].includes(name)
  )
    return <Rows kind="strings" value={value} onChange={onChange} />;
  if (name === "scope")
    return <Scope domain={policyScope ? "policy" : "entity"} value={value} onChange={onChange} />;
  if (name === "schema") return <Reference kind="resource" value={value} onChange={onChange} />;
  if (name === "manifest" || name === "contract")
    return <Reference kind={name} value={value} onChange={onChange} />;
  if (name === "inputs" || name === "outputs")
    return <Rows kind="artifacts" value={value} onChange={onChange} />;
  if (name === "evidence" || name === "evidence_pins")
    return <Rows kind="pins" value={value} onChange={onChange} />;
  if (["rationale", "previous", "current", "artifact"].includes(name))
    return <Pin value={value} onChange={onChange} />;
  if (name === "affected") return <Rows kind="entities" value={value} onChange={onChange} />;
  const object = obj(value);
  if (object === null) return <p role="alert">Use an object for this structured field.</p>;
  if (name === "criterion")
    return (
      <>
        <Scope
          domain="policy"
          value={
            jsonField(value, "scope") ??
            record([
              ["kind", "ticket"],
              ["ticket_id", ""],
            ])
          }
          onChange={(next) => onChange(set(object, "scope", next))}
        />
        {input("Source policy revision", get(value, "policy_revision"), (next) =>
          onChange(set(object, "policy_revision", d.jsonString(next))),
        )}
        {input("Criterion key", get(value, "key"), (next) =>
          onChange(set(object, "key", d.jsonString(next))),
        )}
      </>
    );
  if (name === "disposition")
    return (
      <>
        <Select
          label="Reconciliation choice"
          value={get(value, "kind")}
          onChange={(event) =>
            onChange(
              event.currentTarget.value === "continue"
                ? record([
                    ["kind", "continue"],
                    ["reason", ""],
                  ])
                : event.currentTarget.value === "revised"
                  ? d.jsonObject([
                      ["kind", d.jsonString("revised")],
                      [
                        "manifest",
                        record([
                          ["manifest_id", ""],
                          ["revision", ""],
                        ]),
                      ],
                    ])
                  : record([["kind", "acknowledge"]]),
            )
          }
        >
          <option value="acknowledge">Acknowledge the change</option>
          <option value="continue">Continue using the historical input, with reason</option>
          <option value="revised">Use a revised manifest</option>
        </Select>
        {get(value, "kind") === "continue" &&
          input("Reason", get(value, "reason"), (next) =>
            onChange(set(object, "reason", d.jsonString(next))),
          )}
        {get(value, "kind") === "revised" && (
          <Reference
            kind="manifest"
            value={jsonField(value, "manifest") ?? d.jsonNull()}
            onChange={(next) => onChange(set(object, "manifest", next))}
          />
        )}
      </>
    );
  if (name === "inherited_override") {
    const against = obj(jsonField(value, "against") ?? d.jsonNull());
    return (
      <>
        <p className="ev-callout">
          An override waives only the named inherited requirements at this exact project policy and
          ticket membership. A later source or membership change makes it stale.
        </p>
        <Scope
          domain="inherited-project"
          value={
            against === null
              ? record([
                  ["kind", "project"],
                  ["project_id", ""],
                ])
              : (jsonField(against, "scope") ?? d.jsonNull())
          }
          onChange={(next) =>
            onChange(
              set(object, "against", set(against ?? record([["revision", ""]]), "scope", next)),
            )
          }
        />
        {input(
          "Inherited source policy revision",
          against === null ? "" : get(against, "revision"),
          (next) =>
            onChange(
              set(
                object,
                "against",
                set(against ?? d.jsonObject([]), "revision", d.jsonString(next)),
              ),
            ),
        )}
        {input("Actual ticket membership revision", get(value, "membership_revision"), (next) =>
          onChange(set(object, "membership_revision", d.jsonString(next))),
        )}
        <fieldset>
          <legend>Waived reviewer requirements</legend>
          <Rows
            kind="reviewers"
            value={jsonField(value, "reviewers") ?? d.jsonArray([])}
            onChange={(next) => onChange(set(object, "reviewers", next))}
          />
        </fieldset>
        <fieldset>
          <legend>Waived validator names</legend>
          <Rows
            kind="strings"
            value={jsonField(value, "validators") ?? d.jsonArray([])}
            onChange={(next) => onChange(set(object, "validators", next))}
          />
        </fieldset>
        <fieldset>
          <legend>Waived criterion keys</legend>
          <Rows
            kind="strings"
            value={jsonField(value, "criteria") ?? d.jsonArray([])}
            onChange={(next) => onChange(set(object, "criteria", next))}
          />
        </fieldset>
        <label>
          <input
            type="checkbox"
            checked={bool(value, "waive_separate_actor")}
            onChange={(event) =>
              onChange(
                set(object, "waive_separate_actor", d.jsonBoolean(event.currentTarget.checked)),
              )
            }
          />
          Waive inherited separate-actor requirement
        </label>
        {input("Audited override reason", get(value, "reason"), (next) =>
          onChange(set(object, "reason", d.jsonString(next))),
        )}
      </>
    );
  }
  return (
    <p className="wg-hint">
      This optional audited structure is available in its exact source below. Read the native field
      contract before enabling it.
    </p>
  );
}

/** Worker-owned parse/encode. Readable controls never JSON.parse or coerce numeric lexemes. */
export function StructuredField({
  field,
  input: current,
  processing,
  onChange,
  disabled,
  onBlocked,
}: {
  readonly field: EvidenceField;
  readonly input: FieldInput;
  readonly processing: ProtocolProcessor;
  readonly onChange: (value: FieldInput) => void;
  readonly disabled: boolean;
  readonly onBlocked: (name: string, value: boolean) => void;
}) {
  const [view, setView] = useState<{ source: string; value: JsonValue } | null>(() =>
      current.value === undefined ? null : { source: current.text, value: current.value },
    ),
    [issue, setIssue] = useState(""),
    [unexpected, setUnexpected] = useState<{ error: unknown } | null>(null),
    [busy, setBusy] = useState(false),
    owner = useRef<AbortController | null>(null),
    retained = useRef(view);
  useEffect(() => {
    onBlocked(field.name, busy || issue !== "" || view === null);
  }, [onBlocked, field.name, busy, issue, view]);
  useEffect(() => {
    if (retained.current?.source === current.text) {
      owner.current?.abort();
      setView(retained.current);
      setIssue("");
      setBusy(false);
      return;
    }
    const abort = new AbortController();
    owner.current?.abort();
    owner.current = abort;
    setBusy(true);
    void processing
      .parse(current.text, { signal: abort.signal, limits: HTTP_LIMITS })
      .then((result) => {
        if (abort.signal.aborted) return;
        if (!result.ok) {
          setBusy(false);
          setIssue(result.failure.message);
          return;
        }
        if (!result.value.ok) {
          setBusy(false);
          setIssue(result.value.error.message);
          return;
        }
        const next = { source: current.text, value: result.value.value.value };
        retained.current = next;
        setView(next);
        setIssue("");
        setBusy(false);
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setUnexpected({ error });
      });
    return () => abort.abort();
  }, [current.text, processing]);
  useEffect(() => () => owner.current?.abort(), []);
  useEffect(() => () => onBlocked(field.name, false), [onBlocked, field.name]);
  const change = (value: JsonValue) => {
    const abort = new AbortController();
    owner.current?.abort();
    owner.current = abort;
    const next = { source: current.text, value };
    // The controls may be optimistic; retained only identifies verified source bytes.
    setView(next);
    setBusy(true);
    void encoded(processing, value, abort.signal)
      .then((source) => {
        if (abort.signal.aborted) return;
        const captured = { source, value };
        retained.current = captured;
        setView(captured);
        setBusy(false);
        setIssue("");
        onChange({ presence: "value", text: source, value });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setBusy(false);
        if (error instanceof EvidenceInputError) setIssue(error.message);
        else setUnexpected({ error });
      });
  };
  if (unexpected !== null) throw unexpected.error;
  return (
    <fieldset className="ev-structured" disabled={disabled}>
      <legend>{field.label}</legend>
      {field.hint && <p className="wg-hint">{field.hint}</p>}
      {view !== null && (
        <Controls
          policyScope={field.label === "Policy scope"}
          name={field.name}
          value={view.value}
          onChange={change}
        />
      )}
      <details>
        <summary>Exact JSON source</summary>
        <label className="ev-source-label">
          {field.label} source
          <textarea
            aria-label={`${field.label} source`}
            value={current.text}
            spellCheck={false}
            onChange={(event) => {
              owner.current?.abort();
              const source = event.currentTarget.value;
              const verified = retained.current;
              if (verified?.source === source) {
                setView(verified);
                setIssue("");
                setBusy(false);
              } else setBusy(true);
              onChange({ presence: "value", text: source });
            }}
          />
        </label>
      </details>
      {busy && <p role="status">Saving structured field…</p>}
      {issue && (
        <p role="alert" className="wg-error">
          {issue}
        </p>
      )}
    </fieldset>
  );
}
