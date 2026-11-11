import { defineConfig } from "@playwright/test";

// bun run --cwd apps/desktop build && bunx playwright test -c benchmarks/next-episode
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "*.bench.ts",
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../../test-results/benchmarks/next-episode",
  use: { browserName: "chromium" },
});
