import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateReleaseNotes, type ReleaseNotesGitHub } from "../../scripts/lib/release-notes";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "lumen-release-notes-"));
  directories.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Local Author");
  git("config", "user.email", "author@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", join(root, "no-hooks"));
  const commit = (path: string, subject: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `${subject}\n`);
    git("add", "--", path);
    git("commit", "-qm", subject);
    return git("rev-parse", "HEAD");
  };
  const initial = commit("README.md", "Initial release");
  git("tag", "server-v0.0.9");
  const pulls = new Map<string, ReturnType<ReleaseNotesGitHub["pullRequests"]>>();
  const authors = new Map<string, string>();
  const github: ReleaseNotesGitHub = {
    pullRequests: (sha) => pulls.get(sha) ?? [],
    commitAuthor: (sha) => authors.get(sha) ?? null,
  };
  const options = () => ({
    product: "server" as const,
    version: "0.0.10",
    previousTag: "server-v0.0.9",
    revision: git("rev-parse", "HEAD"),
    repository: "owner/lumen",
    root,
  });
  return { git, commit, initial, pulls, authors, github, options };
};

const pullRequest = (number: number, mergeCommit: string, title: string, author: string) => ({
  number,
  title,
  merged_at: "2026-09-27T12:00:00Z",
  merge_commit_sha: mergeCommit,
  user: { login: author },
  base: { repo: { full_name: "owner/lumen" } },
});

test("release notes include only the product's PRs, shared changes, contributors, and full comparison", () => {
  const { commit, pulls, authors, github, options } = fixture();
  const server = commit("apps/server/src/example.ts", "Server change");
  pulls.set(server, [pullRequest(1, server, "Fix server scanning", "alice")]);
  const desktop = commit("apps/desktop/src/example.ts", "Desktop change");
  pulls.set(desktop, [pullRequest(2, desktop, "Fix desktop playback", "bob")]);
  const shared = commit("packages/contracts/src/example.ts", "Shared change");
  pulls.set(shared, [pullRequest(3, shared, "Extend shared API", "carol")]);
  const direct = commit("apps/server/src/direct.ts", "Fix direct server change");
  authors.set(direct, "dana");

  const serverNotes = generateReleaseNotes(options(), github);
  expect(serverNotes).toContain(
    "* Fix server scanning by @alice in https://github.com/owner/lumen/pull/1",
  );
  expect(serverNotes).toContain(
    "* Extend shared API by @carol in https://github.com/owner/lumen/pull/3",
  );
  expect(serverNotes).toContain(
    `* Fix direct server change by @dana in [${direct.slice(0, 7)}](https://github.com/owner/lumen/commit/${direct})`,
  );
  expect(serverNotes).toContain("## Contributors\n@alice, @carol, @dana");
  expect(serverNotes).toContain(
    "**Full Changelog**: https://github.com/owner/lumen/compare/server-v0.0.9...v0.0.10%2Bserver",
  );
  expect(serverNotes).not.toContain("@bob");
  expect(serverNotes).not.toContain("/pull/2");

  const desktopNotes = generateReleaseNotes({ ...options(), product: "desktop" }, github);
  expect(desktopNotes).toContain(
    "* Fix desktop playback by @bob in https://github.com/owner/lumen/pull/2",
  );
  expect(desktopNotes).toContain(
    "* Extend shared API by @carol in https://github.com/owner/lumen/pull/3",
  );
  expect(desktopNotes).toContain("## Contributors\n@bob, @carol");
  expect(desktopNotes).not.toContain("/pull/1");
  expect(desktopNotes).not.toContain("@dana");
});

test("several rebased commits from one PR produce one entry", () => {
  const { commit, pulls, github, options } = fixture();
  const first = commit("apps/server/src/first.ts", "First part");
  const second = commit("apps/server/src/second.ts", "Second part");
  const pr = pullRequest(4, second, "Complete server fix", "alice");
  pulls.set(first, [pr]);
  pulls.set(second, [pr]);
  const notes = generateReleaseNotes(options(), github);
  expect(notes.match(/\/pull\/4/g)).toHaveLength(1);
  expect(notes).not.toContain("First part");
  expect(notes).not.toContain("Second part");
});

test("merge commits use PR attribution and the release's previous tag bounds the notes", () => {
  const { git, commit, pulls, github, options } = fixture();
  const prior = commit("apps/server/src/prior.ts", "Already released");
  pulls.set(prior, [pullRequest(5, prior, "Prior fix", "old-author")]);
  git("tag", "v0.0.10+server");
  git("switch", "-qc", "feature");
  commit("apps/server/src/new.ts", "Implementation detail");
  git("switch", "-q", "main");
  git("merge", "--no-ff", "-qm", "Merge feature", "feature");
  const merge = git("rev-parse", "HEAD");
  pulls.set(merge, [pullRequest(6, merge, "Fix merged feature", "alice")]);
  const notes = generateReleaseNotes(
    { ...options(), version: "0.0.11", previousTag: "v0.0.10+server" },
    github,
  );
  expect(notes).toContain(
    "* Fix merged feature by @alice in https://github.com/owner/lumen/pull/6",
  );
  expect(notes).not.toContain("Implementation detail");
  expect(notes).not.toContain("old-author");
  expect(notes).toContain("compare/v0.0.10%2Bserver...v0.0.11%2Bserver");
});

test("open, previously released, foreign, and unreachable PRs do not get credited", () => {
  const { git, commit, initial, pulls, github, options } = fixture();
  const sha = commit("apps/server/src/direct.ts", "Direct <fix>");
  const candidate = options();
  git("switch", "-qc", "future");
  const future = commit("apps/server/src/future.ts", "Not in this release");
  pulls.set(sha, [
    { ...pullRequest(7, sha, "Open PR", "open-author"), merged_at: null },
    pullRequest(8, initial, "Old PR", "old-author"),
    {
      ...pullRequest(9, sha, "Foreign PR", "foreign-author"),
      base: { repo: { full_name: "another/repo" } },
    },
    pullRequest(10, future, "Future PR", "future-author"),
  ]);
  const notes = generateReleaseNotes(candidate, github);
  expect(notes).toContain("Direct \\<fix\\> by Local Author");
  expect(notes).toContain(`/commit/${sha}`);
  expect(notes).not.toContain("/pull/");
  expect(notes).not.toContain("## Contributors");
});

test("the first release links to its history and an empty product range makes no API requests", () => {
  const { commit, github, options } = fixture();
  commit("apps/server/src/first.ts", "First server change");
  const notes = generateReleaseNotes({ ...options(), previousTag: "" }, github);
  expect(notes).toContain("First server change by Local Author");
  expect(notes).toContain(
    "**Full Changelog**: https://github.com/owner/lumen/commits/v0.0.10%2Bserver",
  );
  const unavailable = () => {
    throw new Error("API unavailable");
  };
  const empty = generateReleaseNotes(
    { ...options(), product: "desktop" },
    {
      pullRequests: unavailable,
      commitAuthor: unavailable,
    },
  );
  expect(empty).toContain("No component changes since the previous release.");
});

test("GitHub failures stop note generation instead of silently dropping attribution", () => {
  const { commit, github, options } = fixture();
  commit("apps/server/src/first.ts", "Server change");
  expect(() =>
    generateReleaseNotes(options(), {
      ...github,
      pullRequests: () => {
        throw new Error("GitHub rate limit");
      },
    }),
  ).toThrow("GitHub rate limit");
});
