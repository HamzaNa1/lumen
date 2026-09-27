import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isReleaseVersion,
  parseProduct,
  products,
  repositoryRoot,
  run,
  type Product,
} from "./lib/releases";

export const verifyVersion = (product: Product, version: string, root = repositoryRoot): void => {
  if (!isReleaseVersion(version)) throw new Error(`Invalid release version: ${version}`);
  const file = products[product].manifest;
  const actual = JSON.parse(readFileSync(join(root, file), "utf8")).version;
  if (actual !== version)
    throw new Error(`${file} is ${actual ?? "unversioned"}; expected ${version}`);
  const lockfile = Bun.JSONC.parse(readFileSync(join(root, "bun.lock"), "utf8")) as {
    workspaces?: Record<string, { version?: string }>;
  };
  const locked = lockfile.workspaces?.[`apps/${product}`]?.version;
  if (locked !== version)
    throw new Error(`bun.lock has ${product} ${locked ?? "unversioned"}; expected ${version}`);
  run(process.execPath, ["install", "--frozen-lockfile", "--dry-run"], root);
};

export const setVersion = (product: Product, version: string, root = repositoryRoot): void => {
  if (!isReleaseVersion(version)) throw new Error(`Invalid release version: ${version}`);
  const file = products[product].manifest;
  const versionFiles = [file, "bun.lock"];
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--", ":(glob)**/package.json", "bun.lock", "bunfig.toml"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (dirty.trim() !== "")
    throw new Error(
      "Commit or stash package manifests, bun.lock, and bunfig.toml before setting a release version.",
    );
  const path = join(root, file);
  const source = readFileSync(path, "utf8");
  const current = JSON.parse(source).version;
  if (!isReleaseVersion(current)) throw new Error(`${file} has no valid version`);
  if (current === version) throw new Error(`${file} is already ${version}`);
  verifyVersion(product, current, root);
  writeFileSync(
    path,
    source.replace(/("version"\s*:\s*")[^"]+/, (_, prefix: string) => `${prefix}${version}`),
  );
  run(process.execPath, ["install", "--lockfile-only"], root);
  verifyVersion(product, version, root);
  run("git", ["add", "--", ...versionFiles], root);
  run(
    "git",
    ["commit", "--only", "-m", `chore: release ${product} ${version}`, "--", ...versionFiles],
    root,
  );
};

if (import.meta.main) {
  const [command, target, version, ...extra] = process.argv.slice(2);
  if (
    (command !== "set" && command !== "check") ||
    !isReleaseVersion(version) ||
    extra.length !== 0
  ) {
    throw new Error(
      "Usage: bun run version:set <server|desktop> <version> or bun run version:check <server|desktop> <version>",
    );
  }
  const product = parseProduct(target);
  if (command === "set") setVersion(product, version);
  else verifyVersion(product, version);
  console.log(`Verified ${product} ${version} and bun.lock`);
}
