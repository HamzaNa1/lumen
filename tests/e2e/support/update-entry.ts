import type { EventEmitter } from "node:events";
import { chmodSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import type { NsisUpdater } from "../../../apps/desktop/node_modules/electron-updater";
import { AppUpdates, type UpdateSource } from "../../../apps/desktop/src/main/updates/AppUpdates";

const root = process.env.LUMEN_E2E_PROFILE;
const url = process.env.LUMEN_E2E_UPDATE_URL;
if (!root || !url) throw new Error("Missing updater fixture configuration");
app.setPath("userData", root);
app.setPath("cache", root);
process.on("exit", () => {
  if (process.env.LUMEN_COVERAGE_DIR)
    writeFileSync(
      join(process.env.LUMEN_COVERAGE_DIR, `${crypto.randomUUID()}.json`),
      JSON.stringify((globalThis as unknown as { __coverage__?: unknown }).__coverage__ ?? {}),
    );
});
const errors: string[] = [];
console.error = (...values: unknown[]) => {
  errors.push(values.map(String).join(" "));
};
process.on("unhandledRejection", (error) => {
  console.error(error);
  app.exit(1);
});
void app.whenReady().then(() => {
  void new BrowserWindow({ show: false }).loadURL(
    "data:text/html,<title>Update integration</title>",
  );
  const { NsisUpdater: Updater } = createRequire(process.env.LUMEN_E2E_DESKTOP_MANIFEST ?? "")(
    "electron-updater",
  ) as { NsisUpdater: typeof NsisUpdater };
  const updater = new Updater({ provider: "generic", url });
  updater.updateConfigPath = join(root, "update.yml");
  updater.forceDevUpdateConfig = true;
  updater.autoInstallOnAppQuit = false;
  updater.disableDifferentialDownload = true;
  (updater as unknown as EventEmitter).on("error", (error: Error) => errors.push(String(error)));
  updater.signals.updateDownloaded((event) => {
    if (process.platform !== "win32") chmodSync(event.downloadedFile, 0o700);
  });
  const notifications: string[] = [];
  const updates = new AppUpdates((version) => notifications.push(version), 1000);
  const stop = updates.start(updater as unknown as UpdateSource);
  Object.assign(globalThis, { updateHarness: { updates, errors, notifications, stop, updater } });
});
