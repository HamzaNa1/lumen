import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setVersion, verifyVersion } from "../../scripts/version";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "lumen-version-test-"));
  directories.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (path: string, value: unknown) =>
    writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
  write("package.json", {
    name: "release-test",
    version: "0.0.7",
    private: true,
    workspaces: ["apps/*", "packages/*"],
  });
  for (const directory of ["apps/server", "apps/desktop", "packages/contracts"]) {
    mkdirSync(join(root, directory), { recursive: true });
    write(`${directory}/package.json`, {
      name: directory.replace("/", "-"),
      version: "0.0.7",
      private: true,
    });
  }
  execFileSync(process.execPath, ["install", "--lockfile-only"], { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", join(root, "no-hooks"));
  git("add", "package.json", "apps", "packages", "bun.lock");
  git("commit", "-qm", "Initial fixture");
  const version = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")).version;
  return { root, git, write, version };
};

test("setting one app version commits only its manifest and lockfile", () => {
  const { root, git, version } = fixture();
  writeFileSync(join(root, "unrelated.txt"), "Keep this staged\n");
  git("add", "unrelated.txt");
  setVersion("server", "0.0.8", root);
  expect(version("apps/server/package.json")).toBe("0.0.8");
  for (const path of [
    "package.json",
    "apps/desktop/package.json",
    "packages/contracts/package.json",
  ])
    expect(version(path)).toBe("0.0.7");
  expect(git("show", "--format=", "--name-only", "HEAD").split("\n")).toEqual([
    "apps/server/package.json",
    "bun.lock",
  ]);
  expect(git("diff", "--cached", "--name-only")).toBe("unrelated.txt");
  verifyVersion("desktop", "0.0.7", root);
  setVersion("desktop", "0.0.9-rc.1", root);
  expect(version("apps/server/package.json")).toBe("0.0.8");
  expect(version("apps/desktop/package.json")).toBe("0.0.9-rc.1");
  expect(git("log", "-1", "--format=%s")).toBe("chore: release desktop 0.0.9-rc.1");
});

test("rejects an invalid version or a dirty manifest without committing changes", () => {
  const { root, git, write, version } = fixture();
  const head = git("rev-parse", "HEAD");
  expect(() => setVersion("server", "1.0.0-01", root)).toThrow("Invalid release version");
  write("apps/server/package.json", {
    name: "apps-server",
    version: "0.0.7",
    description: "Uncommitted work",
  });
  expect(() => setVersion("server", "0.0.8", root)).toThrow("Commit or stash");
  expect(version("apps/server/package.json")).toBe("0.0.7");
  expect(git("rev-parse", "HEAD")).toBe(head);
});

test("checks the selected manifest and rejects a stale lockfile", () => {
  const { root, write } = fixture();
  expect(() => verifyVersion("server", "0.0.8", root)).toThrow("expected 0.0.8");
  write("apps/server/package.json", { name: "apps-server", version: "0.0.8", private: true });
  expect(() => verifyVersion("server", "0.0.8", root)).toThrow();
});

test("does not fold another app's uncommitted dependency changes into the lockfile", () => {
  const { root, git, write, version } = fixture();
  const head = git("rev-parse", "HEAD");
  const lockfile = readFileSync(join(root, "bun.lock"), "utf8");
  write("apps/desktop/package.json", { name: "apps-desktop", version: "0.0.9", private: true });
  expect(() => setVersion("server", "0.0.8", root)).toThrow("Commit or stash");
  expect(version("apps/server/package.json")).toBe("0.0.7");
  expect(readFileSync(join(root, "bun.lock"), "utf8")).toBe(lockfile);
  expect(git("rev-parse", "HEAD")).toBe(head);
});
