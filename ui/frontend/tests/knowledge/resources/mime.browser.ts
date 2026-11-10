import { writeFile } from "node:fs/promises";
import { test, expect } from "../../e2e/support/fixtures";
import { waitForPageReads } from "../../e2e/support/readiness";

test("generic CLI upload renders Markdown and metadata corrections update the same publication", async ({
  page,
  daemon,
  companion,
  browserDiagnostics,
}) => {
  const file = `${daemon.root}/notes.md`;
  await writeFile(file, "# Uploaded reference\n\nReadable **Markdown**.\n");
  await daemon.call(
    "resource.upload",
    JSON.stringify({
      workspace_id: "demo",
      actor_id: "fixture-author",
      mutation_id: "mime-upload",
      resource_id: "mime-notes",
      expected_revision: "0",
      title: "Uploaded reference",
      file,
    }),
  );
  const stored = JSON.parse(
    await daemon.call(
      "resource.get",
      JSON.stringify({ workspace_id: "demo", resource_id: "mime-notes" }),
    ),
  ) as { result: { data: { metadata: { mime_type: string } } } };
  expect(stored.result.data.metadata.mime_type).toBe("application/octet-stream");
  const html = await (await page.request.get(companion.url)).text();
  const capability = html.match(/<meta name="workgraph-capability" content="([a-f0-9]{64})"/u)?.[1];
  if (!capability) throw new Error("Missing capability");
  const origin = new URL(companion.url).origin;
  const response = await page.request.post(`${origin}/ui-api/v1/connections`, {
    headers: { Origin: origin, "X-Workgraph-UI-Capability": capability },
    data: { id: "local", label: "Resource MIME test", socket: daemon.socket },
  });
  expect(response.status()).toBe(200);
  await page.goto(`${origin}/#/resources?connection=local&workspace=demo&entity=mime-notes`);
  const viewer = page.getByRole("region", { name: "Content: notes.md · content v1", exact: true });
  await expect(
    viewer.getByRole("heading", { name: "Uploaded reference", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".wg-live-indicator")).toHaveText("Live");
  await waitForPageReads(page);
  let contentReads = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/read") &&
      (request.postDataJSON() as { method?: string }).method === "resource.read_chunk"
    )
      contentReads++;
  });
  await daemon.call(
    "resource.update",
    JSON.stringify({
      workspace_id: "demo",
      actor_id: "fixture-author",
      mutation_id: "mime-binary",
      resource_id: "mime-notes",
      expected_revision: "1",
      mime_type: "application/pdf",
    }),
  );
  await expect(
    viewer.getByText("Binary content is not rendered as prose. Raw bytes remain available.", {
      exact: true,
    }),
  ).toBeVisible();
  await daemon.call(
    "resource.update",
    JSON.stringify({
      workspace_id: "demo",
      actor_id: "fixture-author",
      mutation_id: "mime-correct",
      resource_id: "mime-notes",
      expected_revision: "2",
      mime_type: "text/markdown",
    }),
  );
  await expect(
    viewer.getByRole("heading", { name: "Uploaded reference", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".rs-document-kind")).toHaveText("text/markdown");
  await waitForPageReads(page);
  expect(contentReads).toBe(0);
  browserDiagnostics.markPendingReads();
});
