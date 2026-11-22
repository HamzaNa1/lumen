import { createRequire } from "node:module";
import { join } from "node:path";
import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import type {} from "../../../apps/desktop/src/shared/bridge";
import { test as base, expect, password, repository, type Server } from "./server";

const require = createRequire(join(repository, "apps/desktop/package.json"));
const exits = new WeakMap<ElectronApplication, Promise<void>>();
const stderrLogs = new WeakMap<ElectronApplication, string[]>();
export const test = base.extend<{
  mpvFaults: boolean;
  desktopEnvironment: Record<string, string>;
  desktop: { app: ElectronApplication; page: Page; profile: string };
}>({
  mpvFaults: [false, { option: true }],
  desktopEnvironment: [{}, { option: true }],
  desktop: async ({ server, mpvFaults, desktopEnvironment }, use, testInfo) => {
    const profile = join(server.root, "desktop-profile");
    const app = await launchDesktop(profile, mpvFaults, desktopEnvironment);
    const child = app.process();
    const logs = stderrLogs.get(app) ?? [];
    stderrLogs.delete(app);
    try {
      const page = await mainDesktopPage(app);
      await expect(page.getByLabel("Server address")).toBeVisible();
      if (process.platform === "win32")
        await testInfo.attach("Electron GPU diagnostics", {
          body: JSON.stringify(
            await app.evaluate(async ({ app }) => ({
              features: app.getGPUFeatureStatus(),
              info: await app.getGPUInfo("complete"),
            })),
            null,
            2,
          ),
          contentType: "application/json",
        });
      try {
        await app.evaluate(({ app }) => app.focus({ steal: true }));
        await use({ app, page, profile });
      } finally {
        if (!page.isClosed())
          await testInfo.attach("desktop DOM", {
            body: await page.locator("body").innerText(),
            contentType: "text/plain",
          });
        // Playwright screenshots Electron windows only while closing them, which closeDesktop skips on Linux.
        if (process.platform === "linux" && testInfo.status !== testInfo.expectedStatus)
          for (const [index, window] of app.windows().entries()) {
            const path = testInfo.outputPath(`desktop-failed-${index + 1}.png`);
            await window
              .screenshot({ path, timeout: 5_000 })
              .then(() => testInfo.attach("screenshot", { path, contentType: "image/png" }))
              .catch(() => undefined);
          }
      }
    } finally {
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
        await closeDesktop(app);
      } finally {
        deadline.removeEventListener("abort", kill);
      }
      await testInfo.attach("electron log", { body: logs.join(""), contentType: "text/plain" });
      expect(forced, logs.join("\n")).toBe(false);
      expect(child.exitCode, logs.join("\n")).toBe(0);
    }
  },
});
export async function launchDesktop(
  profile: string,
  mpvFaults = false,
  extraEnvironment: Record<string, string> = {},
) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
    ),
  ) as Record<string, string>;
  const hostResolverRules = extraEnvironment.LUMEN_E2E_HOST_RESOLVER_RULES;
  const app = await _electron.launch({
    executablePath: require("electron") as string,
    args: [
      join(repository, "tests/e2e/support/electron-entry.mjs"),
      "--no-sandbox",
      ...(hostResolverRules === undefined ? [] : [`--host-resolver-rules=${hostResolverRules}`]),
      // Hosted Windows runners expose Microsoft Basic Render Driver. Exercise D3D11
      // sharing there; this is software-driver coverage, not physical-GPU evidence.
      ...(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
        ? ["--ignore-gpu-blocklist", "--use-angle=d3d11"]
        : []),
    ],
    cwd: join(repository, "apps/desktop"),
    env: {
      ...environment,
      LUMEN_E2E_PROFILE: profile,
      LUMEN_E2E_MPV_WIRE: mpvFaults ? "1" : "",
      LUMEN_E2E_SILENT_AUDIO: "1",
      LUMEN_E2E_DISCOVERY_PORT: "off",
      ...extraEnvironment,
    },
  });
  const logs: string[] = [];
  app.process().stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  stderrLogs.set(app, logs);
  exits.set(app, new Promise((resolve) => app.once("close", () => resolve())));
  return app;
}
export async function desktopPlayerPage(app: ElectronApplication): Promise<Page> {
  return app.windows().find((window) => window.url().includes("overlay=1")) ?? mainDesktopPage(app);
}
/**
 * On Linux, quits through `app.quit()` as `ElectronApplication.close()` does, without the screenshot
 * of every window Playwright takes first: there a window that never played has not painted, and each
 * screenshot waits out its 5 s timeout. Elsewhere it is `ElectronApplication.close()`.
 */
