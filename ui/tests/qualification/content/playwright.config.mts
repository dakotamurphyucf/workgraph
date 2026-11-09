import { createRequire } from "node:module";
import type * as Playwright from "../../../frontend/node_modules/@playwright/test/index.js";
const { defineConfig, devices } = createRequire(
  new URL("../../../frontend/package.json", import.meta.url),
)("@playwright/test") as typeof Playwright;
export default defineConfig({
  testDir: ".",
  testMatch: "*.browser.ts",
  retries: 0,
  workers: 1,
  forbidOnly: true,
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(process.env.WORKGRAPH_UI_BROWSER_EXECUTABLE === undefined
      ? {}
      : {
          launchOptions: {
            executablePath: process.env.WORKGRAPH_UI_BROWSER_EXECUTABLE,
          },
        }),
  },
});
