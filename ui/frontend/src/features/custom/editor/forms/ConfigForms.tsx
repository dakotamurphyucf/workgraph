import { suggestedSetup } from "./presets";
import { sourceHelp } from "../source-help";
import { ScopeChoice } from "../ScopeChoice";
import type { ReactNode } from "react";
import { Button } from "../../../../components/Primitives";
import { sourceContracts, type ConfigSource } from "../../config";
import { at, change, textAt, variant, type Path } from "./model";
import {
  Choice,
  FormatFields,
  Optional,
  PinFields,
  Rows,
  Scalar,
  Text,
  type FieldsProps,
} from "./fields";
import * as d from "../../../../core/protocol/decoders";
import { compareNumbers } from "../../config";
import { resourceScopeDescription } from "../scope-description";
const str = d.jsonString,
  obj = d.jsonObject,
  arr = d.jsonArray;
const defaultFormat = () => obj([["type", str("text")]]);
import type { RendererFormProps, ViewFormProps } from "./types";
import "./forms.css";
function FormFrame({
  kind,
  props,
  children,
}: {
  readonly kind: "view" | "renderer";
  readonly props: ViewFormProps | RendererFormProps;
  readonly children: ReactNode;
}) {
  const { draft, decoded, onRaw, disabled } = props;
  const version = at(draft.candidate, ["config_version"]),
    actualKind = at(draft.candidate, ["kind"]);
  const supported =
    version?.kind === "number" &&
    compareNumbers(version.lexeme, "1") === 0 &&
    actualKind?.kind === "string" &&
    actualKind.value === kind;
  if (!supported || decoded?.kind === "unsupported_version")
    return (
      <section className="wg-custom-form">
        <h3>Source retained</h3>
        <p>
          This version or document kind has no supported structured editor. It remains inactive and
          unchanged.
        </p>
        <Button onClick={onRaw}>Inspect Raw configuration</Button>
      </section>
    );
  const issues = [...draft.errors, ...(decoded?.kind === "invalid" ? decoded.issues : [])];
  return (
    <section
      className="wg-custom-form"
      aria-label={`${kind === "view" ? "View" : "Renderer"} builder`}
    >
      <div className="wg-custom-form-heading">
        <div>
          <h3>{kind === "view" ? "Design your view" : "Present a value"}</h3>
          <p className="wg-hint">
            Changes stay in this draft. Preview and save are separate actions.
          </p>
        </div>
      </div>
      {draft.errors.length > 0 && (
        <p className="wg-hint">
          Raw shows the last representable JSON candidate. Unfinished field text stays in this form
          when you return; editing Raw deliberately replaces that form state.
        </p>
      )}
      {issues.length > 0 && (
        <div className="wg-custom-validation" role="status">
          <strong>Draft needs attention</strong>
          <ul>
            {issues.map((issue, i) => (
              <li key={i}>
                {issue.path.join(" › ") || "Configuration"}: {issue.message}
              </li>
            ))}
          </ul>
          <p>The working view is unchanged.</p>
        </div>
      )}
      <fieldset disabled={disabled} className="wg-custom-fields">
        <legend className="wg-sr-only">{kind} settings</legend>
        {children}
      </fieldset>
    </section>
  );
}
function Common(props: FieldsProps) {
  return (
    <>
      <div className="wg-custom-grid">
        <Text {...props} path={["title"]} label="Name" />
        <Text
          {...props}
          path={["id"]}
          label="Configuration ID"
          hint="An ID for this configuration, not a ticket. The generated value is ready to use; keep it stable when editing."
        />
      </div>
      <Optional {...props} path={["description"]} label="Include a description" initial={str("")}>
        <Text {...props} path={["description"]} label="Description" />
      </Optional>
    </>
  );
}
const column = (id: string) =>
  obj([
    ["id", str(id)],
    [
      "selector",
      obj([
        ["kind", str("field")],
        ["field", str("title")],
      ]),
    ],
    ["label", str("Title")],
    ["format", defaultFormat()],
  ]);
