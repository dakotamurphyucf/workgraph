import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonicalJson } from "../../../../src/core/json";
import { test, expect } from "@playwright/test";
import { startDaemonFixture, fixtureBinary } from "../../../../../test-support/daemon-fixture.mjs";
import {
  startCompanionFixture,
  companionBinary,
} from "../../../../../test-support/companion-fixture.mjs";
import { createHttpClient } from "../../../../src/core/protocol/http";
import { createSourceAdapter } from "../../../../src/features/custom/editor/source";
import type { ConfigSource } from "../../../../src/features/custom/config";
import { view } from "../../config/fixtures";
import { decode, target } from "../fixtures";
import * as d from "../../../../src/core/protocol/decoders";
import { createTestProcessor } from "../../../core/processing-harness";

const sources: readonly ConfigSource[] = [
  "tickets",
  "runs",
  "attempts",
  "sessions",
  "resources",
  "facts",
  "discussions",
  "activity",
];
// Actual daemon + companion boundary; this group does not construct a browser.
// eslint-disable-next-line no-empty-pattern
test("eight actual native sources traverse captured pages with exact scope, fact values and resource JSON", async ({}, info) => {
  test.setTimeout(180_000);
  const daemon = await startDaemonFixture({ binary: fixtureBinary() });
  let companion: Awaited<ReturnType<typeof startCompanionFixture>> | null = null;
  let bodyFailure: unknown;
  let bodyFailed = false;
  const cleanupFailures: unknown[] = [];
  const processing = createTestProcessor();
  const responses: { path: string; request: string | null; response: string }[] = [];
  let serial = 0;
  try {
    companion = await startCompanionFixture({ binary: companionBinary() });
    const execute = promisify(execFile),
      ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addKeyword({
      keyword: "x-maxUtf8Bytes",
      type: "string",
      validate: (maximum: number, text: string) => Buffer.byteLength(text) <= maximum,
    });
    ajv.addKeyword({
      keyword: "x-maximumDecimal",
      type: "string",
      validate: (maximum: string, text: string) =>
        /^(0|[1-9][0-9]*)$/u.test(text) && BigInt(text) <= BigInt(maximum),
    });
    const schemas = new Map<string, ReturnType<typeof ajv.compile>>();
    async function validate(method: string, params: object) {
      let schema = schemas.get(method);
      if (!schema) {
        const { stdout } = await execute(fixtureBinary(), ["schema", method], {
          timeout: 10000,
          maxBuffer: 8 * 1024 * 1024,
        });
        const result = JSON.parse(stdout) as { methods: { params: object }[] };
        if (!result.methods[0]) throw new Error(`Missing native schema ${method}`);
        schema = ajv.compile(result.methods[0].params);
        schemas.set(method, schema);
      }
      if (!schema(params)) throw new Error(`${method} schema: ${JSON.stringify(schema.errors)}`);
    }
    const write = async (method: string, params: Readonly<Record<string, unknown>>) => {
      const captured = {
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: `adapter-probe-${++serial}`,
        ...params,
      };
      await validate(method, captured);
      return daemon.call(method, JSON.stringify(captured));
    };
    await write("run.register", {
      target_run_id: "adapter-run",
      objective: "Native adapter proof",
    });
    const claim = JSON.parse(
      await write("ticket.claim", { ticket_id: "design", run_id: "adapter-run" }),
    ) as { result: { data: { token: string } } };
    await write("attempt.start", {
      attempt_id: "adapter-attempt",
      target_run_id: "adapter-run",
      run_id: "adapter-run",
      ticket_id: "design",
      token: claim.result.data.token,
    });
    // 101 native identities per domain force actual continuations beyond the
    // adapter's fixed 100-row request. They are not timed cancellation padding.
    for (let index = 0; index < 101; index++) {
      const id = `page-${String(index).padStart(3, "0")}`;
      await write("ticket.create", {
        ticket_id: id,
        project_id: "release",
        title: `Adapter ticket ${index}`,
      });
      await write("run.register", { target_run_id: id, objective: `Adapter run ${index}` });
      const claim = JSON.parse(await write("ticket.claim", { ticket_id: id, run_id: id })) as {
        result: { data: { token: string } };
      };
      await write("attempt.start", {
        attempt_id: id,
        target_run_id: id,
        run_id: id,
        ticket_id: id,
        token: claim.result.data.token,
      });
      await write("session.create", {
        session_id: id,
        title: `Adapter session ${index}`,
        scopes: [{ kind: "project", id: "release" }],
      });
      await write("resource.put_text", {
        resource_id: id,
        expected_revision: "0",
        title: `Adapter JSON ${index}`,
        filename: `${id}.json`,
        mime_type: "application/json",
        text: `{"index":${index},"nullable":null}`,
      });
      await write("resource.link", {
        resource_id: id,
        expected_revision: "1",
        target: { kind: "project", id: "release" },
      });
      await write("fact.put", {
        scope: { kind: "project", id: "release" },
        key: id,
        expected_revision: "0",
        value: { index, nullable: null },
      });
      await write("thread.put", {
        thread_id: id,
        expected_revision: "0",
        board_id: "team",
        title: `Adapter thread ${index}`,
        participants: [],
        mentions: [],
        links: [],
        state: "open",
        pinned: false,
      });
    }
    await write("board.put", {
      board_id: "other-scope",
      expected_revision: "0",
      scope: { kind: "workspace" },
      title: "Excluded scope",
    });
    await write("thread.put", {
      thread_id: "excluded-thread",
      expected_revision: "0",
      board_id: "other-scope",
      title: "Must not inherit project scope",
      participants: [],
      mentions: [],
      links: [],
      state: "open",
      pinned: false,
    });
    const bootstrap = await fetch(companion.url);
    const capability = /<meta name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(
      await bootstrap.text(),
    )?.[1];
    if (!capability) throw new Error("Missing companion capability");
    const origin = new URL(companion.url).origin;
    for (const [url, body] of [
      ["/connections", { id: "local", label: "Adapter endpoint", socket: daemon.socket }],
      ["/connections/local/attach", { generation: "1" }],
    ] as const) {
      const response = await fetch(`${origin}/ui-api/v1${url}`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Workgraph-UI-Capability": capability,
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    const http = createHttpClient({
      origin,
      capability,
      processing,
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Origin", origin);
        if (typeof init?.body === "string") {
          const body = JSON.parse(init.body) as { method: string; params: object };
          await validate(body.method, body.params);
        }
        const response = await fetch(input, { ...init, headers });
        responses.push({
          path: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          request: typeof init?.body === "string" ? init.body : null,
          response: await response.clone().text(),
        });
        return response;
      },
    });
    const api = createSourceAdapter(http);
    const owner = {
      ...target,
      connection: decode(d.connectionProfile, {
        id: "local",
        generation: "1",
        label: "Adapter endpoint",
        socket: daemon.socket,
      }),
    };
    const checks: { source: ConfigSource; rows: number; complete: boolean; partial: boolean }[] =
      [];
    for (const source of sources) {
      const config = view(
        source,
        source === "resources" || source === "facts" || source === "discussions"
          ? { scope: { kind: "project", id: "release" } }
          : {},
      );
      let result = await api.initial(owner, config, new AbortController().signal);
      if (!result.ok) throw new Error(`${source}: ${JSON.stringify(result.failure)}`);
      const identities: string[] = [],
        nativeIdentities: string[] = [],
        captures: object[] = [],
        pageSizes: number[] = [];
      let pages = 0;
      for (;;) {
        if (!result.ok)
          throw new Error(`${source} continuation: ${JSON.stringify(result.failure)}`);
        const page = result.data;
        expect(page.rows.length).toBeGreaterThan(0);
        pageSizes.push(page.rows.length);
        identities.push(...page.rows.map((row) => row.identity));
        captures.push(page.capture);
        // Independent direct socket reply with the identical captured request.
        const encoded = canonicalJson(page.invocation.params, {
          maxBytes: 1048576,
          maxDepth: 64,
          maxNodes: 10000,
          maxStringBytes: 1048576,
        });
        if (!encoded.ok) throw new Error(encoded.error.message);
        const native = JSON.parse(await daemon.call(page.invocation.method, encoded.value)) as {
          result: {
            data: {
              items?: Record<string, unknown>[];
              entries?: { workspace_revision: string; change_index: string }[];
            };
          };
        };
        const raw = native.result.data;
        if (source === "activity")
          nativeIdentities.push(
            ...(raw.entries ?? []).map((row) => `${row.workspace_revision}:${row.change_index}`),
          );
        else
          nativeIdentities.push(
            ...(raw.items ?? []).map((row) =>
              String(
                row[
                  (
                    {
                      tickets: "ticket_id",
                      runs: "run_id",
                      attempts: "attempt_id",
                      sessions: "session_id",
                      resources: "resource_id",
                      facts: "key",
                      discussions: "thread_id",
                    } as const
                  )[source]
                ],
              ),
            ),
          );
        pages++;
        if (pages === 1 && source === "sessions")
          await write("session.create", {
            session_id: "late-session",
            title: "Outside retained head",
            scopes: [],
          });
        if (page.next === null) {
          expect(page.complete).toBe(true);
          break;
        }
        if (pages >= 32) throw new Error(`Unexpected unbounded ${source} traversal`);
        result = await api.next(page, "next", new AbortController().signal);
      }
      expect(pages).toBeGreaterThan(1);
      expect(new Set(identities).size).toBe(identities.length);
      expect(identities).toEqual(nativeIdentities);
      if (source !== "activity")
        for (let index = 0; index < 101; index++)
          expect(identities).toContain(`page-${String(index).padStart(3, "0")}`);
      if (source === "sessions") expect(identities).not.toContain("late-session");
      if (source === "discussions") expect(identities).not.toContain("excluded-thread");
      checks.push({
        source,
        rows: identities.length,
        complete: true,
        partial: result.data.partial,
      });
      await info.attach(`native-${source}-traversal`, {
        body: JSON.stringify({ pageSizes, identities, nativeIdentities, captures }, null, 2),
        contentType: "application/json",
      });
    }
    const resourceView = view("resources", {
      scope: { kind: "project", id: "release" },
      columns: [
        {
          id: "index",
          selector: { kind: "pointer", pointer: "/index" },
          label: "Index",
          format: { type: "number" },
        },
      ],
    });
    const resources = await api.initial(owner, resourceView, new AbortController().signal);
    if (!resources.ok) throw new Error(JSON.stringify(resources.failure));
    expect(
      resources.data.enrichment?.rows.filter((row) => row.status === "decoded").length,
    ).toBeGreaterThan(0);
    expect(resources.data.rows.find((row) => row.identity === "page-000")?.decoded?.kind).toBe(
      "object",
    );
    expect(resources.data.enrichment?.reads.length).toBe(
      resources.data.enrichment?.rows.filter((row) => row.status === "decoded").length,
    );
    await info.attach("native-adapter-checks", {
      body: JSON.stringify(checks, null, 2),
      contentType: "application/json",
    });
  } catch (error) {
    bodyFailure = error;
    bodyFailed = true;
  } finally {
    try {
      processing.dispose();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await companion?.dispose();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await daemon.dispose();
    } catch (error) {
      cleanupFailures.push(error);
    }
    await info.attach("native-adapter-exchanges", {
      body: JSON.stringify(responses, null, 2),
      contentType: "application/json",
    });
    await info.attach("native-adapter-processes", {
      body: JSON.stringify(
        {
          daemon: daemon.diagnostics(),
          companion: companion?.diagnostics() ?? { started: false },
          cleanupFailures: cleanupFailures.map((error) =>
            error instanceof Error ? error.message : "Non-Error cleanup failure",
          ),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  }
  if (cleanupFailures.length > 0)
    throw new AggregateError(
      bodyFailed ? [bodyFailure, ...cleanupFailures] : cleanupFailures,
      "Adapter fixture cleanup failed; all owned cleanup paths were attempted.",
    );
  if (bodyFailed) throw bodyFailure;
});
