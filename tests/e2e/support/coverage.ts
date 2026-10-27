import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext } from "@playwright/test";

declare global {
  interface Window {
    __coverage__?: unknown;
    __saveE2ECoverage?: (value: unknown) => Promise<void>;
  }
}
export async function collectBrowserCoverage(context: BrowserContext) {
  const directory = process.env.LUMEN_COVERAGE_DIR;
  if (!directory) return async () => {};
  const writes = new Set<Promise<void>>();
  const save = (payload: unknown) => {
    if (!payload) return;
    const pending = writeFile(
      join(directory, `${crypto.randomUUID()}.json`),
      JSON.stringify(payload),
    );
    writes.add(pending);
    void pending.finally(() => writes.delete(pending));
    return pending;
  };
  await context.exposeBinding("__saveE2ECoverage", (_source, payload: unknown) => save(payload));
  await context.addInitScript(() =>
    window.addEventListener("pagehide", () => {
      void window.__saveE2ECoverage?.(window.__coverage__);
    }),
  );
  return async () => {
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      await save(await page.evaluate(() => window.__coverage__));
    }
    await Promise.all(writes);
  };
}
