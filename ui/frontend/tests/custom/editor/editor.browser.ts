import { readFile } from "node:fs/promises";
import { test, expect } from "../../e2e/support/fixtures";
import { view, identifier } from "../config/fixtures";
import {
  editorActor,
  editorPanel,
  editorScreenshot,
  importConfigurations,
  mountEditor,
  nativeWriter,
  openConfiguration,
  reviewSharedPublication,
} from "./browser-fixtures";
import type { ConfigSource } from "../../../src/features/custom/config";
test.use({ viewport: { width: 1480, height: 1000 }, actionTimeout: 12000 });
test("Editor E01 actual builder focus, failed edits retain working view, private CAS and preferred export", async ({
  page,
  companion,
  daemon,
  browserFailures,
}, info) => {
  const write = nativeWriter(daemon);
  await write("ticket.create", {
    ticket_id: "custom-ticket",
    project_id: "release",
    title: "Visible working ticket",
  });
  await mountEditor(page, companion, daemon);
  await page.getByRole("button", { name: "New view", exact: true }).click();
  const name = page.getByLabel("Name", { exact: true });
  await name.fill("");
  await name.focus();
  for (const character of "My roadmap") {
    await name.pressSequentially(character);
    await expect(page.getByRole("button", { name: "Activate view", exact: true })).toBeEnabled();
    await expect(name).toBeFocused();
  }
  await page.getByRole("button", { name: "Activate view", exact: true }).click();
  await expect(
    editorPanel(page, "Working view").getByText("Visible working ticket", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save privately", exact: true }).click();
  await expect(
    page.getByText("Private settings saved at revision 1.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Raw source", exact: true }).click();
  await page
    .getByLabel("Configuration source", { exact: true })
    .fill('{"config_version":1,"kind":"view"}');
  await expect(page.getByRole("button", { name: "Activate view", exact: true })).toBeDisabled();
  await expect(
    editorPanel(page, "Working view").getByText("Visible working ticket", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close draft", exact: true }).click();
  await page
    .locator(".wg-custom-saved")
    .getByRole("button", { name: "Set preferred", exact: true })
    .click();
  await expect(page.getByText("Preferred", { exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export chosen target", exact: true }).click();
  await page.getByRole("link", { name: "Download portable settings", exact: true }).click();
  const file = await (await download).path();
  if (file === null) throw new Error("Missing export");
  const portable = JSON.parse(await readFile(file, "utf8")) as {
    settings_version: number;
    documents: { id: string; source: string }[];
    selected_id: string | null;
  };
  expect(Object.keys(portable).sort()).toEqual(["documents", "selected_id", "settings_version"]);
  expect(portable.documents).toHaveLength(1);
  expect(portable.selected_id).toBe(portable.documents[0]?.id);
  expect(portable.documents[0]?.source).toContain("My roadmap");
  await editorScreenshot(page, info, "working-view-private-preference");
  expect(browserFailures).toEqual([]);
});
test("Editor E02 all eight actual native sources mount through saved configurations", async ({
  page,
  companion,
  daemon,
  browserFailures,
}, info) => {
  const write = nativeWriter(daemon);
  await write("ticket.create", {
    ticket_id: "custom-ticket",
    project_id: "release",
    title: "Custom ticket",
  });
  await write("run.register", { target_run_id: "custom-run", objective: "Custom run" });
  const claim = JSON.parse(
    await write("ticket.claim", { ticket_id: "custom-ticket", run_id: "custom-run" }),
  ) as { result: { data: { token: string } } };
  await write("attempt.start", {
    attempt_id: "custom-attempt",
    target_run_id: "custom-run",
    run_id: "custom-run",
    ticket_id: "custom-ticket",
    token: claim.result.data.token,
  });
  await write("session.create", {
    session_id: "custom-session",
    title: "Custom session",
    scopes: [{ kind: "workspace" }],
  });
  await write("resource.put_text", {
    resource_id: "custom-resource",
    expected_revision: "0",
    title: "Custom resource",
    filename: "custom.json",
    mime_type: "application/json",
    text: '{"x":null}',
  });
  await write("resource.link", {
    resource_id: "custom-resource",
    expected_revision: "1",
    target: { kind: "workspace" },
  });
  await write("fact.put", {
    scope: { kind: "workspace" },
    key: "Custom.key",
    expected_revision: "0",
    value: { x: null },
  });
  await write("board.put", {
    board_id: "custom-board",
    expected_revision: "0",
    title: "Custom board",
    scope: { kind: "workspace" },
  });
  await write("thread.put", {
    thread_id: "custom-thread",
    expected_revision: "0",
    board_id: "custom-board",
    title: "Custom discussion",
    participants: [],
    mentions: [],
    state: "open",
  });
  await mountEditor(page, companion, daemon);
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
  await importConfigurations(
    page,
    sources.map((source) => ({
      id: `view-${source}`,
      source: JSON.stringify(
        view(source, { id: identifier(`view-${source}`), title: `Native ${source}` }),
      ),
    })),
  );
  for (const source of sources) {
    await openConfiguration(page, `view-${source}`);
    await expect(page.getByRole("button", { name: "Activate view", exact: true })).toBeEnabled();
    const response = page.waitForResponse(
      (response) => response.url().endsWith("/read") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Activate view", exact: true }).click();
    await (await response).finished();
    const working = editorPanel(page, "Working view");
    await expect(working.locator(".wg-custom-presentation")).toHaveAttribute(
      "aria-label",
      `Native ${source}`,
    );
    await expect(working.getByText(/matching \/ [1-9][0-9]* captured rows/u)).toBeVisible();
    await expect(
      working.getByText("Field completeness not established", { exact: false }),
    ).toHaveCount(["runs", "attempts", "sessions", "activity"].includes(source) ? 1 : 0);
    await page.getByRole("button", { name: "Close draft", exact: true }).click();
  }
  await editorScreenshot(page, info, "eight-native-source-working-view");
  expect(browserFailures).toEqual([]);
});
test("Editor E05 actual stale shared-index guard rolls back resources and keeps the working view", async ({
  page,
  daemon,
  companion,
  browserFailures,
  browserDiagnostics,
}, info) => {
  const write = nativeWriter(daemon);
  await write("ticket.create", {
    ticket_id: "rollback-ticket",
    project_id: "release",
    title: "Still working after rejected publication",
  });
  const api = await mountEditor(page, companion, daemon);
  await page.getByRole("button", { name: "New view", exact: true }).click();
  await expect(page.getByRole("button", { name: "Activate view", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Activate view", exact: true }).click();
  await expect(
    editorPanel(page, "Working view").getByText("Still working after rejected publication", {
      exact: true,
    }),
  ).toBeVisible();
  await editorActor(page);
  await page.getByText("Share through guarded resources and catalog", { exact: true }).click();
  await page.getByLabel("Configuration resource ID", { exact: true }).fill("rollback-config");
  await page.getByLabel("Catalog resource ID", { exact: true }).fill("rollback-catalog");
  await reviewSharedPublication(
    page,
    companion,
    browserDiagnostics,
    ["rollback-config", "rollback-catalog"],
    info,
  );
  const captured = editorPanel(page, "Captured shared publication");
  await expect(
    captured.getByRole("button", { name: "Execute saved request", exact: true }),
  ).toBeEnabled();
  await write("fact.put", {
    scope: { kind: "workspace" },
    key: "ui.config.index",
    expected_revision: "0",
    value: { external: "newer index" },
  });
  await captured.getByRole("button", { name: "Execute saved request", exact: true }).click();
  await expect(captured.getByRole("status").filter({ hasText: /^rejected$/u })).toBeVisible();
  await expect(captured.getByText(/Conflict/u)).toBeVisible();
  const resources = JSON.parse(
    await daemon.call(
      "resource.list",
      JSON.stringify({
        workspace_id: "demo",
        target: { kind: "workspace" },
        include_archived: true,
        max_bytes: "1048576",
        limit: "100",
      }),
    ),
  ) as { result: { data: { items: { resource_id: string }[] } } };
  expect(resources.result.data.items.map((item) => item.resource_id)).not.toContain(
    "rollback-config",
  );
  expect(resources.result.data.items.map((item) => item.resource_id)).not.toContain(
    "rollback-catalog",
  );
  await expect(
    editorPanel(page, "Working view").getByText("Still working after rejected publication", {
      exact: true,
    }),
  ).toBeVisible();
  for (const resourceId of ["rollback-config", "rollback-catalog"]) {
    const absent = await api.request("/read", {
      connection_id: "local",
      generation: "1",
      method: "resource.get",
      lane: "visible",
      params: { workspace_id: "demo", resource_id: resourceId },
    });
    expect(absent.status()).toBe(404);
    const body = (await absent.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe("Not_found");
  }
  await editorScreenshot(page, info, "guarded-publication-conflict-working-view");
  expect(browserFailures).toEqual([]);
});
