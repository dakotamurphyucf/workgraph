import { waitForPageReads } from "./support/readiness";
import type { Page, TestInfo } from "@playwright/test";
import type { CompanionFixture } from "../../../test-support/companion-fixture.mjs";
import { test, expect } from "./support/fixtures";

test.use({
  viewport: { width: 1280, height: 800 },
  colorScheme: "dark",
  reducedMotion: "reduce",
  actionTimeout: 10000,
});
async function mount(
  page: Page,
  companion: CompanionFixture,
  socket: string,
  view = "work",
  entity = "design",
) {
  const bootstrap = await page.request.get(companion.url);
  const capability = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(
    await bootstrap.text(),
  )?.[1];
  if (!capability) throw new Error("Missing capability");
  for (const [route, data] of [
    ["connections", { id: "local", label: "Visual qualification", socket }],
    ["connections/local/attach", { generation: "1" }],
  ] as const) {
    const result = await page.request.post(new URL(`/ui-api/v1/${route}`, companion.url).href, {
      headers: { "X-Workgraph-UI-Capability": capability, Origin: new URL(companion.url).origin },
      data,
    });
    expect(result.status()).toBe(200);
    await result.text();
  }
  await page.goto(
    new URL(
      `/#/${view}?connection=local&workspace=demo&project=release${entity ? `&entity=${entity}` : ""}`,
      companion.url,
    ).href,
  );
  await waitForPageReads(page);
  if (!(await page.locator(".wg-actor-trigger").isVisible()))
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill("fixture-author");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  const closeNavigation = page
    .getByRole("dialog", { name: "Workspace navigation", exact: true })
    .getByRole("button", { name: "Close navigation", exact: true });
  if (await closeNavigation.isVisible()) await closeNavigation.click();
  await waitForPageReads(page);
}
async function shot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const geometry = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    bodyWidth: document.body.scrollWidth,
    roots: document.querySelectorAll("#root").length,
  }));
  expect(geometry.roots).toBe(1);
  expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.width);
  const path = info.outputPath(name);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
  await info.attach(`${name}-geometry`, {
    body: JSON.stringify(geometry),
    contentType: "application/json",
  });
}

