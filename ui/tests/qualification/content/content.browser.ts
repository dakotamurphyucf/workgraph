import { test, expect } from "../../../frontend/tests/e2e/support/fixtures";
import { mountEditor, nativeWriter } from "../../../frontend/tests/custom/editor/browser-fixtures";

test.setTimeout(45000);
test.use({ viewport: { width: 1440, height: 1000 }, actionTimeout: 10000 });

test("native companion admits only bundled passive content capabilities", async ({
  companion,
}, info) => {
  const response = await fetch(companion.url);
  expect(response.status).toBe(200);
  const headers = Object.fromEntries(response.headers),
    csp = headers["content-security-policy"];
  expect(csp).toBeDefined();
  const directives = new Map(
    (csp ?? "").split(";").map((part) => {
      const [name, ...values] = part.trim().split(/\s+/u);
      return [name, values];
    }),
  );
  for (const key of ["default-src", "object-src", "base-uri", "frame-ancestors", "form-action"])
    expect(directives.get(key), key).toEqual(["'none'"]);
  for (const key of ["script-src", "connect-src", "worker-src"])
    expect(directives.get(key), key).toEqual(["'self'"]);
  expect(directives.get("img-src")).toEqual(["'self'", "data:"]);
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
  const html = await response.text();
  expect(html).not.toContain("http://");
  expect(html).not.toContain("https://");
  await info.attach("actual-native-security-headers", {
    body: JSON.stringify({ status: response.status, headers }, null, 2),
    contentType: "application/json",
  });
});

test("absent native usage stays unknown while one explicit zero report is reported zero", async ({
  page,
  companion,
  daemon,
}, info) => {
  const foreign: string[] = [],
    origin = new URL(companion.url).origin;
  page.on("request", (request) => {
    if (/^https?:/u.test(request.url()) && new URL(request.url()).origin !== origin)
      foreign.push(request.url());
  });
  await mountEditor(page, companion, daemon);
  await page.goto(new URL("/#/history?connection=local&workspace=demo", companion.url).href);
  await page.getByRole("button", { name: "Usage reports", exact: true }).click();
  const usage = page.getByRole("region", {
    name: "Reported usage",
    exact: true,
  });
  const rescan = async () => {
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/ui-api/v1/read") &&
        r.request().postData()?.includes('"method":"usage.aggregate"') === true,
    );
    await usage.getByRole("button", { name: "Rescan usage", exact: true }).click();
    const result = await response;
    expect(result.status()).toBe(200);
    await result.finished();
    return result.text();
  };
  const absent = await rescan();
  await expect(
    usage.getByText("No reported observations; consumption unknown.", {
      exact: true,
    }),
  ).toBeVisible();
  const write = nativeWriter(daemon);
  const registered = await write("run.register", {
    target_run_id: "reported-zero",
    objective: "Synthetic explicit zero report",
  });
  const registration: unknown = JSON.parse(registered);
  expect(registration).not.toHaveProperty("error");
  expect(registration).toHaveProperty("result");
  const saved = await write("usage.report", {
    usage_id: "zero-observation",
    scope: { kind: "run", run_id: "reported-zero" },
    reported_actor_id: "fixture-author",
    provenance: "Synthetic explicit zero, not a missing observation",
    timestamp: "source clock unavailable",
    tokens: "0",
    elapsed_ms: "0",
    metrics: [{ name: "bytes", unit: "bytes", value: "0" }],
  });
  const publication: unknown = JSON.parse(saved);
  expect(publication).not.toHaveProperty("error");
  expect(publication).toHaveProperty("result");
  const zero = await rescan();
  await expect(usage.locator(".ha-totals").first()).toHaveText(
    "0 reported tokens · 0 reported milliseconds · 1 reports",
  );
  await expect(
    usage.getByText("No reported observations; consumption unknown.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(usage.getByText("bytes", { exact: true }).first()).toBeVisible();
  expect(foreign).toEqual([]);
  await info.attach("native-absent-and-explicit-zero", {
    body: JSON.stringify({ absent, zero, foreign }, null, 2),
    contentType: "application/json",
  });
  await page.screenshot({
    path: info.outputPath("reported-zero.png"),
    fullPage: true,
  });
});
