import { trackPageReads } from "./readiness";
import { test as base, type Request, type TestInfo } from "@playwright/test";
import {
  fixtureBinary,
  startDaemonFixture,
  type DaemonFixture,
} from "../../../../test-support/daemon-fixture.mjs";
import {
  companionBinary,
  startCompanionFixture,
  type CompanionFixture,
} from "../../../../test-support/companion-fixture.mjs";
import { buildClientBridge, type BridgeAsset } from "./bridge-build";
import type { IntegrationBridge } from "./client-bridge";
export type { IntegrationBridge };
async function attachProcess(
  info: TestInfo,
  name: string,
  phase: "before-dispose" | "after-dispose",
  fixture: Pick<DaemonFixture, "diagnostics">,
) {
  await info.attach(`${name}-${phase}`, {
    contentType: "application/json",
    body: JSON.stringify(
      {
        phase,
        testStatus: info.status,
        errorsAlreadyObserved: info.errors,
        process: fixture.diagnostics(),
      },
      null,
      2,
    ),
  });
}
interface BrowserDiagnostics {
  readonly failures: readonly string[];
  readonly expectedHTTP: Map<string, number>;
  readonly markPendingDirectoryReads: () => void;
  readonly markPendingReads: () => void;
}
interface NativeFixtures {
  readonly browserDiagnostics: BrowserDiagnostics;
  readonly daemon: DaemonFixture;
  readonly companion: CompanionFixture;
  readonly bridge: IntegrationBridge | null;
  readonly browserFailures: readonly string[];
}
export const test = base.extend<
  NativeFixtures,
  { readonly clientBridge: ReadonlyMap<string, BridgeAsset> }
>({
  // Playwright inspects destructured dependencies; these fixtures have none.
  clientBridge: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, runTest) => {
      await runTest(await buildClientBridge());
    },
    { scope: "worker" },
  ],
  // eslint-disable-next-line no-empty-pattern
  daemon: async ({}, runTest, info) => {
    const daemon = await startDaemonFixture({ binary: fixtureBinary() });
    try {
      await runTest(daemon);
    } finally {
      try {
        await attachProcess(info, "daemon", "before-dispose", daemon);
      } finally {
        try {
          await daemon.dispose();
        } finally {
          await attachProcess(info, "daemon", "after-dispose", daemon);
        }
      }
    }
  },
  // eslint-disable-next-line no-empty-pattern
  companion: async ({}, runTest, info) => {
    const companion = await startCompanionFixture({ binary: companionBinary() });
    try {
      await runTest(companion);
    } finally {
      try {
        await attachProcess(info, "companion", "before-dispose", companion);
      } finally {
        try {
          await companion.dispose();
        } finally {
          await attachProcess(info, "companion", "after-dispose", companion);
        }
      }
    }
  },
  browserFailures: async ({ browserDiagnostics }, runTest) => {
    await runTest(browserDiagnostics.failures);
  },
  browserDiagnostics: [
    async ({ daemon, page, companion, browser }, runTest, info) => {
      trackPageReads(page);
      page.context().on("page", trackPageReads);
      const failures: string[] = [];
      const consoleMessages: { type: string; text: string; url: string }[] = [];
      const cancellations: {
        method: string;
        url: string;
        expected: boolean;
        error: string;
        phase: "test" | "teardown";
      }[] = [];
      const active = new Set<Request>();
      const allowedCancellations = new Set<Request>();
      const teardownReads = new Set<Request>();
      const expectedHTTP = new Map<string, number>();
      const origin = new URL(companion.url).origin;
      page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        const url = message.location().url;
        consoleMessages.push({ type: message.type(), text: message.text(), url });
        const expectedStatus = expectedHTTP.get(url);
        if (
          message.type() === "error" &&
          !(expectedStatus !== undefined && message.text().includes(`status of ${expectedStatus}`))
        )
          failures.push(`console.error: ${url} ${message.text()}`);
      });
      page.on("request", (request) => {
        active.add(request);
        if (new URL(request.url()).origin !== origin)
          failures.push(`external request: ${request.url()}`);
      });
      page.on("requestfinished", (request) => active.delete(request));
      page.on("requestfailed", (request) => {
        active.delete(request);
        const error = request.failure()?.errorText ?? "unknown";
        const intentionalTeardown = teardownReads.delete(request);
        const expected =
          (allowedCancellations.delete(request) || intentionalTeardown) &&
          error === "net::ERR_ABORTED";
        cancellations.push({
          method: request.method(),
          url: request.url(),
          expected,
          error,
          phase: intentionalTeardown ? "teardown" : "test",
        });
        if (!expected)
          failures.push(`requestfailed: ${request.method()} ${request.url()} ${error}`);
      });
      await info.attach("native-fixture", {
        contentType: "application/json",
        body: JSON.stringify(
          {
            browser: browser.version(),
            binary: companion.binary,
            binary_sha256: companion.binarySha256,
            ready: companion.ready,
          },
          null,
          2,
        ),
      });
      await runTest({
        failures,
        expectedHTTP,
        markPendingReads: () => {
          // Only reads already observed before the explicit actor/scope change may cancel.
          for (const request of active)
            if (
              request.method() === "POST" &&
              ["/ui-api/v1/read", "/ui-api/v1/live-observations"].some(
                (path) => request.url() === new URL(path, origin).href,
              )
            )
              allowedCancellations.add(request);
        },
        markPendingDirectoryReads: () => {
          // Only requests already observed before the explicit reload/refresh may cancel.
          // A new request, mutation, foreign endpoint or different network error still fails.
          for (const request of active)
            if (
              request.method() === "GET" &&
              request.url() === new URL("/ui-api/v1/connections", origin).href
            )
              allowedCancellations.add(request);
        },
      });
      // The consumer must stop before either native service. Retain every active request;
      // only exact reads already active at this deliberate close may cancel intentionally.
      const teardown = {
        startedAt: new Date().toISOString(),
        daemon: daemon.diagnostics(),
        companion: companion.diagnostics(),
        active: [...active].map((request) => ({ method: request.method(), url: request.url() })),
      };
      for (const request of active) {
        const url = new URL(request.url());
        if (
          url.origin === origin &&
          ((request.method() === "POST" &&
            ["/ui-api/v1/read", "/ui-api/v1/live-observations"].includes(url.pathname)) ||
            (request.method() === "GET" && url.pathname === "/ui-api/v1/connections"))
        )
          teardownReads.add(request);
      }
      page.context().off("page", trackPageReads);
      if (!page.isClosed()) await page.close();
      await info.attach("browser-diagnostics", {
        contentType: "application/json",
        body: JSON.stringify({ consoleMessages, cancellations, failures, teardown }, null, 2),
      });
      if (failures.length) throw new Error(failures.join("\n"));
    },
    { auto: true },
  ],
  bridge: async ({ page, context, companion, clientBridge }, runTest) => {
    const url = new URL("/__workgraph-test__/client-bridge.js", companion.url).href;
    await context.route("**/__workgraph-test__/**", (route) => {
      const asset = clientBridge.get(new URL(route.request().url()).pathname);
      return asset
        ? route.fulfill({
            status: 200,
            contentType: asset.contentType,
            body: typeof asset.body === "string" ? asset.body : Buffer.from(asset.body),
          })
        : route.fulfill({ status: 404, body: "Missing test asset" });
    });
    // No API/static production response is replaced. The test-only module is memory-only.
    await page.goto(companion.url);
    await page.addScriptTag({ type: "module", url });
    await page.waitForFunction(() => window.workgraphIntegration !== undefined);
    await runTest(null);
  },
});
export { expect } from "@playwright/test";
