import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import base from "../../../frontend/playwright.config";

export default {
  ...base,
  testDir: dirname(fileURLToPath(import.meta.url)),
  testMatch: ["*.browser.ts"],
};
