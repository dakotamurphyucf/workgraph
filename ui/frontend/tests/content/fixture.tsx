import { Component, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Button, Select, Toolbar } from "../../src/components/Primitives";
import { ContentViewer, createContentWorkerClient } from "../../src/content";
import { CONTENT_LIMITS } from "../../src/content/limits";
import type { ContentSource, RenderRequest } from "../../src/content";
import "../../src/styles/tokens.css";
import "../../src/styles/components.css";
import "./fixture.css";

const encoder = new TextEncoder();
function source(key: string, text: string, hints: ContentSource["hints"] = {}): ContentSource {
  return { key, label: `${key}.txt`, bytes: encoder.encode(text), completeness: "complete", hints };
}
const markdown =
  '# Northstar release notes\n\nA synthetic qualification capture. **Durable publication** precedes acknowledgement; a preview never changes the source. &amp; &#955;\n\n| Check | Result | Evidence |\n| :--- | :--- | ---: |\n| Capture identity | Verified | 48 events |\n| Retry fencing | Retained | 3 attempts |\n\n## Typed interfaces\n\n```ocaml\ntype publication =\n  | Published of { revision : int; digest : string }\n  | Uncertain of { request_id : string }\n\nlet title = "Northstar"\n```\n\n- [x] Preserve immutable source\n- [ ] Qualify retrieval separately\n\n> Metrics are reported only when stored evidence supports them.\n\nA [ticket reference](workgraph://ticket/northstar-42) is passive here.\n';
const hostile =
  '# Passive, by construction\n\n<script>globalThis.__contentExploit = true</script>\n<img src="https://untrusted.invalid/leak" onerror="globalThis.__contentExploit=true">\n\n&lt;script&gt;entity text&lt;/script&gt;\n\n[unsafe](jav&#x61;script:alert(1)) ![image label](https://untrusted.invalid/pixel.png)\n\n`&amp; <b>literal code</b>`\n\n```unknown\n<script>literal fence</script> &amp;\n```\n';
