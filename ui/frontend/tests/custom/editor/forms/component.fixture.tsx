import { useState } from "react";
import { createRoot } from "react-dom/client";
import { parseJsonText, stringifyJson, type JsonValue } from "../../../../src/core/json";
import * as d from "../../../../src/core/protocol/decoders";
import { createProtocolProcessor } from "../../../../src/core/protocol/worker";
import {
  configJson,
  type Column,
  type LoadedRow,
  type RendererConfig,
  type ViewConfig,
} from "../../../../src/features/custom/config";
import { decodeConfigValue } from "../../../../src/features/custom/config/decode";
import {
  RendererForm,
  ViewForm,
  type FormDraft,
} from "../../../../src/features/custom/editor/forms";
import {
  RowsPresentation,
  ValuePresentation,
  type RowsCoverage,
} from "../../../../src/features/custom/editor/presentation";
import "../../../../src/styles/tokens.css";
import "../../../../src/styles/shell.css";
import "../../../../src/styles/components.css";
const id = (s: string) => {
  const v = d.identifier.decode(d.jsonString(s));
  if (!v.ok) throw new Error("Fixture identifier");
  return v.value;
};
const processing = createProtocolProcessor();
const title: Column = {
  id: id("title"),
  selector: { kind: "field", field: "title" },
  label: "Title",
  format: { type: "text" },
};
const initialView: ViewConfig = {
  config_version: 1,
  kind: "view",
  id: id("tasks"),
  title: "My tasks",
  source: "tickets",
  scope: { kind: "workspace" },
  filter_mode: "loaded",
  filters: [],
  sort: [],
  group_by: null,
  presentation: "list",
  columns: [title],
};
const initialRenderer: RendererConfig = {
  config_version: 1,
  kind: "renderer",
  id: id("summary"),
  title: "Summary",
  match: { entity: "fact" },
  presentation: {
    type: "fields",
    fields: [{ pointer: "/name", label: "Name", format: { type: "text" } }],
  },
  fallback: "generic",
};
const make = (value: JsonValue): FormDraft => ({ candidate: value, text: {}, errors: [] });
const source = (value: JsonValue) => {
  const result = stringifyJson(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
export function Fixture() {
  const [alternate, setAlternate] = useState(false);
  const [draft, setDraft] = useState(() => make(configJson(initialView))),
    [kind, setKind] = useState<"view" | "renderer">("view"),
    [shown, setShown] = useState(true),
    [raw, setRaw] = useState(false),
    [rawSource, setRawSource] = useState(""),
    [rawIssue, setRawIssue] = useState(""),
    [working, setWorking] = useState("My tasks"),
    [layout, setLayout] = useState<
      | "list"
      | "table"
      | "board"
      | "timeline"
      | "values"
      | "runboard"
      | "groupedtable"
      | "factfilter"
    >("list"),
    [valueMode, setValueMode] = useState<
      "fields" | "table" | "markdown" | "code" | "json" | "missing"
    >("fields"),
    [opened, setOpened] = useState("");
  const decoded = decodeConfigValue(draft.candidate),
    valid = decoded.kind === "valid" && "kind" in decoded.document ? decoded.document : null;
  const update = (next: FormDraft) => setDraft(next);
  const common = {
    draft,
    decoded,
    onChange: update,
    onRaw: () => {
      setRawSource(source(draft.candidate));
      setRaw(true);
    },
  };
  const rows: readonly LoadedRow[] = [
    {
      identity: "task-a",
      fields: { title: d.jsonString("Write guide"), status: d.jsonString("todo") },
    },
    {
      identity: "task-b",
      fields: { title: d.jsonString("Review draft"), status: d.jsonString("done") },
    },
  ];
  const times: readonly LoadedRow[] = [
    {
      identity: "session-old",
      fields: { title: d.jsonString("Recorded"), created_at: d.jsonNumber("1000") },
    },
    {
      identity: "session-unknown",
      fields: { title: d.jsonString("Unknown capture"), created_at: d.jsonNull() },
    },
    {
      identity: "session-range",
      fields: {
        title: d.jsonString("Outside Date range"),
        created_at: d.jsonNumber("9223372036854775807"),
      },
    },
  ];
  const values: readonly LoadedRow[] = [
    { identity: "resource-budget", fields: { title: d.jsonString("Large JSON") } },
    { identity: "resource-null", fields: {}, decoded: d.jsonNull() },
  ];
  const coverage: RowsCoverage = {
    capture: [
      { label: "Connection", value: "captured generation 2" },
      { label: "Planning revision", value: "9007199254740993" },
    ],
    complete: false,
    partial: true,
    stop: "byte_budget",
    values: [
      {
        identity: "resource-budget",
        status: "budget",
        message: "Metadata loaded; body exceeds 64 KiB JSON policy",
        pin: null,
      },
      { identity: "resource-null", status: "decoded", message: null, pin: null },
    ],
  };
  const presented: ViewConfig = {
    ...initialView,
    title: "Captured records",
    source:
      layout === "timeline"
        ? "sessions"
        : layout === "values"
          ? "resources"
          : layout === "runboard"
            ? "runs"
            : layout === "factfilter"
              ? "facts"
              : "tickets",
    presentation:
      layout === "values" || layout === "groupedtable"
        ? "table"
        : layout === "runboard"
          ? "board"
          : layout === "factfilter"
            ? "list"
            : layout,
    filters:
      layout === "factfilter"
        ? [{ pointer: "/score", op: "equals", value: { kind: "number", lexeme: "1" } }]
        : [],
    group_by:
      layout === "board" || layout === "runboard" || layout === "groupedtable" ? "status" : null,
    sort: layout === "timeline" ? [{ field: "created_at", direction: "asc", nulls: "last" }] : [],
    columns:
      layout === "factfilter"
        ? [{ ...title, selector: { kind: "field", field: "key" }, label: "Key" }]
        : layout === "runboard"
          ? [{ ...title, selector: { kind: "field", field: "objective" }, label: "Objective" }]
          : layout === "values"
            ? [
                {
                  ...title,
                  label: "Decoded value",
                  selector: { kind: "pointer", pointer: "" },
                  format: { type: "json" },
                },
              ]
            : [title],
  };
  const richValue = d.jsonObject([
    ["name", d.jsonString("Ada")],
    [
      "body",
      d.jsonString(
        "# Hello\n\n[External](https://example.invalid) ![Remote](https://example.invalid/image)\n\n<script>window.__bad=true</script>",
      ),
    ],
    [
      "code",
      d.jsonString(
        alternate
          ? "let replacement = 1\n"
          : Array.from({ length: 230 }, (_, i) => `let item_${i} = ${i}`).join("\n"),
      ),
    ],
    [
      "rows",
      d.jsonArray([
        d.jsonObject([["name", d.jsonString("One")]]),
        d.jsonObject([["name", d.jsonNull()]]),
      ]),
    ],
  ]);
  const renderer: RendererConfig = {
    ...initialRenderer,
    presentation:
      valueMode === "fields"
        ? {
            type: "fields",
            fields: [{ pointer: "/name", label: "Person", format: { type: "text" } }],
          }
        : valueMode === "table"
          ? {
              type: "table",
              rows: "/rows",
              columns: [{ pointer: "/name", label: "Person", format: { type: "text" } }],
            }
          : valueMode === "code"
            ? { type: "code", pointer: "/code", language: "ocaml" }
            : valueMode === "missing"
              ? { type: "markdown", pointer: "/absent" }
              : { type: valueMode, pointer: valueMode === "markdown" ? "/body" : "" },
  };
  return (
    <main style={{ maxWidth: 1100, margin: "auto", padding: 24 }}>
      <h1>Custom view components</h1>
      <nav className="wg-toolbar" aria-label="Fixture controls">
        <button
          onClick={() => {
            setKind("view");
            setDraft(make(configJson(initialView)));
            setRaw(false);
          }}
        >
          New view
        </button>
        <button
          onClick={() => {
            setKind("renderer");
            setDraft(make(configJson(initialRenderer)));
            setRaw(false);
          }}
        >
          New renderer
        </button>
        <button onClick={() => setShown((s) => !s)}>Hide or restore editor</button>
        <button
          onClick={() => {
            setDraft(
              make(
                d.jsonObject([
                  ["config_version", d.jsonNumber("99")],
                  ["kind", d.jsonString(kind)],
                  ["future", d.jsonString("retain me")],
                ]),
              ),
            );
          }}
        >
          Unknown version
        </button>
        <button
          onClick={() => {
            const initial = configJson(initialView);
            if (initial.kind !== "object") throw new Error("initial");
            setKind("view");
            setDraft(
              make(
                d.jsonObject([
                  ...initial.fields.map((f) => [f.name, f.value] as const),
                  ["future", d.jsonObject([["n", d.jsonNumber("9007199254740993")]])],
                ]),
              ),
            );
            setRaw(false);
          }}
        >
          Unknown field
        </button>
        <button
          disabled={decoded.kind !== "valid" || draft.errors.length > 0}
          onClick={() => setWorking(valid !== null && "title" in valid ? valid.title : "unchanged")}
        >
          Apply working configuration
        </button>
      </nav>
      <p role="status">
        Parent {decoded.kind === "valid" && draft.errors.length === 0 ? "ready" : "blocked"};
        working: {working}
      </p>
      {shown &&
        (raw ? (
          <section>
            <p>
              Raw is the last representable candidate. Unfinished form input stays retained until an
              explicit Raw replacement.
            </p>
            <label>
              Raw candidate
              <textarea
                aria-label="Raw candidate"
                value={rawSource}
                onChange={(event) => setRawSource(event.target.value)}
                rows={8}
              />
            </label>
            <button
              onClick={() => {
                const parsed = parseJsonText(rawSource);
                if (parsed.ok) {
                  setDraft(make(parsed.value.value));
                  setRawIssue("");
                } else setRawIssue(parsed.error.message);
              }}
            >
              Replace from Raw
            </button>
            <button onClick={() => setRaw(false)}>Return to form</button>
            {rawIssue && <p role="alert">{rawIssue}</p>}
          </section>
        ) : kind === "view" ? (
          <ViewForm {...common} value={valid?.kind === "view" ? valid : null} />
        ) : (
          <RendererForm {...common} value={valid?.kind === "renderer" ? valid : null} />
        ))}
      <details>
        <summary>Retained candidate</summary>
        <pre aria-label="Candidate JSON">{source(draft.candidate)}</pre>
        <pre aria-label="Local text">{JSON.stringify(draft.text)}</pre>
      </details>
      <hr />
      <h2>Passive captured rows</h2>
      <nav aria-label="Presentation fixtures" className="wg-toolbar">
        {(
          [
            "list",
            "table",
            "board",
            "timeline",
            "values",
            "runboard",
            "groupedtable",
            "factfilter",
          ] as const
        ).map((mode) => (
          <button key={mode} onClick={() => setLayout(mode)}>
            {mode} fixture
          </button>
        ))}
      </nav>
      <RowsPresentation
        identity={`fixture-captured:${layout}`}
        view={presented}
        rows={
          layout === "timeline"
            ? times
            : layout === "values"
              ? values
              : layout === "factfilter"
                ? [{ identity: "resource-budget", fields: { key: d.jsonString("report.a") } }]
                : layout === "runboard"
                  ? rows.map((row) => ({
                      ...row,
                      fields: { ...row.fields, objective: row.fields.title ?? d.jsonNull() },
                    }))
                  : rows
        }
        coverage={
          layout === "factfilter"
            ? { ...coverage, complete: true, partial: false, stop: "complete" }
            : coverage
        }
        processing={processing}
        onOpenRow={(row) => setOpened(row.identity)}
      />
      <output aria-label="Opened record">{opened}</output>
      <h2>Passive value</h2>
      <button onClick={() => setAlternate((v) => !v)}>Switch captured value</button>
      <nav aria-label="Value fixtures" className="wg-toolbar">
        {(["fields", "table", "markdown", "code", "json", "missing"] as const).map((mode) => (
          <button key={mode} onClick={() => setValueMode(mode)}>
            {mode} value
          </button>
        ))}
      </nav>
      <ValuePresentation
        identity={`fixture-value:${valueMode}:${alternate ? "new" : "old"}`}
        value={richValue}
        renderer={renderer}
        generic={<p>Generic source retained</p>}
        processing={processing}
      />
    </main>
  );
}
const root = document.getElementById("fixture");
if (root === null) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
