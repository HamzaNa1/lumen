import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { parseProduct } from "./scripts/lib/products";
import {
  parseChangedProducts,
  parseShard,
  selectedSuites,
  shardSuites,
  verifyTestOwnership,
} from "./scripts/lib/verification";

const repository = import.meta.dirname;
verifyTestOwnership(repository);
const selected = process.env.LUMEN_BROWSER_PRODUCT;
const product =
  selected === undefined || selected === "source" ? undefined : parseProduct(selected);
const artifacts = process.env.LUMEN_BROWSER_ARTIFACT_ROOT ?? repository;
const output = join(artifacts, "test-results", product ?? "source");
const changed = parseChangedProducts(process.env.LUMEN_E2E_CHANGED_PRODUCTS);
const shard = parseShard(process.env.LUMEN_E2E_SHARD);
const suites = (project: string, runtime: Parameters<typeof selectedSuites>[0]) =>
  shardSuites(project, selectedSuites(runtime, product, changed), shard);
const portable = [
  { name: "api", testMatch: suites("api", "api") },
  { name: "tooling", testMatch: suites("tooling", "tooling") },
  ...["chromium", "firefox", "webkit"].map((name) => ({
    name,
    testMatch: suites(name, "browser"),
    use: {
      ...devices[
        name === "chromium"
          ? "Desktop Chrome"
          : name === "firefox"
            ? "Desktop Firefox"
            : "Desktop Safari"
      ],
      ...(name === "firefox" && process.env.LUMEN_FIREFOX_EXECUTABLE
        ? { launchOptions: { executablePath: process.env.LUMEN_FIREFOX_EXECUTABLE } }
        : {}),
    },
  })),
].filter((project) => project.testMatch.length > 0);
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.LUMEN_E2E_WORKERS ? Number(process.env.LUMEN_E2E_WORKERS) : 2,
  forbidOnly: true,
  retries: 0,
  outputDir: output,
  reporter: [
    ["list"],
    [
      "html",
      { outputFolder: join(artifacts, "playwright-report", product ?? "source"), open: "never" },
    ],
    ["json", { outputFile: join(output, "results.json") }],
    ["junit", { outputFile: join(output, "junit.xml") }],
  ],
  use: {
    actionTimeout: 10000,
    viewport: { width: 1440, height: 920 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    ...portable,
    {
      name: "native",
      testMatch: suites("native", "native"),
      workers: 1,
      dependencies: portable.map((project) => project.name),
      use: { browserName: "chromium" },
    },
  ],
});
