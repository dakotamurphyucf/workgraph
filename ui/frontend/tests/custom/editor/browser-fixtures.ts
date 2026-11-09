/** Actual embedded Application qualification helpers; no replacement application or routed data. */
export async function mountEditor(
  page: import("@playwright/test").Page,
  companion: import("../../../../test-support/companion-fixture.mjs").CompanionFixture,
  daemon: import("../../../../test-support/daemon-fixture.mjs").DaemonFixture,
) {
  const response = await page.request.get(companion.url),
    capability = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(
      await response.text(),
    )?.[1];
  if (capability === undefined) throw new Error("Native capability missing");
  const headers = {
    Origin: new URL(companion.url).origin,
    "X-Workgraph-UI-Capability": capability,
  };
  for (const [path, data] of [
    ["/connections", { id: "local", label: "Custom views qualification", socket: daemon.socket }],
    ["/connections/local/attach", { generation: "1" }],
  ] as const) {
    const result = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
      headers,
      data,
    });
    if (result.status() !== 200) throw new Error(await result.text());
    await result.text();
  }
  await page.goto(new URL("/#/saved?connection=local&workspace=demo", companion.url).href);
  await page.getByRole("button", { name: "New view", exact: true }).waitFor();
  await page.getByRole("button", { name: "Refresh library", exact: true }).click();
  await page.getByRole("heading", { name: "Make this workspace your own", exact: true }).waitFor();
  return {
    headers,
    async request(path: string, data: unknown) {
      return page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, { headers, data });
    },
  };
}
export function editorPanel(page: import("@playwright/test").Page, title: string) {
  return page
    .locator(".wg-panel")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}
export function nativeWriter(
  daemon: import("../../../../test-support/daemon-fixture.mjs").DaemonFixture,
) {
  let serial = 0;
  return (method: string, params: Readonly<Record<string, unknown>>) =>
    daemon.call(
      method,
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: `custom-${++serial}`,
        ...params,
      }),
    );
}
export async function editorActor(page: import("@playwright/test").Page) {
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill("fixture-author");
  await page.getByLabel("Run ID (optional)", { exact: true }).fill("");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
}
export async function importConfigurations(
  page: import("@playwright/test").Page,
  documents: readonly { readonly id: string; readonly source: string }[],
) {
  await page.getByText("Import portable settings", { exact: true }).click();
  await page
    .getByLabel("Portable settings JSON", { exact: true })
    .fill(JSON.stringify({ settings_version: 1, documents, selected_id: null }));
  await page.getByRole("button", { name: "Review import", exact: true }).click();
  await page.getByRole("button", { name: "Save reviewed import privately", exact: true }).waitFor();
  for (const button of await page.getByRole("button", { name: "Confirm scope", exact: true }).all())
    await button.click();
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith("/view-settings/replace") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save reviewed import privately", exact: true }).click();
  await (await response).finished();
  await page.getByText(/Private settings saved at revision/u).waitFor();
  await page.getByText("Import portable settings", { exact: true }).click();
}
export async function openConfiguration(page: import("@playwright/test").Page, name: string) {
  const row = page
    .locator(".wg-custom-saved > li")
    .filter({ has: page.locator("code").filter({ hasText: new RegExp(`^${name}$`, "u") }) });
  await row.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("button", { name: "Raw source", exact: true }).waitFor();
}
export async function editorScreenshot(
  page: import("@playwright/test").Page,
  info: import("@playwright/test").TestInfo,
  name: string,
) {
  await page
    .getByRole("heading", { name: "Preparing content", exact: true })
    .waitFor({ state: "hidden" });
  await page.evaluate(() => {
    for (const node of document.querySelectorAll<HTMLElement>(".wg-content")) node.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  const file = info.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await info.attach(name, { path: file, contentType: "image/png" });
}

/** Exact negative discovery only: every 404 must be the planned new resource at this capture. */
export async function reviewSharedPublication(
  page: import("@playwright/test").Page,
  companion: import("../../../../test-support/companion-fixture.mjs").CompanionFixture,
  diagnostics: { readonly expectedHTTP: Map<string, number> },
  missingResourceIds: readonly string[],
  info: import("@playwright/test").TestInfo,
) {
  const { expect } = await import("@playwright/test");
  const url = new URL("/ui-api/v1/read", companion.url).href;
  const pending: Promise<void>[] = [],
    failures: unknown[] = [],
    observations: unknown[] = [],
    seen: string[] = [];
  const observe = (response: import("@playwright/test").Response) => {
    if (response.url() !== url || response.status() !== 404) return;
    pending.push(
      (async () => {
        const request = response.request();
        const body = request.postDataJSON() as {
          connection_id: string;
          generation: string;
          method: string;
          params: { workspace_id: string; resource_id: string };
        };
        const problem = (await response.json()) as { error: { kind: string } };
        observations.push({ status: response.status(), request: body, response: problem });
        expect(request.method()).toBe("POST");
        expect(body.connection_id).toBe("local");
        expect(body.generation).toBe("1");
        expect(body.method).toBe("resource.get");
        expect(body.params.workspace_id).toBe("demo");
        expect(missingResourceIds).toContain(body.params.resource_id);
        expect(problem.error.kind).toBe("Not_found");
        seen.push(body.params.resource_id);
        await response.finished();
      })().catch((error: unknown) => {
        failures.push(error);
      }),
    );
  };
  diagnostics.expectedHTTP.set(url, 404);
  page.on("response", observe);
  try {
    await page.getByRole("button", { name: "Review shared publication", exact: true }).click();
    await expect(
      editorPanel(page, "Captured shared publication").getByRole("button", {
        name: "Execute saved request",
        exact: true,
      }),
    ).toBeEnabled();
    await Promise.all(pending);
    expect(failures).toEqual([]);
    expect([...new Set(seen)].sort()).toEqual([...missingResourceIds].sort());
  } finally {
    page.off("response", observe);
    diagnostics.expectedHTTP.delete(url);
    await info.attach(`exact-new-resource-discovery-${missingResourceIds.join("-")}`, {
      body: JSON.stringify(observations, null, 2),
      contentType: "application/json",
    });
  }
}