const fixtures = {
  markdown: {
    ...source("northstar-notes", markdown, { mime: "text/markdown" }),
    label: "northstar-notes.md",
  },
  structured: source(
    "large-structured",
    JSON.stringify(
      Array.from({ length: 5000 }, (_, i) => ({
        id: i,
        title: `Ticket ${i}`,
        status: "in_progress",
        description: "Representative structured data for content qualification.",
      })),
      null,
      2,
    ),
    { language: "json" },
  ),
  hostile: source("hostile-markup", hostile),
  exact: source(
    "exact-source",
    '\uFEFF# Exact source\r\n&amp; &#955;\r\n```json\r\n{"large":9007199254740993}\r\n```\r\n',
  ),
  large: source(
    "large-capture",
    Array.from(
      { length: CONTENT_LIMITS.richLines + 1 },
      (_, i) => `line ${i + 1} · ${"captured ".repeat(4)}`,
    ).join("\n"),
  ),
  long: source("long-line", "x".repeat(12000) + "\nend"),
  binary: {
    ...source("binary-capture", ""),
    bytes: new Uint8Array([0xff, 0, 0x50, 0x44, 0x46]),
    hints: { mime: "application/pdf" },
  },
  nested: source(
    "nested-code",
    ["```ocaml", 'let value = "text"', "```"]
      .map((line) => "> ".repeat(CONTENT_LIMITS.depth - 1) + line)
      .join("\n"),
  ),
  partial: {
    ...source("partial-capture", "# Partial capture\n\n```ocaml\nlet incomplete ="),
    completeness: "partial" as const,
  },
};
type Fixture = keyof typeof fixtures;
const burstSources = Array.from({ length: 40 }, (_, i) =>
  source(`burst-${i}`, `**Visible block ${i + 1}**`),
);
const client = createContentWorkerClient();
const request: RenderRequest = {
  key: "qualification-work",
  bytes: encoder.encode(markdown),
  hints: {},
  override: "auto",
  mode: "rendered",
  startLine: 0,
  rawOffset: 0,
};
class FixtureBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failure: { readonly error: unknown } | null }
> {
  override state = { failure: null as { readonly error: unknown } | null };
  static getDerivedStateFromError(error: unknown) {
    return { failure: { error } };
  }
  override render() {
    const failure = this.state.failure;
    return failure ? (
      <section role="alert">
        <h2>Fixture caught unexpected content failure</h2>
        <pre>{failure.error instanceof Error ? failure.error.message : String(failure.error)}</pre>
      </section>
    ) : (
      this.props.children
    );
  }
}
export function FixtureApp() {
  const [burst, setBurst] = useState(false);
  const [reset, setReset] = useState(0);
  const [selected, setSelected] = useState<Fixture>("markdown");
  const [status, setStatus] = useState("Not run");
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setTicks((value) => value + 1);
    }, 25);
    return () => {
      clearInterval(timer);
    };
  }, []);
  async function decode() {
    const result = await client.decodeJson({
      key: "numeric-capture",
      bytes: encoder.encode('{"large":9007199254740993,"negative":-0,"exponent":1e999}'),
    });
    setStatus(result.ok && result.value.ok ? result.value.value.source : JSON.stringify(result));
  }
  async function cancel() {
    const abort = new AbortController();
    const job = client.render(request, abort.signal);
    abort.abort();
    const result = await job;
    setStatus(result.ok ? "Unexpected completion" : result.kind);
  }
  async function deadline() {
    const stalled = createContentWorkerClient(() => {
      const worker = new Worker(new URL("./stall.worker.ts", import.meta.url), { type: "module" });
      return {
        listen(message, failed) {
          const receive = (event: MessageEvent<unknown>) => {
            message(event.data);
          };
          worker.addEventListener("message", receive);
          worker.addEventListener("error", failed);
          return () => {
            worker.removeEventListener("message", receive);
            worker.removeEventListener("error", failed);
          };
        },
        send: (message, transfer) => {
          worker.postMessage(message, transfer);
        },
        terminate: () => {
          worker.terminate();
        },
      };
    });
    const result = await stalled.render(request);
    setStatus(result.ok ? "Unexpected completion" : result.kind);
    stalled.dispose();
  }
  return (
    <main className="fixture-main">
      <header className="fixture-heading">
        <div>
          <span className="fixture-eyebrow">WORKGRAPH / QUALIFICATION</span>
          <h1>Readable content. Exact source.</h1>
          <p>Isolated renderer fixture · synthetic inputs · no daemon data</p>
        </div>
        <Toolbar label="Fixture controls">
          <Button
            onClick={() => {
              document.documentElement.dataset.theme = "dark";
            }}
          >
            Dark
          </Button>
          <Button
            onClick={() => {
              document.documentElement.dataset.theme = "light";
            }}
          >
            Light
          </Button>
        </Toolbar>
      </header>
      <div className="fixture-controls">
        <Select
          label="Synthetic capture"
          value={selected}
          onChange={(event) => {
            const value = event.target.value;
            if (value in fixtures) {
              const fixture = Object.keys(fixtures).find((key): key is Fixture => key === value);
              if (fixture) setSelected(fixture);
            }
          }}
        >
          {Object.keys(fixtures).map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </Select>
        <Button
          onClick={() => {
            void decode();
          }}
        >
          Decode JSON in worker
        </Button>
        <Button
          onClick={() => {
            void cancel();
          }}
        >
          Cancel worker job
        </Button>
        <Button
          onClick={() => {
            void deadline();
          }}
        >
          Exercise phase deadline
        </Button>
        <Button
          onClick={() => {
            setReset((value) => value + 1);
          }}
        >
          Reset content boundary
        </Button>
        <output aria-label="Main thread heartbeat">{ticks}</output>
      </div>
      <FixtureBoundary key={reset}>
        <Button onClick={() => setBurst((value) => !value)}>Toggle content burst</Button>
        {burst ? (
          <div
            className="fixture-burst"
            style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 4 }}
          >
            {burstSources.map((capture) => (
              <ContentViewer key={capture.key} source={capture} client={client} chrome="reading" />
            ))}
          </div>
        ) : (
          <ContentViewer source={fixtures[selected]} client={client} />
        )}
      </FixtureBoundary>
      <div className="fixture-status">
        <span>Worker qualification result</span>
        <output aria-label="Worker qualification result">{status}</output>
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root, {
  onCaughtError(error: unknown) {
    sessionStorage.setItem(
      "qualification-boundary",
      error instanceof Error ? error.message : String(error),
    );
  },
}).render(<FixtureApp />);
