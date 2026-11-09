import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const output = process.env.WORKGRAPH_CONTENT_EVIDENCE;
if (!output || !path.isAbsolute(output)) throw new Error("Set absolute WORKGRAPH_CONTENT_EVIDENCE");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.WORKGRAPH_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  acceptDownloads: true,
});
const page = await context.newPage();
const errors: string[] = [];
const external: string[] = [];
const workers: string[] = [];
page.on("pageerror", (error) => {
  errors.push(error.message);
});
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("worker", (worker) => {
  workers.push(worker.url());
});
page.on("request", (request) => {
  if (!request.url().startsWith("http://127.0.0.1:8772/")) external.push(request.url());
});
await page.route("**/tests/content/fixture.html", async (route) => {
  const response = await route.fetch();
  await route.fulfill({
    response,
    headers: {
      ...response.headers(),
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; worker-src 'self'; connect-src 'self'; img-src 'self' blob:; font-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'",
    },
  });
});
await page.addInitScript(() => {
  let pending: (() => void) | null = null;
  globalThis.addEventListener("unhandledrejection", () => {
    sessionStorage.setItem("qualification-unhandled", "true");
  });
  globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.data === "qualification-copy-settle") {
      pending?.();
      pending = null;
    }
  });
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: (text: string) => {
        sessionStorage.setItem("qualification-copy", text);
        const mode = sessionStorage.getItem("qualification-copy-mode");
        if (mode === "denied")
          return Promise.reject(new DOMException("Qualification denied", "NotAllowedError"));
        if (mode === "unexpected")
          return Promise.reject(new Error("Qualification unexpected clipboard failure"));
        if (mode === "defer-success" || mode === "defer-denied" || mode === "defer-unexpected") {
          sessionStorage.setItem("qualification-copy-pending", "true");
          sessionStorage.removeItem("qualification-copy-settled");
          return new Promise<void>((resolve, reject) => {
            pending = () => {
              sessionStorage.setItem("qualification-copy-settled", "true");
              sessionStorage.removeItem("qualification-copy-pending");
              if (mode === "defer-denied")
                reject(new DOMException("Qualification denied", "NotAllowedError"));
              else if (mode === "defer-unexpected")
                reject(new Error("Qualification stale clipboard failure"));
              else resolve();
            };
          });
        }
        return Promise.resolve();
      },
    },
  });
});
const passed: string[] = [];
try {
  await page.goto("http://127.0.0.1:8772/tests/content/fixture.html");
  const viewer = page.locator(".wg-content-viewer");
  await expect(viewer.getByRole("heading", { name: "Northstar release notes" })).toBeVisible();
  await expect(viewer.locator("table tbody tr")).toHaveCount(2);
  await expect(viewer.locator(".wg-syntax-keyword").first()).toBeVisible();
  await expect(viewer).toContainText("& λ");
  await expect(viewer.locator("li").first()).toHaveText("[x] Preserve immutable source");
  await expect(viewer.locator(".wg-content-warning")).toHaveCount(0);
  await expect(viewer.locator("a, img, iframe, object, script, [href], [src]")).toHaveCount(0);
  passed.push(
    "Built local worker renders GFM tables, entities, OCaml tokens and passive reference under CSP",
  );
  await page.screenshot({ path: path.join(output, "content-dark.png"), fullPage: true });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.screenshot({ path: path.join(output, "content-light.png"), fullPage: true });
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await viewer.getByLabel("Language override").selectOption("plain");
  await expect(viewer.getByRole("heading", { name: "Northstar release notes" })).toHaveCount(0);
  await expect(viewer).toContainText("# Northstar release notes");
  await viewer.getByLabel("Language override").selectOption("auto");
  await expect(viewer.getByRole("heading", { name: "Northstar release notes" })).toBeVisible();
  await viewer.getByRole("button", { name: "Source", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(viewer.locator(".wg-code-block code").first()).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(viewer.getByRole("button", { name: "Raw bytes", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(viewer).toContainText("00000000");
  await viewer.getByRole("button", { name: "Rendered", exact: true }).click();
  passed.push(
    "Per-view plain/auto override and keyboard Enter/Tab Source/Raw/Rendered switches preserve capture",
  );
  await page.getByLabel("Synthetic capture").selectOption("hostile");
  await expect(viewer.getByRole("heading", { name: "Passive, by construction" })).toBeVisible();
  await expect(viewer).toContainText("<script>globalThis.__contentExploit = true</script>");
  await expect(viewer).toContainText("<script>entity text</script>");
  await expect(viewer).toContainText("jav&#x61;script:alert(1)");
  await expect(viewer).toContainText("&amp; <b>literal code</b>");
  await expect(viewer.locator("a, img, iframe, object, script, [href], [src]")).toHaveCount(0);
  expect(await page.evaluate(() => "__contentExploit" in globalThis)).toBe(false);
  await page.screenshot({ path: path.join(output, "content-passive.png"), fullPage: true });
  passed.push(
    "Literal HTML, entity-encoded script/URL, remote image and unknown fence remain passive with zero external requests",
  );
  await page.getByLabel("Synthetic capture").selectOption("exact");
  await expect(viewer.getByRole("heading", { name: "Exact source" })).toBeVisible();
  const exact =
    '\uFEFF# Exact source\r\n&amp; &#955;\r\n```json\r\n{"large":9007199254740993}\r\n```\r\n';
  await viewer.getByRole("button", { name: "Copy source", exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("qualification-copy"))).toBe(exact);
  const downloadPromise = page.waitForEvent("download");
  await viewer.getByRole("button", { name: "Download source", exact: true }).click();
  const download = await downloadPromise;
  const destination = path.join(output, "exact-source.txt");
  await download.saveAs(destination);
  const downloaded = await readFile(destination);
  expect(downloaded.equals(Buffer.from(exact))).toBe(true);
  passed.push(
    `Exact source clipboard-call preserves BOM/CRLF/entities; actual byte download SHA256 ${createHash("sha256").update(downloaded).digest("hex")}`,
  );
  await page.getByLabel("Synthetic capture").selectOption("large");
  await expect(viewer).toContainText("Rich preview exceeds");
  await expect(viewer.locator(".wg-source-window li")).toHaveCount(200);
  await expect(viewer.getByRole("button", { name: "Copy source", exact: true })).toBeDisabled();
  await viewer.getByRole("button", { name: "Next lines" }).click();
  await expect(viewer).toContainText("line 201");
  await page.getByLabel("Synthetic capture").selectOption("long");
  await viewer.getByLabel("Language override").selectOption("plain");
  await expect(viewer.locator(".wg-source-window")).toBeVisible();
  await expect(viewer).toContainText("omitted");
  passed.push(
    "Rich input budget selects bounded 200-line source; long line omission and next-window navigation visible",
  );
  await page.getByLabel("Synthetic capture").selectOption("binary");
  await expect(viewer).toContainText("00000000");
  await expect(viewer).toContainText("ff 00 50 44 46");
  await page.getByLabel("Synthetic capture").selectOption("partial");
  await expect(viewer).toContainText("Partial content");
  await expect(viewer.getByRole("button", { name: "Download loaded bytes" })).toBeVisible();
  await expect(viewer).toContainText("do not imply the full resource");
  await expect(viewer).toContainText("let incomplete =");
  passed.push(
    "Binary bytes use hex; truncated/unclosed code fence stays passive; partial captures label loaded-byte rendering/download honestly",
  );
  await page.getByLabel("Synthetic capture").selectOption("nested");
  await viewer.getByLabel("Language override").selectOption("auto");
  await expect(viewer).toContainText("nesting preview budget");
  await expect(viewer.locator(".wg-source-window li")).toHaveCount(3);
  await expect(viewer.getByRole("button", { name: "Copy source", exact: true })).toBeEnabled();
  passed.push(
    "Combined Markdown/highlight depth overflow falls back to bounded source before wire admission, no protocol failure",
  );
  await page.getByRole("button", { name: "Decode JSON in worker" }).click();
  await expect(page.getByLabel("Worker qualification result")).toHaveText(
    '{"large":9007199254740993,"negative":-0,"exponent":1e999}',
  );
  await page.getByRole("button", { name: "Cancel worker job" }).click();
  await expect(page.getByLabel("Worker qualification result")).toHaveText("cancelled");
  const before = Number(await page.getByLabel("Main thread heartbeat").textContent());
  await page.getByRole("button", { name: "Exercise phase deadline" }).click();
  await expect(page.getByLabel("Worker qualification result")).toHaveText("timeout");
  const after = Number(await page.getByLabel("Main thread heartbeat").textContent());
  expect(after).toBeGreaterThan(before);
  await page.getByRole("button", { name: "Decode JSON in worker" }).click();
  await expect(page.getByLabel("Worker qualification result")).toContainText("9007199254740993");
  passed.push(
    `Lossless worker JSON, active cancellation, actual blocked-worker deadline and responsive main thread (${after - before} heartbeat ticks), subsequent job succeeds`,
  );
  await viewer.getByLabel("Language override").selectOption("auto");
  for (const choice of ["markdown", "hostile", "large", "exact", "markdown"])
    await page.getByLabel("Synthetic capture").selectOption(choice);
  await expect(viewer.getByRole("heading", { name: "Northstar release notes" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, "content-mobile.png"), fullPage: true });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth),
  ).toBe(true);
  passed.push(
    "Rapid capture replacement ignores late jobs; 390px layout wraps without page overflow",
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => {
    sessionStorage.setItem("qualification-copy-mode", "denied");
  });
  await viewer.getByRole("button", { name: "Copy source", exact: true }).click();
  await expect(viewer).toContainText("Clipboard permission was denied.");
  await page.getByLabel("Synthetic capture").selectOption("hostile");
  await expect(viewer.getByRole("heading", { name: "Passive, by construction" })).toBeVisible();
  await expect(viewer).not.toContainText("Clipboard permission was denied.");
  for (const mode of ["defer-success", "defer-denied", "defer-unexpected"]) {
    await page.getByLabel("Synthetic capture").selectOption("markdown");
    await expect(viewer.getByRole("heading", { name: "Northstar release notes" })).toBeVisible();
    await page.evaluate((value) => {
      sessionStorage.setItem("qualification-copy-mode", value);
    }, mode);
    await viewer.getByRole("button", { name: "Copy source", exact: true }).click();
    expect(await page.evaluate(() => sessionStorage.getItem("qualification-copy-pending"))).toBe(
      "true",
    );
    await page.getByLabel("Synthetic capture").selectOption("hostile");
    await expect(viewer.getByRole("heading", { name: "Passive, by construction" })).toBeVisible();
    // Return to the same immutable source before settlement: old owner identity alone is insufficient.
    await page.getByLabel("Synthetic capture").selectOption("markdown");
    await expect(viewer.getByRole("heading", { name: "Northstar release notes" })).toBeVisible();
    await page.evaluate(() => {
      globalThis.postMessage("qualification-copy-settle", "*");
    });
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem("qualification-copy-settled")))
      .toBe("true");
    await expect(viewer.locator(".wg-content-notice")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Fixture caught unexpected content failure" }),
    ).toHaveCount(0);
  }
  passed.push(
    "Source-copy permission notices reset on capture change; late success/denial/unexpected rejection ignored across A→B→A selection",
  );
  await page.evaluate(() => {
    sessionStorage.setItem("qualification-copy-mode", "success");
  });
  await viewer.getByRole("button", { name: "Copy code block" }).click();
  await expect(viewer).toContainText("Code block copied");
  await page.getByLabel("Synthetic capture").selectOption("hostile");
  await expect(viewer.getByRole("heading", { name: "Passive, by construction" })).toBeVisible();
  await expect(viewer).not.toContainText("Code block copied");
  await page.evaluate(() => {
    sessionStorage.setItem("qualification-copy-mode", "denied");
  });
  await viewer.getByRole("button", { name: "Copy code block" }).click();
  await expect(viewer).toContainText("Clipboard permission was denied.");
  await page.getByLabel("Synthetic capture").selectOption("markdown");
  await expect(viewer.getByRole("heading", { name: "Northstar release notes" })).toBeVisible();
  await expect(viewer).not.toContainText("Clipboard permission was denied.");
  for (const control of ["Copy source", "Copy code block"]) {
    await page.evaluate(() => {
      sessionStorage.setItem("qualification-copy-mode", "unexpected");
      sessionStorage.removeItem("qualification-boundary");
    });
    await viewer.getByRole("button", { name: control, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Fixture caught unexpected content failure" }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(
      "Qualification unexpected clipboard failure",
    );
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem("qualification-boundary")))
      .toBe("Qualification unexpected clipboard failure");
    await page.getByRole("button", { name: "Reset content boundary" }).click();
    await expect(viewer.getByRole("heading", { name: "Northstar release notes" })).toBeVisible();
  }
  expect(await page.evaluate(() => sessionStorage.getItem("qualification-unhandled"))).toBe(null);
  passed.push(
    "Code-copy feedback resets; unexpected source/code copy rejections reach owned React error boundary, zero unhandled rejections, explicit reset recovers",
  );
  await page.getByLabel("Synthetic capture").selectOption("structured");
  await expect(viewer.locator(".wg-code-block code")).toContainText("Ticket 4999", {
    timeout: 20000,
  });
  await expect(viewer.locator(".wg-content-warning")).toHaveCount(0);
  await page.setViewportSize({ width: 1600, height: 2000 });
  await page.getByRole("button", { name: "Toggle content burst", exact: true }).click();
  await expect(page.locator(".fixture-burst .wg-rich-content")).toHaveCount(40, { timeout: 20000 });
  await expect(page.locator(".fixture-burst .wg-state-error")).toHaveCount(0);
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.getByRole("button", { name: "Toggle content burst", exact: true }).click();
  await page.getByRole("button", { name: "Toggle content burst", exact: true }).click();
  const lastBlock = page.locator(".fixture-burst .wg-content-viewer").last();
  await lastBlock.scrollIntoViewIfNeeded();
  await expect(lastBlock.locator(".wg-rich-content")).toContainText("Visible block 40");
  await expect(page.locator(".fixture-burst .wg-state-error")).toHaveCount(0);
  passed.push(
    "5000-record JSON highlights completely; 40 viewers drain without refresh, offscreen content resumes on scroll",
  );
  expect(workers.some((url) => /\/assets\/content.worker-.*\.js$/u.test(url))).toBe(true);
  expect(workers.some((url) => /\/assets\/stall.worker-.*\.js$/u.test(url))).toBe(true);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  await writeFile(
    path.join(output, "browser-report.json"),
    JSON.stringify({ passed, workers: [...new Set(workers)], external, errors }, null, 2) + "\n",
  );
} finally {
  await browser.close();
}