test("Title first and one Review preserve original writer and exact content until explicit Apply", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
}, info) => {
  await mount(page, companion, daemon.socket);
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create ticket", exact: true });
  await expect(dialog.getByLabel("Title", { exact: true })).toBeFocused();
  await expect(dialog.getByLabel("Ticket ID (optional)", { exact: true })).not.toBeVisible();
  await dialog.getByLabel("Title", { exact: true }).fill("Reviewed visual ticket");
  const description = "First 雪\nSecond\n";
  await dialog.getByLabel("Description", { exact: true }).fill(description);
  await dialog.getByText("Placement and optional ID", { exact: true }).click();
  await dialog.getByLabel("Ticket ID (optional)", { exact: true }).fill("visual-reviewed");
  await shot(page, info, "ticket-title-first.png");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/operations/"))
      requests.push(new URL(request.url()).pathname);
  });
  await dialog.getByRole("button", { name: "Review action", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply action", exact: true })).toBeEnabled();
  expect(requests.filter((path) => path.endsWith("/prepare"))).toHaveLength(1);
  expect(requests.some((path) => path.endsWith("/execute"))).toBe(false);
  await expect(
    daemon.call(
      "ticket.read",
      JSON.stringify({ workspace_id: "demo", ticket_id: "visual-reviewed", max_bytes: "1048576" }),
    ),
  ).rejects.toThrow(/"code":-32000.*"kind":"Not_found".*ticket not found: visual-reviewed/u);
  await expect(dialog.getByText("Original writer", { exact: false })).toContainText(
    "fixture-author",
  );
  await expect(dialog.getByText("Destination:", { exact: false })).toContainText("release");
  await dialog.getByRole("button", { name: "Hide editor; keep draft", exact: true }).click();
  browserDiagnostics.markPendingReads();
  await page.locator(".wg-actor-trigger").click();
  await page.getByLabel("Acting actor ID", { exact: true }).fill("shell-reader");
  await page.getByRole("button", { name: "Use selection", exact: true }).click();
  await page
    .getByLabel("Open editor", { exact: true })
    .selectOption({ label: "Create ticket · workspace" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("fixture-author");
  await dialog.getByRole("button", { name: "Apply action", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: /^committed$/u })).toBeVisible();
  const raw = await daemon.call(
    "ticket.read",
    JSON.stringify({ workspace_id: "demo", ticket_id: "visual-reviewed", max_bytes: "1048576" }),
  );
  // Fixed synthetic native envelope, never arbitrary resource/history content.
  const record = JSON.parse(raw) as {
    result: { data: { ticket: { title: string; description: string; project_id: string | null } } };
  };
  expect(record.result.data.ticket).toMatchObject({
    title: "Reviewed visual ticket",
    description,
    project_id: "release",
  });
  await expect(dialog.getByLabel("Content: Observed result", { exact: true })).toHaveCount(0);
  await expect(
    dialog.getByRole("link", { name: "Open created ticket", exact: true }),
  ).toBeVisible();
  await shot(page, info, "ticket-saved-original-writer.png");
  await dialog.getByText("Exact captured request", { exact: true }).click();
  const savedRequest = dialog.getByLabel("Content: Captured action JSON", { exact: true });
  await savedRequest.scrollIntoViewIfNeeded();
  await expect(savedRequest).toContainText(/"actor_id":\s*"fixture-author"/u);
  await expect(savedRequest).not.toContainText(/"actor_id":\s*"shell-reader"/u);
  await info.attach("exact-saved-request", {
    body: await savedRequest.innerText(),
    contentType: "text/plain",
  });
  browserDiagnostics.markPendingReads();
  await dialog.getByRole("link", { name: "Open created ticket", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/planning_kind=ticket/u);
  await expect(
    page.getByRole("heading", { name: "Reviewed visual ticket", exact: true }),
  ).toBeVisible();
});

test("narrow dialog keeps title and Review reachable, contains focus and restores its opener", async ({
  page,
  daemon,
  companion,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, companion, daemon.socket, "work", "");
  const trigger = page.getByRole("button", { name: "New ticket", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Create ticket", exact: true });
  await expect(dialog.getByLabel("Title", { exact: true })).toBeFocused();
  await dialog.getByLabel("Title", { exact: true }).fill("Keyboard review");
  await dialog.getByText("Placement and optional ID", { exact: true }).click();
  await dialog.locator(".wg-dialog-body").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(
    dialog.getByRole("button", { name: "Close Create ticket", exact: true }),
  ).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Review action", exact: true })).toBeInViewport();
  await shot(page, info, "ticket-narrow-scroll.png");
  const focusTrail: unknown[] = [];
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press("Tab");
    const observed = await dialog.evaluate((el) => ({
      contained: el.contains(document.activeElement),
      active: document.activeElement?.outerHTML.slice(0, 500),
      hasDocumentFocus: document.hasFocus(),
    }));
    focusTrail.push(observed);
    if (!observed.contained)
      await info.attach("escaped-focus-trail", {
        body: JSON.stringify(focusTrail, null, 2),
        contentType: "application/json",
      });
    expect(observed.contained).toBe(true);
  }
  await dialog.getByRole("button", { name: "Close Create ticket", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("Administration modal keeps its title and review reachable on desktop and narrow screens", async ({
  page,
  daemon,
  companion,
}, info) => {
  await mount(page, companion, daemon.socket, "work", "");
  const opener = page
    .getByRole("banner")
    .getByRole("button", { name: "Visual qualification", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Daemon connections", exact: true });
  await dialog
    .locator("summary")
    .filter({ hasText: /^Offline administration and journals$/u })
    .click();
  const admin = dialog.getByRole("region", { name: "Administration", exact: true });
  await admin.getByRole("button", { name: "Offline migration", exact: true }).click();
  await admin.getByRole("button", { name: "Migrate 0.6.2 workspace", exact: true }).click();
  await admin
    .getByLabel("Stopped 0.6.2 workspace source on companion host", { exact: true })
    .fill("/owned/source-not-submitted");
  await admin
    .getByLabel("Fresh destination on companion host", { exact: true })
    .fill("/owned/destination-not-submitted");
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await dialog.locator(".wg-dialog-body").evaluate((body) => {
      body.scrollTop = body.scrollHeight;
    });
    await expect(
      dialog.getByRole("heading", { name: "Daemon connections", exact: true }),
    ).toBeInViewport();
    await expect(
      dialog.getByRole("button", { name: "Close Daemon connections", exact: true }),
    ).toBeInViewport();
    await expect(
      admin.getByRole("button", { name: "Review and prepare action", exact: true }),
    ).toBeInViewport();
    const geometry = await dialog.locator(".wg-dialog-body").evaluate((body) => ({
      scrollHeight: body.scrollHeight,
      height: body.clientHeight,
      scrollTop: body.scrollTop,
    }));
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.height);
    expect(geometry.scrollTop).toBeGreaterThan(0);
    await info.attach(`administration-scroll-${viewport.width}`, {
      body: JSON.stringify(geometry),
      contentType: "application/json",
    });
    await shot(page, info, `administration-modal-${viewport.width}.png`);
    await dialog.getByRole("button", { name: "Close Daemon connections", exact: true }).focus();
    for (let index = 0; index < 18; index++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
        true,
      );
    }
    await dialog.getByRole("button", { name: "Close Daemon connections", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
});

test("graph leaves useful canvas space and Resource actions fit the viewport", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
}, info) => {
  await mount(page, companion, daemon.socket, "workflow", "");
  const canvas = page.getByLabel("Scrollable dependency canvas", { exact: true });
  await expect(canvas).toBeVisible();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("No canvas bounds");
  expect(bounds.y).toBeLessThan(450);
  expect(bounds.height).toBeGreaterThan(300);
  await shot(page, info, "workflow-content-first.png");
  browserDiagnostics.markPendingReads();
  await page.evaluate(() => {
    location.hash = "#/resources?connection=local&workspace=demo&project=release&entity=notes";
  });
  await expect(page.locator(".rs-reader .wg-rich-content")).toBeVisible();
  const upload = page.getByRole("button", { name: "Upload file", exact: true });
  await expect(upload).toBeInViewport();
  const box = await upload.boundingBox();
  if (!box) throw new Error("No upload bounds");
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  await shot(page, info, "resource-content-first.png");
});

test("Resources and active Saved views stay primary across themes, narrow layouts and 200 percent zoom emulation", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
}, info) => {
  test.setTimeout(120000);
  for (let index = 0; index < 35; index++)
    await daemon.call(
      "ticket.create",
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: `visual-busy-${index}`,
        ticket_id: `visual-busy-${index}`,
        project_id: "release",
        title:
          index === 0
            ? "Readable long Unicode work — 雪の日の immutable captured destination and original writer"
            : `Busy visual work ${index + 1}`,
      }),
    );
  await mount(page, companion, daemon.socket, "saved", "");
  await page.getByRole("button", { name: "New view", exact: true }).click();
  const inputStarted = await page.evaluate(() => performance.now());
  await page.getByLabel("Name", { exact: true }).fill("My working roadmap");
  await expect(page.getByRole("button", { name: "Activate view", exact: true })).toBeEnabled();
  const inputReady = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: "Activate view", exact: true }).evaluate((element) => {
    const trail: unknown[] = [];
    Object.defineProperty(window, "__accessibilityFocusTrail", {
      value: trail,
      configurable: true,
    });
    const active = () => document.activeElement?.outerHTML.slice(0, 250);
    for (const type of ["focusin", "focusout"])
      document.addEventListener(type, (event) =>
        trail.push({
          type,
          target: event.target instanceof HTMLElement ? event.target.outerHTML.slice(0, 250) : null,
          active: active(),
        }),
      );
    new MutationObserver(() =>
      trail.push({
        type: "button state",
        disabled: element.hasAttribute("disabled"),
        active: active(),
      }),
    ).observe(element, { attributes: true, attributeFilter: ["disabled"] });
  });
  const activationStarted = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: "Activate view", exact: true }).click();
  const working = page.getByLabel("Working view results", { exact: true });
  await expect(working).toContainText("Readable long Unicode work");
  try {
    await expect(working).toBeFocused();
  } finally {
    await info.attach("activation-focus-trail", {
      body: JSON.stringify(
        await page.evaluate(() => ({
          trail: (window as typeof window & { __accessibilityFocusTrail: unknown })
            .__accessibilityFocusTrail,
          active: document.activeElement?.outerHTML.slice(0, 350),
        })),
      ),
      contentType: "application/json",
    });
  }
  const activationRendered = await page.evaluate(() => performance.now());
  const nativeTickets = JSON.parse(
    await daemon.call(
      "ticket.list",
      JSON.stringify({
        workspace_id: "demo",
        project_id: "release",
        limit: "100",
        max_bytes: "1048576",
      }),
    ),
  ) as { result: { data: { items: readonly unknown[] } } };
  await info.attach("bounded-input-and-render-measurement", {
    body: JSON.stringify({
      workload:
        "Actual native captured project ticket page; 35 added long/ordinary-title tickets plus fixture seed",
      actualNativeRows: nativeTickets.result.data.items.length,
      inputFillAndValidationMs: inputReady - inputStarted,
      activationReadRenderAndFocusMs: activationRendered - activationStarted,
      renderedDomNodes: await page.evaluate(() => document.querySelectorAll("*").length),
      observation: "Single local workload, not a scalability or cross-platform benchmark",
    }),
    contentType: "application/json",
  });
  // Delay one real native source read, without replacing its response, then move focus deliberately.
  let releaseRead: () => void = () => {
    throw new Error("Read gate not initialized");
  };
  let readStarted: () => void = () => {
    throw new Error("Read signal not initialized");
  };
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const started = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  let held = false;
  const holdRead = async (route: import("@playwright/test").Route) => {
    if (!held && route.request().postData()?.includes('"method":"ticket.list"')) {
      held = true;
      readStarted();
      await readGate;
    }
    await route.continue();
  };
  await page.route("**/ui-api/v1/read", holdRead);
  try {
    await page.getByRole("button", { name: "Activate view", exact: true }).click();
    await started;
    const name = page.getByLabel("Name", { exact: true });
    await name.focus();
    releaseRead();
    await expect(page.getByRole("button", { name: "Activate view", exact: true })).toBeEnabled();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(name).toBeFocused();
    await expect(working).not.toBeFocused();
  } finally {
    releaseRead();
    await page.unroute("**/ui-api/v1/read", holdRead);
  }
  const builder = page
    .locator(".wg-panel")
    .filter({ has: page.getByRole("heading", { name: "View builder", exact: true }) });
  const workingBox = await working.boundingBox(),
    builderBox = await builder.boundingBox();
  if (!workingBox || !builderBox) throw new Error("Missing active result or retained builder");
  expect(workingBox.y).toBeLessThan(builderBox.y);
  await page.getByRole("button", { name: "Raw source", exact: true }).click();
  await page
    .getByLabel("Configuration source", { exact: true })
    .fill('{"config_version":1,"kind":"view"}');
  await expect(page.getByRole("button", { name: "Activate view", exact: true })).toBeDisabled();
  await expect(working).toContainText("Readable long Unicode work");
  await page.locator(".wg-content").evaluate((element) => {
    element.scrollTop = 0;
  });
  await shot(page, info, "saved-working-view-before-invalid-retained-builder.png");
  browserDiagnostics.markPendingReads();
  await page.evaluate(() => {
    location.hash = "#/resources?connection=local&workspace=demo&project=release&entity=notes";
  });
  const reader = page.getByRole("region", { name: "Resource content", exact: true });
  await expect(reader.locator(".wg-rich-content")).toBeVisible();
  for (const layout of [
    { width: 1440, height: 900, theme: "dark" },
    { width: 1280, height: 800, theme: "light" },
    { width: 1920, height: 1080, theme: "dark" },
    { width: 390, height: 844, theme: "light" },
  ] as const) {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.getByRole("button", { name: "Appearance settings", exact: true }).click();
    const appearance = page.getByRole("dialog", { name: "Appearance", exact: true });
    await appearance.getByLabel("Theme", { exact: true }).selectOption(layout.theme);
    await appearance.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator("main")).toHaveCount(1);
    if (layout.width < 850) {
      await expect(
        page.getByRole("complementary", { name: "Resource directory", exact: true }),
      ).not.toBeVisible();
      await page.getByRole("button", { name: "Browse resources", exact: true }).click();
      await expect(
        page.getByRole("complementary", { name: "Resource directory", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Hide resource list", exact: true }).click();
    }
    await page.locator(".wg-content").evaluate((element) => {
      element.scrollTop = 0;
    });
    if (layout.width < 850) {
      const geometry = await page.locator(".rs-heading").evaluate((heading) => {
        const hint = heading
          .querySelector(":scope > div:not(.wg-toolbar)")!
          .getBoundingClientRect();
        const toolbar = heading.querySelector(":scope > .wg-toolbar")!.getBoundingClientRect();
        const text = heading.querySelector(".wg-hint")!.getBoundingClientRect();
        return { hintHeight: hint.height, textHeight: text.height, gap: toolbar.top - text.bottom };
      });
      await info.attach("resource-narrow-heading-spacing", {
        body: JSON.stringify(geometry),
        contentType: "application/json",
      });
      expect(geometry.hintHeight).toBeLessThanOrEqual(geometry.textHeight + 2);
      expect(geometry.gap).toBeGreaterThanOrEqual(0);
      expect(geometry.gap).toBeLessThanOrEqual(20);
    }
    await shot(page, info, `resource-view-top-${layout.theme}-${layout.width}.png`);
    await reader.scrollIntoViewIfNeeded();
    await shot(page, info, `resource-${layout.theme}-${layout.width}.png`);
    const contrast = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const luminance = (hex: string) => {
        const value = hex.trim().slice(1);
        const expanded =
          value.length === 3 ? [...value].map((part) => part + part).join("") : value;
        const channels = [0, 2, 4]
          .map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
      };
      return ["--wg-text", "--wg-secondary", "--wg-muted", "--wg-danger"].flatMap((foreground) =>
        ["--wg-app", "--wg-panel"].map((background) => {
          const a = luminance(style.getPropertyValue(foreground)),
            b = luminance(style.getPropertyValue(background));
          return {
            foreground,
            background,
            ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          };
        }),
      );
    });
    await info.attach(`contrast-${layout.theme}-${layout.width}`, {
      body: JSON.stringify(contrast),
      contentType: "application/json",
    });
    for (const pair of contrast) expect(pair.ratio).toBeGreaterThanOrEqual(4.5);
  }
  // Chromium device metrics emulate browser zoom: 720 CSS pixels occupy a 1440-pixel surface.
  // This is explicitly emulated zoom, not a claim of driving the browser's native menu.
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 720,
      height: 450,
      deviceScaleFactor: 2,
      mobile: false,
    });
    expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
      true,
    );
    await reader.scrollIntoViewIfNeeded();
    await shot(page, info, "resource-200-percent-zoom-emulation.png");
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.detach();
  }
});