export function ViewForm(props: ViewFormProps) {
  const { draft, onChange } = props;
  const rawSource = textAt(draft, ["source"]),
    source = Object.keys(sourceContracts).find((key): key is ConfigSource => key === rawSource),
    contract = source === undefined ? null : sourceContracts[source];
  const fields = Object.keys(contract?.fields ?? {}),
    mode = textAt(draft, ["filter_mode"]),
    scopeKind = (["workspace", "project", "milestone", "ticket"] as const).find(
      (kind) => kind === textAt(draft, ["scope", "kind"]),
    );
  return (
    <FormFrame kind="view" props={props}>
      <section className="sv-form-basics">
        <h3>1 · Name and layout</h3>
        <Common {...props} />
        <div className="wg-custom-grid">
          <Choice
            {...props}
            path={["source"]}
            label="Source"
            choices={Object.keys(sourceContracts)}
          />
          <Choice
            {...props}
            path={["presentation"]}
            label="Layout"
            choices={["list", "table", "board", "timeline"]}
          />
        </div>
        {source && (
          <div className="sv-source-help">
            <p>{sourceHelp[source]}</p>
            <Button onClick={() => onChange(suggestedSetup(draft, source))}>
              Use suggested setup
            </Button>
            <p className="wg-hint">
              Replaces this draft’s columns, filters, sorting and layout with a simple table for the
              selected source. Keeps its name and ID; uses Workspace if the current scope is
              unsupported. Nothing is saved until you choose Save privately.
            </p>
          </div>
        )}
        <p className="wg-hint">
          Ticket boards use status. Session timelines require a timestamp as the first order field.
          Changing source keeps existing settings so incompatible choices can be repaired
          explicitly.
        </p>
      </section>
      <details open>
        <summary>2 · Where to look</summary>
        <p>
          Scope means the area of work this view reads. Start with Workspace, or select an existing
          project, milestone or ticket. Resource and fact scopes are not recursive; they read their
          own links or values.
        </p>
        <div className="wg-custom-grid">
          <Choice
            {...props}
            path={["scope", "kind"]}
            label="Scope"
            choices={contract?.scopes ?? ["workspace", "project", "milestone", "ticket"]}
            onSelect={(kind) =>
              onChange(
                variant(
                  draft,
                  ["scope"],
                  ["kind", "id"],
                  [
                    ["kind", str(kind)],
                    ...(kind === "workspace" ? [] : [["id", str("")] as const]),
                  ],
                ),
              )
            }
          />
          {scopeKind && scopeKind !== "workspace" && (
            <ScopeChoice
              {...(props.references ? { references: props.references } : {})}
              kind={scopeKind}
              label="Scope ID"
              value={textAt(draft, ["scope", "id"])}
              onChange={(id) => onChange(change(draft, ["scope", "id"], str(id)))}
            />
          )}
        </div>
        {source === "resources" && scopeKind !== undefined && (
          <p className="wg-hint">{resourceScopeDescription(source, { kind: scopeKind })}</p>
        )}
      </details>
      <details open>
        <summary>3 · Columns and cards</summary>
        <p>
          Choose the information shown for each record. A table uses columns; lists and boards use
          labeled fields on cards. Start with Title, then add only what helps you compare the
          records.
        </p>
        <Rows
          {...props}
          path={["columns"]}
          label="Column"
          maximum={20}
          initial={() => {
            const current = at(draft.candidate, ["columns"]),
              used =
                current?.kind === "array"
                  ? current.items
                      .map((item) => at(item, ["id"]))
                      .filter((value) => value?.kind === "string")
                      .map((value) => value.value)
                  : [];
            let n = 1;
            while (used.includes(`column_${n}`)) n++;
            return column(`column_${n}`);
          }}
        >
          {(path, index) => (
            <>
              <div className="wg-custom-grid">
                <Text {...props} path={[...path, "label"]} label={`Column ${index + 1} label`} />
                <Text {...props} path={[...path, "id"]} label={`Column ${index + 1} ID`} />
              </div>
              <Choice
                {...props}
                path={[...path, "selector", "kind"]}
                label={`Column ${index + 1} selector`}
                choices={["field", "pointer"]}
                onSelect={(kind) =>
                  onChange(
                    variant(
                      draft,
                      [...path, "selector"],
                      ["kind", "field", "pointer"],
                      [
                        ["kind", str(kind)],
                        [
                          kind === "field" ? "field" : "pointer",
                          str(kind === "field" ? (fields[0] ?? "") : ""),
                        ],
                      ],
                    ),
                  )
                }
              />
              {textAt(draft, [...path, "selector", "kind"]) === "pointer" ? (
                <Text
                  {...props}
                  path={[...path, "selector", "pointer"]}
                  label={`Column ${index + 1} pointer`}
                  hint="A path inside the value: /summary reads its summary field. Empty selects the whole value. Pointer columns work with fact values and JSON resource content."
                />
              ) : (
                <Choice
                  {...props}
                  path={[...path, "selector", "field"]}
                  label={`Column ${index + 1} field`}
                  choices={fields}
                />
              )}
              <FormatFields {...props} path={[...path, "format"]} label={`Column ${index + 1}`} />
              <Optional
                {...props}
                path={[...path, "width"]}
                label={`Set column ${index + 1} width`}
                initial={d.jsonNumber("160")}
              >
                <Text
                  {...props}
                  path={[...path, "width"]}
                  label={`Column ${index + 1} width`}
                  number
                  hint="80–800 pixels"
                />
              </Optional>
            </>
          )}
        </Rows>
      </details>
      <details>
        <summary>Filter rows · optional</summary>
        <p>
          Keep only the records you care about. With no filters, all records in the chosen scope are
          eligible. Multiple filters must all match. For a first view, leave this section empty.
        </p>
        <Choice
          {...props}
          path={["filter_mode"]}
          label="Filter mode"
          choices={["server", "loaded"]}
        />
        <Rows
          {...props}
          path={["filters"]}
          label="Filter"
          maximum={8}
          initial={() =>
            obj([
              [
                "field",
                str(
                  mode === "server"
                    ? (Object.keys(contract?.server ?? {})[0] ?? "")
                    : (fields[0] ?? ""),
                ),
              ],
              ["op", str("equals")],
              ["value", str("")],
            ])
          }
        >
          {(path, index) => (
            <Filter
              {...props}
              path={path}
              index={index}
              fields={mode === "server" ? Object.keys(contract?.server ?? {}) : fields}
            />
          )}
        </Rows>
      </details>
      <details>
        <summary>Order and group · optional</summary>
        <p>
          Ordering decides which records come first. Add a second order field to break ties.
          Grouping collects records with the same value under a heading.
        </p>
        <p className="wg-hint">
          Ordering and grouping below apply to captured rows; server order is used only where the
          adapter supports it. Missing values stay last.
        </p>
        <Rows
          {...props}
          path={["sort"]}
          label="Order"
          maximum={3}
          initial={() =>
            obj([
              ["field", str(contract?.sorts[0] ?? "")],
              ["direction", str("asc")],
              ["nulls", str("last")],
            ])
          }
        >
          {(path, index) => (
            <div className="wg-custom-grid">
              <Choice
                {...props}
                path={[...path, "field"]}
                label={`Order ${index + 1} field`}
                choices={contract?.sorts ?? []}
              />
              <Choice
                {...props}
                path={[...path, "direction"]}
                label={`Order ${index + 1} direction`}
                choices={["asc", "desc"]}
              />
            </div>
          )}
        </Rows>
        <Choice
          {...props}
          path={["group_by"]}
          label="Group by"
          choices={contract?.groups ?? []}
          nullable
        />
      </details>
      <details>
        <summary>Custom value renderer · advanced</summary>
        <p className="wg-hint">
          Most views do not need this. To use a shared display recipe for structured values, provide
          the exact published renderer resource and its version details below. These details lock
          the view to that saved version. If it cannot be read, the standard viewer is used.
        </p>
        <Optional
          {...props}
          path={["renderer"]}
          label="Use a pinned renderer"
          initial={obj([
            ["resource_id", str("")],
            ["version", str("1")],
            ["digest", str("")],
            ["size_bytes", str("0")],
          ])}
        >
          <PinFields {...props} path={["renderer"]} label="Renderer" />
        </Optional>
      </details>
    </FormFrame>
  );
}
function Filter(
  props: FieldsProps & {
    readonly path: Path;
    readonly index: number;
    readonly fields: readonly string[];
  },
) {
  const { draft, onChange, path, index, fields } = props,
    label = `Filter ${index + 1}`,
    pointer = at(draft.candidate, [...path, "pointer"]) !== undefined,
    op = textAt(draft, [...path, "op"]);
  return (
    <>
      <Choice
        {...props}
        path={[...path, "selector"]}
        label={`${label} selector`}
        choices={["field", "pointer"]}
        onSelect={(kind) =>
          onChange(
            variant(
              draft,
              path,
              ["field", "pointer", "op", "value", "values"],
              [
                [
                  kind === "pointer" ? "pointer" : "field",
                  str(kind === "pointer" ? "" : (fields[0] ?? "")),
                ],
                ["op", str("equals")],
                ["value", str("")],
              ],
            ),
          )
        }
        draft={{
          ...draft,
          candidate: change(draft, [...path, "selector"], str(pointer ? "pointer" : "field"))
            .candidate,
        }}
      />
      {pointer ? (
        <Text {...props} path={[...path, "pointer"]} label={`${label} pointer`} />
      ) : (
        <Choice {...props} path={[...path, "field"]} label={`${label} field`} choices={fields} />
      )}
      <Choice
        {...props}
        path={[...path, "op"]}
        label={`${label} operator`}
        choices={pointer ? ["equals"] : ["equals", "one_of", "literal_prefix", "contains_text"]}
        onSelect={(next) =>
          onChange(
            variant(
              draft,
              path,
              ["op", "value", "values"],
              [
                ["op", str(next)],
                next === "one_of" ? ["values", arr([str("")])] : ["value", str("")],
              ],
            ),
          )
        }
      />
      {op === "one_of" ? (
        <Rows
          {...props}
          path={[...path, "values"]}
          label={`${label} choice`}
          maximum={32}
          initial={() => str("")}
        >
          {(p, i) => <Scalar {...props} path={p} label={`${label} choice ${i + 1}`} />}
        </Rows>
      ) : op === "equals" ? (
        <Scalar {...props} path={[...path, "value"]} label={`${label} value`} />
      ) : (
        <Text {...props} path={[...path, "value"]} label={`${label} text`} />
      )}
    </>
  );
}
function RenderFields(props: FieldsProps & { readonly path: Path; readonly maximum: number }) {
  return (
    <Rows
      {...props}
      label="Displayed field"
      initial={() =>
        obj([
          ["pointer", str("")],
          ["label", str("Value")],
          ["format", defaultFormat()],
        ])
      }
    >
      {(path, index) => (
        <>
          <Text {...props} path={[...path, "label"]} label={`Field ${index + 1} label`} />
          <Text
            {...props}
            path={[...path, "pointer"]}
            label={`Field ${index + 1} pointer`}
            hint="Empty selects the root; use /name for an object property."
          />
          <FormatFields {...props} path={[...path, "format"]} label={`Field ${index + 1}`} />
        </>
      )}
    </Rows>
  );
}
export function RendererForm(props: RendererFormProps) {
  const { draft, onChange } = props,
    type = textAt(draft, ["presentation", "type"]);
  return (
    <FormFrame kind="renderer" props={props}>
      <Common {...props} />
      <details open>
        <summary>1 · Which values should use this recipe?</summary>
        <p>
          Choose a value source, then optionally narrow the match. For example, match fact keys
          starting with metrics/ to give measurements a consistent layout. All enabled conditions
          must match.
        </p>
        <Choice
          {...props}
          path={["match", "entity"]}
          label="Value source"
          choices={["fact", "resource", "history"]}
        />
        <p className="wg-hint">
          Matching chooses a display style; it does not validate or rewrite the original data. A
          reported schema is an explicit id/version declaration in the value, not something the UI
          guesses.
        </p>
        <Optional
          {...props}
          path={["match", "key_prefix"]}
          label="Match a fact key prefix"
          initial={str("")}
        >
          <Text {...props} path={["match", "key_prefix"]} label="Fact key prefix" />
        </Optional>
        <Optional
          {...props}
          path={["match", "mime_type"]}
          label="Match a resource MIME type"
          initial={str("")}
        >
          <Text
            {...props}
            path={["match", "mime_type"]}
            label="MIME type"
            hint="Exact type without parameters, e.g. application/json"
          />
        </Optional>
        <Optional
          {...props}
          path={["match", "schema"]}
          label="Match a reported schema"
          initial={obj([
            ["id", str("")],
            ["version", str("")],
          ])}
        >
          <div className="wg-custom-grid">
            <Text {...props} path={["match", "schema", "id"]} label="Schema ID" />
            <Text {...props} path={["match", "schema", "version"]} label="Schema version" />
          </div>
        </Optional>
        <Optional
          {...props}
          path={["match", "root_type"]}
          label="Match a JSON root type"
          initial={str("object")}
        >
          <Choice
            {...props}
            path={["match", "root_type"]}
            label="Root type"
            choices={["null", "boolean", "number", "string", "array", "object"]}
          />
        </Optional>
      </details>
      <details open>
        <summary>2 · How should those values look?</summary>
        <p>
          Choose a presentation and select the parts of the value to show. A pointer is a path
          inside JSON: /name reads a property, while /items/0 reads the first array item. Leave it
          empty to use the entire value.
        </p>
        <Choice
          {...props}
          path={["presentation", "type"]}
          label="Value presentation"
          choices={["fields", "table", "markdown", "code", "json"]}
          onSelect={(type) =>
            onChange(
              variant(
                draft,
                ["presentation"],
                ["type", "fields", "rows", "columns", "pointer", "language"],
                [
                  ["type", str(type)],
                  ...(type === "fields"
                    ? [
                        [
                          "fields",
                          arr([
                            obj([
                              ["pointer", str("")],
                              ["label", str("Value")],
                              ["format", defaultFormat()],
                            ]),
                          ]),
                        ] as const,
                      ]
                    : type === "table"
                      ? [
                          ["rows", str("")] as const,
                          [
                            "columns",
                            arr([
                              obj([
                                ["pointer", str("")],
                                ["label", str("Value")],
                                ["format", defaultFormat()],
                              ]),
                            ]),
                          ] as const,
                        ]
                      : [["pointer", str("")] as const]),
                  ...(type === "code" ? [["language", str("plain")] as const] : []),
                ],
              ),
            )
          }
        />
        {type === "fields" && (
          <RenderFields {...props} path={["presentation", "fields"]} maximum={32} />
        )}
        {type === "table" && (
          <>
            <Text
              {...props}
              path={["presentation", "rows"]}
              label="Table rows pointer"
              hint="Must select an array; missing or incompatible data keeps the generic fallback."
            />
            <RenderFields {...props} path={["presentation", "columns"]} maximum={16} />
          </>
        )}
        {["markdown", "code", "json"].includes(type) && (
          <Text {...props} path={["presentation", "pointer"]} label="Content pointer" />
        )}
        {type === "code" && (
          <Choice
            {...props}
            path={["presentation", "language"]}
            label="Code language"
            choices={[
              "plain",
              "ocaml",
              "typescript",
              "javascript",
              "json",
              "bash",
              "yaml",
              "markdown",
              "diff",
            ]}
          />
        )}
        <p className="wg-hint">
          Markdown and code are passive. Links and images do not execute or fetch. Missing or
          incompatible values keep the generic view; Source and Raw remain available.
        </p>
      </details>
      <p>
        Fallback: <strong>Generic viewer</strong>
      </p>
    </FormFrame>
  );
}
