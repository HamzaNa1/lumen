import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.LUMEN_BROWSER_TEST_PORT ?? 3277);
const baseURL = (offset: number) => `http://127.0.0.1:${port + offset}`;

// Browser smoke tests for the web app, run against a real server serving the production build.
// `bun run test:browser` builds the app first.
export default defineConfig({
  testDir: "tests/browser",
  testMatch: "*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
    ["junit", { outputFile: "test-results/junit.xml" }],
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
  ],
  webServer: ["mp4", "webm"].map((format, offset) => ({
    command: "bun tests/browser/serve.ts",
    env: { LUMEN_BROWSER_TEST_PORT: String(port + offset), LUMEN_BROWSER_TEST_MEDIA: format },
    url: `${baseURL(offset)}/health/ready`,
    reuseExistingServer: false,
    timeout: 30_000,
  })),
});
