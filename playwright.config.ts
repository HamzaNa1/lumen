import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.LUMEN_BROWSER_TEST_PORT ?? 3277);

// Browser smoke tests for the web app, run against a real server serving the production build.
// `bun run test:browser` builds the app first.
export default defineConfig({
  testDir: "tests/browser",
  testMatch: "*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 920 } },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 920 } } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 1440, height: 920 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 920 } } },
  ],
  webServer: {
    command: "bun tests/browser/serve.ts",
    url: `http://127.0.0.1:${port}/health/ready`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