test("keyboard skip, inspector resize and focus visibility preserve the selected work", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mount(page, companion, daemon.socket);
  await expect(page.locator("main")).toHaveCount(1);
  const resize = page.getByRole("separator", { name: "Resize inspector", exact: true });
  await expect(resize).toBeVisible();
  await resize.focus();
  await page.keyboard.press("Home");
  expect(await resize.getAttribute("aria-valuenow")).toBe(
    await resize.getAttribute("aria-valuemin"),
  );
  await page.keyboard.press("ArrowLeft");
  expect(Number(await resize.getAttribute("aria-valuenow"))).toBe(
    Number(await resize.getAttribute("aria-valuemin")) + 16,
  );
  await page.keyboard.press("End");
  expect(await resize.getAttribute("aria-valuenow")).toBe(
    await resize.getAttribute("aria-valuemax"),
  );
  const outline = await resize.evaluate((element) => ({
    width: Number.parseFloat(getComputedStyle(element).outlineWidth),
    style: getComputedStyle(element).outlineStyle,
  }));
  expect(outline.width).toBeGreaterThanOrEqual(2);
  expect(outline.style).not.toBe("none");
  await page.keyboard.press("Home");
  const handle = await resize.boundingBox();
  if (!handle) throw new Error("Missing resize handle");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 20);
  await page.mouse.down();
  await page.mouse.move(handle.x - 80, handle.y + 20, { steps: 4 });
  await page.mouse.up();
  expect(Number(await resize.getAttribute("aria-valuenow"))).toBeGreaterThan(
    Number(await resize.getAttribute("aria-valuemin")),
  );
  await expect(page.locator(".wg-inspector-header")).toContainText(
    "Clarify the workflow and ownership rules",
  );
  await shot(page, info, "work-keyboard-pointer-resize.png");
  browserDiagnostics.markPendingReads();
  await resize.focus();
  await page.keyboard.press("Escape");
  await expect(resize).toHaveCount(0);
  const skip = page.getByRole("link", { name: "Skip to content", exact: true });
  await skip.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main", { name: "Work", exact: true })).toBeFocused();
});

