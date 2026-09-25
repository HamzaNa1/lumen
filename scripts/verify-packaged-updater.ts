import { listPackage } from "@electron/asar";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const index = process.argv.indexOf("--app-dir");
const directory = index < 0 ? null : process.argv[index + 1];
if (!directory) throw new Error("Usage: verify-packaged-updater.ts --app-dir <unpacked app directory>");
const resources = process.platform === "darwin"
  ? join(directory, "Lumen.app", "Contents", "Resources")
  : join(directory, "resources");
const configPath = join(resources, "app-update.yml");
const asarPath = join(resources, "app.asar");
if (!existsSync(configPath) || !existsSync(asarPath)) throw new Error("Packaged updater configuration or app.asar is missing");
const config = YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
if (config.provider !== "github" || config.owner !== "HamzaNa1" || config.repo !== "lumen" ||
    typeof config.updaterCacheDirName !== "string" || config.updaterCacheDirName.length === 0) {
  throw new Error("Packaged updater feed or cache identity is invalid");
}
if (process.platform === "win32") {
  const publishers = Array.isArray(config.publisherName) ? config.publisherName : [config.publisherName];
  if (publishers.length === 0 || publishers.some((name) => typeof name !== "string" || name.length === 0)) {
    throw new Error("Windows updater publisher metadata is missing");
  }
  const expected = process.env.WIN_PUBLISHER_NAME;
  if (expected && !publishers.some((name) => name.includes(expected))) {
    throw new Error("Windows updater publisher does not match the signing certificate");
  }
}
const entries = listPackage(asarPath, { isPack: false });
for (const module of ["electron-updater", "builder-util-runtime", "fs-extra", "semver", "lazy-val"]) {
  if (!entries.some((entry) => entry.includes(`node_modules/${module}/package.json`))) {
    throw new Error(`${module} is missing from the packaged app`);
  }
}
console.log(`Verified packaged updater: ${configPath}`);
