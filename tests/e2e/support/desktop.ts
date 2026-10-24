import { createRequire } from "node:module";
import { join } from "node:path";
import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import type {} from "../../../apps/desktop/src/shared/bridge";
import { collectBrowserCoverage } from "./coverage";
import { test as base, expect, password, repository, type Server } from "./server";

const require = createRequire(join(repository, "apps/desktop/package.json"));
export const test = base.extend<{
  desktop: { app: ElectronApplication; page: Page; profile: string };
}>({
  desktop: async ({ server }, use, testInfo) => {
    const profile = join(server.root, "desktop-profile");
    const app = await launchDesktop(profile);
    const child = app.process();
    const flush = await collectBrowserCoverage(app.context());
    const logs: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
    try {
      await expect
        .poll(
          async () =>
            Promise.all(
              app.windows().map(async (page) => ({
                url: page.url(),
                text: await page.locator("body").innerText(),
              })),
            ),
          { message: "Desktop windows must show the connection form" },
        )
        .toContainEqual(
          expect.objectContaining({ text: expect.stringContaining("Server address") }),
        );
      const pages = app.windows();
      const page =
        pages[
          (
            await Promise.all(pages.map((page) => page.getByLabel("Server address").count()))
          ).findIndex((count) => count > 0)
        ];
      if (!page) throw new Error("Main desktop window not found");
      try {
        await app.evaluate(({ app }) => app.focus({ steal: true }));
        await use({ app, page, profile });
      } finally {
        if (!page.isClosed())
          await testInfo.attach("desktop DOM", {
            body: await page.locator("body").innerText(),
            contentType: "text/plain",
          });
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) await flush();
      const deadline = AbortSignal.timeout(30_000);
      let forced = false;
      const kill = () => {
        forced = true;
        child.kill("SIGKILL");
      };
      deadline.addEventListener("abort", kill, { once: true });
      try {
        // A server release exercises the already-released desktop's protocol, not its quit policy.
        // Older releases leave a nonclosable BaseWindow host after playback; clean that fixture up.
        if (process.env.LUMEN_BROWSER_PRODUCT === "server" && child.exitCode === null)
          await app.evaluate(({ BaseWindow, BrowserWindow }) => {
            for (const window of BaseWindow.getAllWindows())
              if (!(window instanceof BrowserWindow)) window.destroy();
          });
        await app.close();
      } finally {
        deadline.removeEventListener("abort", kill);
      }
      await testInfo.attach("electron log", { body: logs.join(""), contentType: "text/plain" });
      expect(forced, logs.join("\n")).toBe(false);
      expect(child.exitCode, logs.join("\n")).toBe(0);
    }
  },
});
export async function launchDesktop(profile: string) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
    ),
  ) as Record<string, string>;
  return _electron.launch({
    executablePath: require("electron") as string,
    args: [join(repository, "tests/e2e/support/electron-entry.mjs"), "--no-sandbox"],
    cwd: join(repository, "apps/desktop"),
    env: { ...environment, LUMEN_E2E_PROFILE: profile },
  });
}
export async function connectDesktop(
  page: Page,
  server: Pick<Server, "origin">,
  username = "admin",
) {
  await page.getByLabel("Server address").fill(server.origin);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
}
export { expect } from "./server";