test("History exposes readable content before provenance and reported usage before advanced controls", async ({
  page,
  daemon,
  companion,
}, info) => {
  const source =
    "# Readable captured history\n\nA retained **human message**.\n\n```ocaml\nlet exact = 42\n```\n雪\n";
  let serial = 0;
  const write = (method: string, params: object) =>
    daemon.call(
      method,
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: `visual-history-${++serial}`,
        ...params,
      }),
    );
  await write("session.create", {
    session_id: "visual-content",
    title: "Readable retained history",
  });
  await write("session.append", {
    session_id: "visual-content",
    events: [
      {
        client_id: "human-one",
        role: "assistant",
        kind: "message",
        phase: "recorded",
        payload: { kind: "inline", bytes_base64: Buffer.from(source).toString("base64") },
      },
    ],
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await mount(page, companion, daemon.socket, "history", "visual-content");
  const root = page.locator(".ht-root");
  await expect(root.getByLabel("Payload format", { exact: true })).toBeVisible();
  const control = root.locator("#history-event-1 > header > button[aria-expanded]");
  if ((await control.getAttribute("aria-expanded")) !== "true") await control.click();
  const payload = root.locator("#history-event-1 .ht-payload");
  await expect(payload.locator(".wg-rich-content")).toContainText("Readable captured history");
  await expect(payload.locator(".wg-rich-content code")).toContainText("let exact = 42");
  const position = await payload.boundingBox();
  if (!position) throw new Error("No loaded payload bounds");
  expect(position.y).toBeLessThan(600);
  await page.locator(".wg-content").evaluate((element) => {
    element.scrollTop = 0;
  });
  await shot(page, info, "history-readable-content-top-1440.png");
  await payload.getByRole("button", { name: "Source", exact: true }).click();
  await expect(payload.getByRole("button", { name: "Source", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => payload.locator(".wg-rich-content code").textContent()).toBe(source);
  await payload.getByRole("button", { name: "Raw bytes", exact: true }).click();
  await expect(payload.getByLabel("Raw byte window", { exact: true })).toBeVisible();
  await payload.getByText("Content options", { exact: true }).click();
  const downloadReady = page.waitForEvent("download");
  await payload.getByRole("button", { name: "Download source", exact: true }).click();
  const stream = await (await downloadReady).createReadStream(),
    chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const bytes: unknown = chunk;
    if (!(bytes instanceof Uint8Array)) throw new Error("Non-byte download chunk");
    chunks.push(Buffer.from(bytes));
  }
  expect(Buffer.concat(chunks).equals(Buffer.from(source))).toBe(true);
  await root
    .locator("summary")
    .filter({ hasText: /^Search and reported usage$/u })
    .click();
  await root.getByRole("button", { name: "Usage reports", exact: true }).click();
  const usage = root.getByRole("region", { name: "Reported usage", exact: true });
  await usage.getByRole("button", { name: "Rescan usage", exact: true }).click();
  await expect(usage).toContainText("No reported observations; consumption unknown.");
  await write("run.register", {
    target_run_id: "visual-zero-run",
    objective: "Explicit reported zero",
  });
  await write("usage.report", {
    usage_id: "visual-zero",
    reported_actor_id: "fixture-author",
    scope: { kind: "run", run_id: "visual-zero-run" },
    provenance: "Explicit caller-reported zero",
    timestamp: "Caller timestamp not supplied",
    tokens: "0",
    elapsed_ms: "0",
    metrics: [],
  });
  await usage.getByRole("button", { name: "Rescan usage", exact: true }).click();
  await expect(usage.locator(".ha-totals").first()).toContainText("0 reported tokens");
  await expect(usage.getByLabel("Group reported usage by", { exact: true })).not.toBeVisible();
  await usage.scrollIntoViewIfNeeded();
  await shot(page, info, "reported-usage-primary-values-1440.png");
});
