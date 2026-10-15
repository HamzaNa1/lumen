import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

import { parseProduct } from "./scripts/lib/products";
import { productBrowserTests, verifyTestOwnership } from "./scripts/lib/verification";

const selected = process.env.LUMEN_BROWSER_PRODUCT;
const product =
  selected === undefined || selected === "source" ? undefined : parseProduct(selected);
verifyTestOwnership(fileURLToPath(new URL(".", import.meta.url)));

const port = Number(process.env.LUMEN_BROWSER_TEST_PORT ?? 3277);

// Browser smoke tests for the web app, run against a real server serving the production build.
// `bun run test:browser` builds the app first.
export default defineConfig({
  testDir: "tests/browser",
  testMatch: product === undefined ? "*.e2e.ts" : productBrowserTests(product),
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 920 } },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 920 } },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], viewport: { width: 1440, height: 920 } },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 920 } },
    },
  ].filter((project) => product !== "desktop" || project.name === "chromium"),
  webServer: {
    command: "bun tests/browser/serve.ts",
    url: `http://127.0.0.1:${port}/health/ready`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