export async function closeDesktop(app: ElectronApplication): Promise<void> {
  const logs = stderrLogs.get(app);
  stderrLogs.delete(app);
  try {
    if (process.platform !== "linux") return await app.close();
    const exited = exits.get(app);
    if (exited === undefined) throw new Error("closeDesktop closes apps from launchDesktop");
    // Evaluating fails once the app has exited or is exiting; its close event still settles this.
    await app.evaluate(({ app }) => void setImmediate(() => app.quit())).catch(() => undefined);
    await exited;
  } finally {
    if (logs !== undefined && logs.length > 0)
      await test
        .info()
        .attach("electron log (reopened)", { body: logs.join(""), contentType: "text/plain" })
        .catch(() => undefined);
  }
}
export async function quitDesktop(app: ElectronApplication): Promise<void> {
  const child = app.process();
  await app.evaluate(({ app }, koffiModule) => {
    if (process.platform !== "darwin") {
      setImmediate(() => app.quit());
      return;
    }
    // Queue Cmd+Q as an AppKit event; calling app.quit() from JS misses native reentrancy.
    const koffi = process.getBuiltinModule("module").createRequire(koffiModule)(koffiModule);
    const objc = koffi.load("/usr/lib/libobjc.A.dylib");
    const getClass = objc.func("void *objc_getClass(const char *)");
    const selector = objc.func("void *sel_registerName(const char *)");
    const send = objc.func("void *objc_msgSend(void *, void *)");
    const string = objc.func("void *objc_msgSend(void *, void *, const char *)");
    const point = koffi.struct({ x: "double", y: "double" });
    const keyEvent = objc.func("objc_msgSend", "void *", [
      "void *",
      "void *",
      "ulong",
      point,
      "ulong",
      "double",
      "long",
      "void *",
      "void *",
      "void *",
      "bool",
      "ushort",
    ]);
    const post = objc.func("void objc_msgSend(void *, void *, void *, bool)");
    const application = send(getClass("NSApplication"), selector("sharedApplication"));
    const characters = string(getClass("NSString"), selector("stringWithUTF8String:"), "q");
    const event = keyEvent(
      getClass("NSEvent"),
      selector(
        "keyEventWithType:location:modifierFlags:timestamp:windowNumber:context:characters:charactersIgnoringModifiers:isARepeat:keyCode:",
      ),
      10,
      { x: 0, y: 0 },
      1 << 20,
      0,
      0,
      null,
      characters,
      characters,
      false,
      12,
    );
    post(application, selector("postEvent:atStart:"), event, false);
  }, require.resolve("koffi"));
  await expect.poll(() => child.exitCode).toBe(0);
}
export async function mainDesktopPage(app: ElectronApplication): Promise<Page> {
  let selected: Page | undefined;
  let windows: {
    id: number;
    parentId: number | null;
    url: string;
    visible: boolean;
  }[] = [];
  try {
    await expect
      .poll(
        async () => {
          windows = await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().map((window) => ({
              id: window.id,
              parentId: window.getParentWindow()?.id ?? null,
              url: window.webContents.getURL(),
              visible: window.isVisible(),
            })),
          );
          // The player overlay is a child window. Startup event order does not identify the app UI.
          const main = windows.filter(
            (window) =>
              window.parentId === null && window.url !== "" && window.url !== "about:blank",
          );
          selected =
            main.length === 1
              ? app.windows().find((page) => page.url() === main[0]?.url)
              : undefined;
          return { windows, mainPageFound: selected !== undefined };
        },
        { message: "The main Electron window must have a loaded renderer" },
      )
      .toMatchObject({ mainPageFound: true });
  } finally {
    await test.info().attach("desktop window selection", {
      body: JSON.stringify({ windows, selectedUrl: selected?.url() ?? null }, null, 2),
      contentType: "application/json",
    });
  }
  if (!selected) throw new Error("Main desktop window not found");
  return selected;
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
