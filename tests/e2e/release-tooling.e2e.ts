import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./support/cli";

test("release version CLI commits only the selected manifest and lock, preserving staged work", async ({
  workspace,
}) => {
  workspace.write("unrelated.txt", "keep staged");
  workspace.git("add", "unrelated.txt");
  expect(workspace.script("version", ["set", "server", "0.0.8"]).status).toBe(0);
  expect(workspace.git("show", "--format=", "--name-only", "HEAD").split("\n")).toEqual([
    "apps/server/package.json",
    "bun.lock",
  ]);
  expect(workspace.git("diff", "--cached", "--name-only")).toBe("unrelated.txt");
  expect(workspace.script("version", ["check", "desktop", "0.0.7"]).status).toBe(0);
  expect(workspace.script("version", ["set", "desktop", "0.0.9-rc.1"]).status).toBe(0);
  expect(workspace.git("log", "-1", "--format=%s")).toBe("chore: release desktop 0.0.9-rc.1");
  expect(
    JSON.parse(readFileSync(join(workspace.root, "apps/server/package.json"), "utf8")).version,
  ).toBe("0.0.8");
});

for (const version of ["1", "01.0.0", "1.0.0-01", "1.0.0+metadata", "../bad", "1.0.0;echo bad", ""])
  test(`release CLI rejects unsafe or noncanonical version ${JSON.stringify(version)}`, async ({
    workspace,
  }) => {
    const head = workspace.git("rev-parse", "HEAD");
    expect(workspace.script("version", ["set", "server", version]).status).not.toBe(0);
    expect(workspace.git("rev-parse", "HEAD")).toBe(head);
    expect(workspace.git("status", "--porcelain")).toBe("");
  });

for (const target of ["apps/server/package.json", "apps/desktop/package.json", "bunfig.toml"])
  test(`release CLI rejects dirty ${target} without changing the lockfile`, async ({
    workspace,
  }) => {
    const lock = readFileSync(join(workspace.root, "bun.lock"), "utf8");
    const head = workspace.git("rev-parse", "HEAD");
    workspace.write(
      target,
      target.endsWith("json")
        ? { name: "changed", private: true, version: "0.0.9" }
        : "[install]\nexact = true\n",
    );
    const result = workspace.script("version", ["set", "server", "0.0.8"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Commit or stash");
    expect(readFileSync(join(workspace.root, "bun.lock"), "utf8")).toBe(lock);
    expect(workspace.git("rev-parse", "HEAD")).toBe(head);
  });

test("version check rejects mismatched manifests and stale dependency locks", async ({
  workspace,
}) => {
  expect(workspace.script("version", ["check", "server", "0.0.8"]).status).not.toBe(0);
  workspace.write("apps/server/package.json", {
    name: "apps-server",
    private: true,
    version: "0.0.8",
  });
  expect(workspace.script("version", ["check", "server", "0.0.8"]).status).not.toBe(0);
});

test("release preflight uses real remote tags, independent product history and same-branch safeguards", async ({
  workspace,
}) => {
  const remote = join(workspace.root, "origin.git");
  workspace.run("git", ["init", "--bare", remote]);
  workspace.git("remote", "add", "origin", remote);
  for (const tag of ["v0.0.5", "v0.0.6+server", "v9.0.0+desktop", "v0.0.8-rc.1+server"])
    workspace.git("tag", tag);
  workspace.git("push", "origin", "--tags");
  const output = join(workspace.root, "output");
  const env = { GITHUB_REF: "refs/heads/main", DEFAULT_BRANCH: "main", GITHUB_OUTPUT: output };
  expect(workspace.script("release", ["preflight", "server", "0.0.7"], env).status).toBe(0);
  expect(readFileSync(output, "utf8")).toContain("previous-tag=v0.0.6+server");
  expect(
    workspace.script("release", ["preflight", "server", "0.0.7"], {
      ...env,
      GITHUB_REF: "refs/heads/other",
    }).status,
  ).not.toBe(0);
  workspace.git("tag", "v0.0.7+server");
  workspace.git("push", "origin", "--tags");
  expect(workspace.script("release", ["preflight", "server", "0.0.7"], env).status).not.toBe(0);
  expect(workspace.script("release", ["promotion-check", "server", "0.0.5"], env).status).not.toBe(
    0,
  );
});
