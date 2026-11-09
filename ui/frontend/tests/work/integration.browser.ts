import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, expect } from "../e2e/support/fixtures";

test.use({ colorScheme: "dark", viewport: { width: 1480, height: 900 } });

for (const view of ["work", "workflow"] as const) {
  test(`${view} evidence opens the exact published resource after a newer publication`, async ({
    page,
    daemon,
    companion,
    browserFailures,
  }, info) => {
    let serial = 0;
    const write = (method: string, params: object) =>
      daemon.call(
        method,
        JSON.stringify({
          workspace_id: "demo",
          actor_id: "fixture-author",
          run_id: "integration-run",
          mutation_id: `work-integration-${++serial}`,
          ...params,
        }),
      );
    await daemon.call(
      "run.register",
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "fixture-author",
        target_run_id: "integration-run",
        mutation_id: "register-integration-run",
        objective: "Synthetic Work navigation qualification",
      }),
    );
    await write("ticket.create", {
      ticket_id: "integration-proof",
      project_id: "release",
      title: "Inspect immutable evidence",
    });
    await write("ticket.start", {
      ticket_id: "integration-proof",
      attempt_id: "integration-attempt",
    });
    const original = "# Original evidence\n\nThe exact reviewed bytes.\n";
    const schema = "{}";
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    for (const [id, text] of [
      ["integration-evidence", original],
      ["integration-schema", schema],
    ] as const) {
      await write("resource.put_text", {
        resource_id: id,
        expected_revision: "0",
        title: id,
        filename: id === "integration-evidence" ? "evidence.md" : "schema.json",
        mime_type: id === "integration-evidence" ? "text/markdown" : "application/json",
        text,
      });
    }
    await write("contract.put", {
      contract_id: "integration-contract",
      expected_revision: "0",
      schema_version: "1",
      schema: { resource_id: "integration-schema", revision: "1", digest: digest(schema) },
      required_inputs: [],
      required_outputs: ["report"],
    });
    await write("manifest.publish", {
      manifest_id: "integration-manifest",
      expected_revision: "0",
      schema_version: "1",
      attempt_id: "integration-attempt",
      ticket_id: "integration-proof",
      contract: { contract_id: "integration-contract", revision: "1" },
      inputs: [],
      outputs: [
        {
          name: "report",
          pin: {
            kind: "resource",
            resource_id: "integration-evidence",
            revision: "1",
            digest: digest(original),
          },
        },
      ],
    });
    await write("resource.put_text", {
      resource_id: "integration-evidence",
      expected_revision: "1",
      title: "Newer unreviewed evidence",
      filename: "newer.md",
      mime_type: "text/markdown",
      text: "# Newer content\n\nThis must not replace the pinned evidence.\n",
    });
    const response = await page.request.get(companion.url);
    const capability = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(
      await response.text(),
    )?.[1];
    if (capability === undefined) throw new Error("Missing native bootstrap capability");
    for (const [path, data] of [
      ["/connections", { id: "local", label: "Work integration", socket: daemon.socket }],
      ["/connections/local/attach", { generation: "1" }],
    ] as const) {
      const result = await page.request.post(new URL(`/ui-api/v1${path}`, companion.url).href, {
        headers: {
          Origin: new URL(companion.url).origin,
          "X-Workgraph-UI-Capability": capability,
        },
        data,
      });
      expect(result.status()).toBe(200);
      await result.text();
    }
    await page.goto(
      new URL(
        `/#/${view}?connection=local&workspace=demo&project=release&entity=integration-proof`,
        companion.url,
      ).href,
    );
    if (view === "work") {
      await page.getByRole("button", { name: "Conversation", exact: true }).click();
      await page.getByRole("button", { name: "Load evidence context", exact: true }).click();
      await page.getByRole("button", { name: "Open exact evidence version", exact: true }).click();
    } else {
      const evidence = page.getByRole("region", { name: "Review and evidence", exact: true });
      await expect(
        evidence.getByRole("heading", { name: "Review & evidence", exact: true }),
      ).toBeVisible();
      await evidence
        .getByRole("button", { name: "Open exact resource version", exact: true })
        .click();
    }
    await expect(page).toHaveURL(/entity=integration-evidence/u);
    await expect(page).toHaveURL(/content_version=1/u);
    await expect(page).toHaveURL(/resource_generation=1/u);
    await expect(page).toHaveURL(new RegExp(`content_digest=${digest(original)}`, "u"));
    const viewer = page.getByRole("region", {
      name: "Content: evidence.md · content v1",
      exact: true,
    });
    await expect(
      viewer.getByRole("heading", { name: "Original evidence", exact: true }),
    ).toBeVisible();
    await expect(viewer).not.toContainText("This must not replace the pinned evidence");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download verified file", exact: true }).click();
    const file = await (await download).path();
    if (file === null) throw new Error("Verified resource download was unavailable");
    const bytes = await readFile(file);
    expect(bytes.toString("utf8")).toBe(original);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest(original));
    const screenshot = info.outputPath(`${view}-exact-resource-evidence.png`);
    await page.screenshot({ path: screenshot });
    await info.attach(`${view}-exact-resource-evidence`, {
      path: screenshot,
      contentType: "image/png",
    });
    expect(browserFailures).toEqual([]);
  });
}
