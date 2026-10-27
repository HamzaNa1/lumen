import { chmodSync } from "node:fs";
import { delimiter, join } from "node:path";
import { bunExecutable, expect, test } from "./support/cli";

test("release notes use real git ranges and GitHub attribution, deduplicate PRs, isolate products and fail closed", async ({
  workspace,
}) => {
  workspace.git("tag", "server-v0.0.7");
  const initial = workspace.git("rev-parse", "HEAD");
  const commit = (path: string, title: string) => {
    workspace.write(path, title);
    workspace.git("add", path);
    workspace.git("commit", "-m", title);
    return workspace.git("rev-parse", "HEAD");
  };
  const first = commit("apps/server/src/one.ts", "First half");
  const second = commit("apps/server/src/two.ts", "Second half");
  const desktop = commit("apps/desktop/src/change.ts", "Desktop only");
  const shared = commit("packages/contracts/src/change.ts", "Shared contract");
  const direct = commit("apps/server/src/direct.ts", "Direct <fix>");
  const revision = direct;
  workspace.git("switch", "-c", "future");
  const future = commit("apps/server/src/future.ts", "Unreleased");
  workspace.git("switch", "main");
  const pr = (number: number, sha: string, user: string) => ({
    number,
    title: `Change ${number}`,
    merged_at: "2026-01-01",
    merge_commit_sha: sha,
    user: { login: user },
    base: { repo: { full_name: "owner/lumen" } },
  });
  workspace.write("github.json", {
    [first]: [pr(1, second, "alice")],
    [second]: [pr(1, second, "alice")],
    [desktop]: [pr(2, desktop, "bob")],
    [shared]: [pr(3, shared, "carol")],
    [direct]: [
      { ...pr(4, direct, "open"), merged_at: null },
      pr(5, initial, "old"),
      pr(6, future, "future"),
      { ...pr(7, direct, "foreign"), base: { repo: { full_name: "other/repo" } } },
    ],
  });
  workspace.write(
    "bin/gh",
    `#!${bunExecutable()}
if (process.env.GITHUB_FAILURE === "1") { console.error("GitHub unavailable"); process.exit(1); }
const endpoint = process.argv[3];
const sha = endpoint.split("/commits/")[1]?.split("/")[0];
const state = await Bun.file("github.json").json();
console.log(JSON.stringify(endpoint.includes("/pulls") ? [state[sha] ?? []] : {author: {login: "dana"}}));
`,
  );
  chmodSync(join(workspace.root, "bin/gh"), 0o755);
  const env = {
    PATH: `${join(workspace.root, "bin")}${delimiter}${process.env.PATH}`,
    GH_REPO: "owner/lumen",
    GITHUB_SHA: revision,
    SERVER_IMAGE: "ghcr.io/owner/lumen",
    SERVER_DIGEST: "sha256:test",
  };
  const notes = (product: string, previous = "server-v0.0.7", extra = {}) =>
    workspace.script("release", ["notes", product, "0.0.8", previous], { ...env, ...extra });
  const server = notes("server");
  expect(server.status, server.stderr).toBe(0);
  expect(server.stdout.match(/\/pull\/1/g)).toHaveLength(1);
  expect(server.stdout).toContain("@alice, @carol, @dana");
  expect(server.stdout).toContain("Direct \\<fix\\>");
  expect(server.stdout).toContain("compare/server-v0.0.7...v0.0.8%2Bserver");
  expect(server.stdout).toContain("ghcr.io/owner/lumen@sha256:test");
  for (const number of [2, 4, 5, 6, 7]) expect(server.stdout).not.toContain(`/pull/${number}`);
  const client = notes("desktop");
  expect(client.status, client.stderr).toBe(0);
  expect(client.stdout).toContain("@bob, @carol");
  expect(client.stdout).not.toContain("@alice");
  expect(notes("server", "").stdout).toContain("commits/v0.0.8%2Bserver");
  expect(notes("server", revision, { GITHUB_FAILURE: "1" }).stdout).toContain(
    "No component changes",
  );
  expect(notes("server", "server-v0.0.7", { GITHUB_FAILURE: "1" }).status).not.toBe(0);
});
