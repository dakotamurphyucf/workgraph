import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CODE_LANGUAGES, resolveFormat } from "../../src/content/languages";
import { CONTENT_LIMITS } from "../../src/content/limits";
import { renderContent, processContentJob } from "../../src/content/processor";
import { RenderTree } from "../../src/content/RenderTree";
import { readWorkerMessage, readWorkerRequest } from "../../src/content/wire";
import type { CodeLanguage, RenderRequest } from "../../src/content/types";
const encoder = new TextEncoder();
function request(text: string, extra: Partial<RenderRequest> = {}): RenderRequest {
  return {
    key: "connection-1:gen-2:resource-v3",
    bytes: encoder.encode(text),
    hints: {},
    override: "auto",
    mode: "rendered",
    startLine: 0,
    rawOffset: 0,
    ...extra,
  };
}
function reply(text: string) {
  const preview = renderContent(request(text));
  return {
    protocol: 1,
    jobId: "content-1",
    key: preview.key,
    kind: "complete",
    result: { kind: "render", preview },
  };
}
describe("metadata and explicit language selection", () => {
  it("uses deterministic hint precedence, never content guesses", () => {
    expect(
      resolveFormat({ language: "ml", mime: "application/json", filename: "file.py" }, "auto"),
    ).toEqual({ kind: "code", language: "ocaml", via: "language" });
    expect(resolveFormat({ language: "alien", mime: "application/json" }, "auto")).toEqual({
      kind: "code",
      language: null,
      via: "language",
    });
    expect(
      resolveFormat({ mime: "application/json; charset=utf-8", filename: "x.py" }, "auto").language,
    ).toBe("json");
    expect(resolveFormat({ filename: "capture.mli" }, "auto").language).toBe("ocaml");
    expect(resolveFormat({ filename: "json" }, "auto").kind).toBe("markdown");
    expect(resolveFormat({ mime: "application/pdf" }, "auto").kind).toBe("binary");
    expect(resolveFormat({ language: "python" }, "plain").kind).toBe("plain");
    expect(resolveFormat({ intent: "code" }, "auto")).toMatchObject({
      kind: "code",
      language: null,
    });
  });
  const samples: Record<CodeLanguage, string> = {
    ocaml: 'let value = "text" (* comment *)',
    typescript: 'const value: string = "text";',
    javascript: 'const value = "text";',
    json: '{"large":9007199254740993}',
    bash: 'echo "$HOME" # comment',
    python: 'def f():\n    return "text"',
    markdown: "# Header\n**strong**",
    yaml: 'key: "value"',
    toml: '[section]\nkey = "value"',
    html: '<div class="example">text</div>',
    css: "body { color: red; }",
    diff: "@@ -1 +1 @@\n-old\n+new",
  };
  it.each(CODE_LANGUAGES)(
    "bundles actual %s highlighting without changing its source",
    (language) => {
      const preview = renderContent(
        request(samples[language], { hints: { language }, mode: "source" }),
      );
      expect(preview.status).toBe("rich");
      expect(preview.copyText).toBe(samples[language]);
      expect(JSON.stringify(preview.nodes)).toContain('"kind":"token"');
      expect(
        readWorkerMessage({
          protocol: 1,
          jobId: "content-1",
          key: preview.key,
          kind: "complete",
          result: { kind: "render", preview },
        }),
      ).not.toBeNull();
    },
  );
});
describe("passive Markdown and exact captures", () => {
  it("renders tables, headings, lists, escaped Markdown and entities without active markup", () => {
    const source =
      "# Title &amp; &#x3bb;\n\n\\*literal\\* **strong**\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n&lt;script&gt;alert(1)&lt;/script&gt;\n\n<script>window.pwned=1</script>\n\n[bad](javascript:alert(1)) ![image](https://example.invalid/pixel.png)";
    const preview = renderContent(request(source));
    const html = renderToStaticMarkup(<RenderTree nodes={preview.nodes} />);
    expect(html).toContain("Title &amp; λ");
    expect(html).toContain("*literal*");
    expect(html).toContain("<strong>strong</strong>");
    expect(html).toContain("<table>");
    expect(html).toContain("<li>[x] done</li>");
    expect(preview.diagnostics).toEqual([]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("javascript:alert(1)");
    expect(html).not.toMatch(/<(?:script|img|svg|iframe|a|form|style)(?:\s|>)/u);
    expect(html).not.toContain(" href=");
    expect(html).not.toContain(" src=");
    expect(preview.copyText).toBe(source);
  });
  it("keeps code, unknown fences and source entities literal; override never rewrites bytes", () => {
    const source = "```alien\n&lt;script&gt;\n```\n\n`&amp;`";
    const preview = renderContent(request(source));
    const html = renderToStaticMarkup(<RenderTree nodes={preview.nodes} />);
    expect(html).toContain("&amp;lt;script&amp;gt;");
    expect(html).toContain("&amp;amp;");
    const plain = renderContent(request(source, { override: "plain" }));
    expect(plain.copyText).toBe(source);
    const raw = renderContent(request(source, { mode: "raw" }));
    expect(raw.rawHex).toContain("60 60 60");
  });
  it("retains raw destination descriptors including entity-encoded unsafe schemes", () => {
    const value = reply("[label &amp;](javascript&colon;alert(1))");
    const message = readWorkerMessage(value);
    expect(message?.kind).toBe("complete");
    expect(JSON.stringify(message)).toContain('"raw":"[label &amp;](javascript&colon;alert(1))"');
    const html = renderToStaticMarkup(<RenderTree nodes={value.result.preview.nodes} />);
    expect(html).toContain("javascript&amp;colon;alert(1)");
    expect(html).not.toContain("href=");
    expect(JSON.stringify(value.result.preview.nodes)).toContain("javascript&colon;alert(1)");
  });
  it("retains BOM/CRLF and exact JSON numeric lexemes in the separate worker decode job", () => {
    const source = "\uFEFF# Heading\r\n\r\nText &amp;\r\n";
    expect(renderContent(request(source)).copyText).toBe(source);
    expect(
      renderToStaticMarkup(<RenderTree nodes={renderContent(request(source)).nodes} />),
    ).toContain("<h1>Heading</h1>");
    const raw = '{"large":9007199254740993,"negative":-0,"exponent":1e999,"same":1.0}';
    const result = processContentJob({
      kind: "json",
      request: { key: "json", bytes: encoder.encode(raw) },
    });
    expect(JSON.stringify(result)).toContain('"lexeme":"9007199254740993"');
    expect(JSON.stringify(result)).toContain('"lexeme":"1e999"');
    expect(JSON.stringify(result)).toContain('"lexeme":"-0"');
    expect(
      readWorkerMessage({ protocol: 1, jobId: "content-1", key: "json", kind: "complete", result }),
    ).not.toBeNull();
    const duplicate = processContentJob({
      kind: "json",
      request: { key: "json", bytes: encoder.encode('{"x":1,"\\u0078":2}') },
    });
    expect(
      duplicate.kind === "json" && !duplicate.document.ok && duplicate.document.error.code,
    ).toBe("duplicate_key");
  });
  it("never forces invalid UTF-8 or binary controls into Markdown", () => {
    const invalid = renderContent({ ...request(""), bytes: new Uint8Array([0xc0, 0xaf]) });
    expect(invalid.status).toBe("binary");
    expect(invalid.copyText).toBeNull();
    expect(invalid.rawHex).toContain("c0 af");
    expect(renderContent(request("hello\0world")).status).toBe("binary");
    expect(
      renderContent(request("%PDF printable", { hints: { mime: "application/pdf" } })).status,
    ).toBe("binary");
  });
  it("bounds rich nodes/bytes/lines and long source windows while retaining raw access", () => {
    const large = renderContent(request("x".repeat(CONTENT_LIMITS.richBytes + 1)));
    expect(large.status).toBe("limited");
    expect(large.copyText).toBeNull();
    expect(large.window?.lines[0]?.text.length).toBe(CONTENT_LIMITS.lineCharacters);
    expect(large.window?.lines[0]?.omittedCharacters).toBeGreaterThan(0);
    const nodes = renderContent(request("**x** ".repeat(2600)));
    expect(nodes.status).toBe("rich");
    expect(nodes.diagnostics).toEqual([]);
    const lines = renderContent(
      request("x\n".repeat(CONTENT_LIMITS.richLines + 1), { startLine: 200 }),
    );
    expect(lines.status).toBe("limited");
    expect(lines.window?.lines).toHaveLength(200);
    expect(lines.window?.lines[0]?.number).toBe(200);
    const highlight = renderContent(
      request("x".repeat(CONTENT_LIMITS.highlightBytes + 1), { hints: { language: "ocaml" } }),
    );
    expect(highlight.status).toBe("limited");
    expect(highlight.diagnostics.join()).toContain("preview exceeds");
  });
});
describe("aggregate render and syntax budgets", () => {
  it("highlights a 5000-record JSON capture beyond the previous tiny byte and node limits", () => {
    const source = JSON.stringify(
      Array.from({ length: 5000 }, (_, i) => ({
        id: i,
        title: `Ticket ${i}`,
        status: "in_progress",
        description: "Representative structured data for content qualification.",
      })),
      null,
      2,
    );
    const preview = renderContent(request(source, { hints: { language: "json" } }));
    expect(preview.status).toBe("rich");
    expect(preview.diagnostics).toEqual([]);
    expect(preview.copyText).toBe(source);
    expect(
      readWorkerMessage({
        protocol: 1,
        jobId: "json-large",
        key: preview.key,
        kind: "complete",
        result: { kind: "render", preview },
      }),
    ).not.toBeNull();
  });
  it.each(["ocaml", "unknown"])(
    "falls back before %s code exceeds combined Markdown/syntax depth",
    (language) => {
      for (let depth = CONTENT_LIMITS.depth - 7; depth <= CONTENT_LIMITS.depth + 2; depth += 1) {
        const prefix = "> ".repeat(depth);
        const source = ["```" + language, 'let value = "text"', "```"]
          .map((line) => prefix + line)
          .join("\n");
        const preview = renderContent(request(source));
        const decoded = readWorkerMessage({
          protocol: 1,
          jobId: "content-1",
          key: preview.key,
          kind: "complete",
          result: { kind: "render", preview },
        });
        expect(decoded, `depth ${depth}`).not.toBeNull();
        expect(preview.copyText).toBe(source);
        if (depth >= (language === "ocaml" ? CONTENT_LIMITS.depth - 1 : CONTENT_LIMITS.depth)) {
          expect(preview.status).toBe("limited");
          expect(preview.nodes).toEqual([]);
          expect(preview.window?.lines.length).toBeGreaterThan(0);
          expect(preview.diagnostics.join()).toContain("nesting");
        }
      }
    },
  );
  it("uses the same aggregate node guard for producer and response decoder", () => {
    const message = reply("Text");
    const nodes = Array.from({ length: CONTENT_LIMITS.nodes }, () => ({ kind: "text", text: "x" }));
    expect(
      readWorkerMessage({
        ...message,
        result: { kind: "render", preview: { ...message.result.preview, nodes } },
      }),
    ).not.toBeNull();
    expect(
      readWorkerMessage({
        ...message,
        result: {
          kind: "render",
          preview: {
            ...message.result.preview,
            nodes: [...nodes, { kind: "text", text: "overflow" }],
          },
        },
      }),
    ).toBeNull();
  });
});
describe("worker message validation", () => {
  it("rejects arbitrary tags/attributes, unknown properties and excessive node trees", () => {
    const message = reply("Text");
    expect(readWorkerMessage(message)).not.toBeNull();
    const malicious = {
      ...message,
      result: {
        kind: "render",
        preview: {
          ...message.result.preview,
          nodes: [{ kind: "element", tag: "img", children: [], align: null, start: null }],
        },
      },
    };
    expect(readWorkerMessage(malicious)).toBeNull();
    expect(readWorkerMessage({ ...message, script: "execute" })).toBeNull();
    expect(readWorkerMessage({ ...message, key: "\uD800" })).toBeNull();
    expect(readWorkerMessage({ ...message, key: "paired-😀" })).not.toBeNull();
    expect(
      readWorkerMessage({
        ...message,
        result: {
          kind: "render",
          preview: {
            ...message.result.preview,
            nodes: Array.from({ length: CONTENT_LIMITS.nodes + 1 }, () => ({
              kind: "text",
              text: "x",
            })),
          },
        },
      }),
    ).toBeNull();
    expect(
      readWorkerRequest({
        protocol: 1,
        jobId: "content-1",
        key: "capture",
        job: {
          kind: "render",
          request: { ...request("x"), key: "capture", hints: { script: "run" } },
        },
      }),
    ).toBeNull();
    expect(
      readWorkerRequest({
        protocol: 1,
        jobId: "content-1",
        key: "capture",
        job: {
          kind: "json",
          request: {
            key: "capture",
            bytes: new Uint8Array(),
            limits: { maxBytes: Infinity, maxDepth: 96, maxNodes: 1, maxStringBytes: 1 },
          },
        },
      }),
    ).toBeNull();
  });
});
