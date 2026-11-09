import type { ContentMatrix } from "./types.d.mts";
export default {
  format: "workgraph-ui-content-matrix-1",
  inputs: [
    {
      resource: "ui-charter",
      revision: "2",
      digest: "bda6d25a1945ca9c1cce9ea7779e20e7748ad45bb6fb47527d3cab01ab3b999d",
    },
    {
      resource: "ui-working-agreement",
      revision: "3",
      digest: "aeaaa6b8e84e8a1d21a9b539ab4dac4075afda39de4bf0169546029d9897a81b",
    },
    {
      resource: "ui-design-baseline",
      revision: "1",
      digest: "ac518cf863081e0c709636ea2c51b317e08d203bb8c8d6c108fb4772edacecce",
    },
    {
      resource: "ui-requirements",
      revision: "2",
      digest: "f46aa3dd165d5012290a088d4ad709241b38e565d2769a376d58c44803c3bf5e",
    },
    {
      resource: "ui-syntax-highlighting-direction",
      revision: "1",
      digest: "9de5f2f85a0dfdaaba1e21c2b3c0ced1d4b6bf0ef9df2358a1e0f66756ea1c92",
    },
  ],
  controls: [
    {
      id: "json",
      family: "lossless_json",
      layer: "pure",
      paths: ["ui/frontend/tests/core/json.test.ts"],
      behavior:
        "Exact numeric lexemes, duplicate/prototype keys, finite bounded UTF8/depth/tokens, safe roundtrip and missing versus explicit null.",
      selection: null,
    },
    {
      id: "worker",
      family: "worker_bounds",
      layer: "pure",
      paths: [
        "ui/frontend/tests/core/processing.test.ts",
        "ui/frontend/tests/content/client.test.ts",
      ],
      behavior:
        "Worker admission, deadline, cancellation and stale delivery retain exact original input, never silently succeed synchronously.",
      selection: null,
    },
    {
      id: "passive",
      family: "passive_text",
      layer: "browser",
      paths: ["ui/frontend/tests/knowledge/viewers/viewers.browser.ts"],
      behavior:
        "Passive Markdown/GFM and fixed code grammar; hostile markup, references and scripts never execute or fetch. Raw/download survives failure.",
      selection: null,
    },
    {
      id: "raster",
      family: "verified_raster",
      layer: "browser",
      paths: ["ui/frontend/tests/knowledge/viewers/viewers.browser.ts"],
      behavior:
        "PNG/JPEG/WebP/GIF exact verified complete blobs before bounded static decode, EXIF/transparency/pixels/zoom and malformed/unsupported/budget fallbacks.",
      selection: null,
    },
    {
      id: "bytes",
      family: "immutable_bytes",
      layer: "browser",
      paths: [
        "ui/frontend/tests/knowledge/viewers/viewers.browser.ts",
        "ui/frontend/tests/history/transcript/transcript.browser.ts",
      ],
      behavior:
        "Exact source version/digest/head/offset, partial UTF8 and independent verified comparisons/downloads; no current-version substitution.",
      selection: null,
    },
    {
      id: "facts",
      family: "exact_facts",
      layer: "browser",
      paths: ["ui/frontend/tests/knowledge/facts/facts.browser.ts"],
      behavior:
        "All four explicit scopes, literal case/numeric equality, missing/null, whole-value updates/tombstones, conflict/new identity and captured pages.",
      selection: null,
    },
    {
      id: "renderer",
      family: "config_renderers",
      layer: "browser",
      paths: [
        "ui/frontend/tests/custom/editor/editor.browser.ts",
        "ui/frontend/tests/custom/editor/renderer-host.browser.ts",
      ],
      behavior:
        "Actual saved builder/private CAS/import/shared atomic publication, original Raw ownership and explicit pinned Fact/Resource/History renderer choice; unknown/ambiguous stays generic.",
      selection: null,
    },
    {
      id: "formats",
      family: "passive_text",
      layer: "browser",
      paths: ["ui/frontend/tests/history/formats/formats.browser.ts"],
      behavior:
        "Six explicit format adapters, unknown/ambiguous/malformed/partial/vendor hints and opaque reasoning/error remain passive, session-scoped and exact-source readable.",
      selection: null,
    },
    {
      id: "usage",
      family: "reported_usage",
      layer: "browser",
      paths: ["ui/frontend/tests/history/analytics.browser.ts"],
      behavior:
        "Exact int64 reported samples, separated units/cumulative reports, saturation, unassigned/shared attribution and retained native budget retry; missing is never inferred zero.",
      selection: null,
    },
    {
      id: "text",
      family: "passive_text",
      layer: "browser",
      paths: [
        "ui/frontend/tests/workflow/plans/schema.test.ts",
        "ui/tests/qualification/api/publication.browser.ts",
      ],
      behavior:
        "Ordinary schema strings preserve Unicode/LF/trailing LF through actual atomic native publication and independent readback; CR/CRLF and >8192 use explicit exact source. New dictionary newline names remain source-only.",
      selection: null,
    },
    {
      id: "headers",
      family: "native_security",
      layer: "native_companion",
      paths: ["ui/tests/qualification/content/content.browser.ts"],
      behavior:
        "Actual companion CSP/no-sniff/origin/referrer headers only admit bundled passive capabilities; existing real viewer hostile content proves no-fetch/no-execution.",
      selection: "native companion admits only bundled passive content capabilities",
    },
    {
      id: "zero",
      family: "reported_usage",
      layer: "browser",
      paths: ["ui/tests/qualification/content/content.browser.ts"],
      behavior:
        "Actual empty native observation catalog visibly unknown; one explicit zero report visibly known zero, without external HTTP.",
      selection:
        "absent native usage stays unknown while one explicit zero report is reported zero",
    },
  ],
  requirements: [
    {
      id: "R11",
      requirement: "History exact source/head/paging/partial distinctions",
      controls: ["bytes", "formats"],
    },
    {
      id: "R12",
      requirement:
        "Reported usage is exact source data, unknown is distinct from zero and shared attribution",
      controls: ["usage", "zero"],
    },
    {
      id: "R15",
      requirement: "Immutable Resources/rich views/verified hash and passive bounded fallback",
      controls: ["passive", "raster", "bytes", "headers"],
    },
    {
      id: "R16",
      requirement: "Exact scoped Facts and lossless whole-value semantics",
      controls: ["facts", "json"],
    },
    {
      id: "R19",
      requirement: "Closed declarative custom views/renderers and actual pinned integration",
      controls: ["renderer"],
    },
    {
      id: "R24",
      requirement: "Lossless/bounded processing and exact source preservation",
      controls: ["json", "worker", "text"],
    },
    {
      id: "R25",
      requirement: "Native browser provenance, safe content and actionable failures",
      controls: ["headers", "passive", "raster", "worker"],
    },
  ],
  remainingGates: [
    {
      ticket: "ui-q-accessibility",
      behavior:
        "Current content-first polish, keyboard/responsive/theme/visual qualification; historical screenshots are not final visual proof.",
    },
    {
      ticket: "ui-package-artifacts",
      behavior: "Platform/package provenance and final assembled source/artifact-wide checks.",
    },
    {
      ticket: "ui-q-root-code",
      behavior:
        "Root personal final code/rendered workflow review and final assembled checks remain required; public release authorization is separate and is not conferred here.",
    },
  ],
} satisfies ContentMatrix;
