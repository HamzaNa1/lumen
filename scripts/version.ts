import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const [command, version] = process.argv.slice(2);

const validVersion = (value: string | undefined): value is string => {
  if (value === undefined) return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (match === null) return false;
  return match[4]?.split(".").every((part) => !/^0\d+$/.test(part)) ?? true;
};

const readManifest = (path: string): { version?: string; workspaces?: string[] } =>
  JSON.parse(readFileSync(join(root, path), "utf8")) as { version?: string; workspaces?: string[] };

const workspaceManifests = (): string[] => {
  const patterns = readManifest("package.json").workspaces ?? [];
  const files = ["package.json"];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) throw new Error(`Unsupported workspace pattern: ${pattern}`);
    const base = pattern.slice(0, -2);
    for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(base, entry.name, "package.json");
      if (existsSync(join(root, path))) files.push(path);
    }
  }
  return files.sort();
};

if ((command !== "set" && command !== "check") || !validVersion(version)) {
  throw new Error("Usage: bun run version:set <major.minor.patch[-prerelease]> or bun run version:check <version>");
}

const files = workspaceManifests();
if (command === "set") {
  for (const file of files) {
    const path = join(root, file);
    const source = readFileSync(path, "utf8");
    if (readManifest(file).version === undefined) throw new Error(`${file} has no version`);
    const updated = source.replace(/("version"\s*:\s*")[^"]+/, (_, prefix: string) => `${prefix}${version}`);
    if (updated === source && readManifest(file).version !== version) throw new Error(`Could not update ${file}`);
    writeFileSync(path, updated);
  }
  const install = spawnSync(process.execPath, ["install", "--lockfile-only"], { cwd: root, stdio: "inherit" });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

for (const file of files) {
  const actual = readManifest(file).version;
  if (actual !== version) throw new Error(`${file} is ${actual ?? "unversioned"}; expected ${version}`);
}

const install = spawnSync(process.execPath, ["install", "--frozen-lockfile", "--dry-run"], { cwd: root, encoding: "utf8" });
if (install.status !== 0) {
  process.stderr.write(install.stderr || install.stdout || "Lockfile check failed\n");
  process.exit(install.status ?? 1);
}
console.log(`Verified ${version} in ${files.length} package manifests and bun.lock`);
