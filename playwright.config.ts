import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

import { parseProduct } from "./scripts/lib/products";
import { productBrowserTests, verifyTestOwnership } from "./scripts/lib/verification";

const selected = process.env.LUMEN_BROWSER_PRODUCT;
const product =
  selected === undefined || selected === "source" ? undefined : parseProduct(selected);
const repository = fileURLToPath(new URL(".", import.meta.url));
verifyTestOwnership(repository);
const artifactRoot = process.env.LUMEN_BROWSER_ARTIFACT_ROOT ?? repository;
const output = join(artifactRoot, "test-results", product ?? "source");

const port = Number(process.env.LUMEN_BROWSER_TEST_PORT ?? 3277);
const baseURL = (offset: number) => `http://127.0.0.1:${port + offset}`;

// Browser smoke tests for the web app, run against a real server serving the production build.
// `bun run test:browser` builds the app first.
export default defineConfig({
  testDir: "tests/browser",
  testMatch: product === undefined ? "*.e2e.ts" : productBrowserTests(product),
  outputDir: output,
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [
    ["list"],
    [
      "html",
      { outputFolder: join(artifactRoot, "playwright-report", product ?? "source"), open: "never" },
    ],
    ["json", { outputFile: join(output, "results.json") }],
    ["junit", { outputFile: join(output, "junit.xml") }],
  ],
  use: {
    baseURL: baseURL(0),
    viewport: { width: 1440, height: 920 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      metadata: { playback: "H.264/AAC" },
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 920 } },
    },
    {
      name: "firefox",
      metadata: { playback: "VP8/Vorbis" },
      use: {
        ...devices["Desktop Firefox"],
        baseURL: baseURL(1),
        viewport: { width: 1440, height: 920 },
      },
    },
    {
      name: "webkit",
      metadata: { playback: "VP8/Vorbis" },
      use: {
        ...devices["Desktop Safari"],
        baseURL: baseURL(1),
        viewport: { width: 1440, height: 920 },
      },
    },
  ].filter((project) => product !== "desktop" || project.name === "chromium"),
  webServer: (product === "desktop" ? ["mp4"] : ["mp4", "webm"]).map((format, offset) => ({
    command: "bun tests/browser/serve.ts",
    env: { LUMEN_BROWSER_TEST_PORT: String(port + offset), LUMEN_BROWSER_TEST_MEDIA: format },
    url: `${baseURL(offset)}/health/ready`,
    reuseExistingServer: false,
    timeout: 30_000,
  })),
});
