import { execFileSync } from "node:child_process";
import { type Product, products } from "./products";
import { releasePaths, releaseTag, repositoryRoot } from "./releases";

interface ReleasePullRequest {
  readonly number: number;
  readonly title: string;
  readonly merged_at: string | null;
  readonly merge_commit_sha: string | null;
  readonly user: { readonly login: string } | null;
  readonly base: { readonly repo: { readonly full_name: string } };
}

export interface ReleaseNotesGitHub {
  pullRequests(commit: string): readonly ReleasePullRequest[];
  commitAuthor(commit: string): string | null;
}

interface ReleaseNotesOptions {
  readonly product: Product;
  readonly version: string;
  readonly repository: string;
  readonly revision: string;
  readonly previousTag: string;
  readonly root?: string;
}

const githubSource = (repository: string): ReleaseNotesGitHub => ({
  pullRequests: (commit) => {
    const pages = JSON.parse(
      execFileSync(
        "gh",
        [
          "api",
          `repos/${repository}/commits/${commit}/pulls?per_page=100`,
          "--paginate",
          "--slurp",
        ],
        { encoding: "utf8" },
      ),
    ) as ReleasePullRequest[][];
    return pages.flat();
  },
  commitAuthor: (commit) => {
    const response = JSON.parse(
      execFileSync("gh", ["api", `repos/${repository}/commits/${commit}`], { encoding: "utf8" }),
    ) as { author: { login: string } | null };
    return response.author?.login ?? null;
  },
});

const markdownText = (value: string): string =>
  value.replace(/\s+/g, " ").replace(/[\\`*_[\]<>]/g, "\\$&");

export const generateReleaseNotes = (
  options: ReleaseNotesOptions,
  github: ReleaseNotesGitHub = githubSource(options.repository),
): string => {
  const { product, version, repository, previousTag, revision } = options;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Expected an owner/repository name.");
  const tag = releaseTag(product, version);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: options.root ?? repositoryRoot,
      encoding: "utf8",
    }).trim();
  const range = previousTag === "" ? revision : `${previousTag}..${revision}`;
  const releaseCommits = new Set(git("rev-list", range).split("\n"));
  const history = git(
    "log",
    "--first-parent",
    "--format=%H%x00%s%x00%an",
    range,
    "--",
    ...releasePaths(product),
  );
  const baseUrl = `https://github.com/${repository}`;
  const includedPullRequests = new Set<number>();
  const contributors = new Set<string>();
  const changes: string[] = [];
  for (const entry of history === "" ? [] : history.split("\n")) {
    const [commit, subject, authorName] = entry.split("\0");
    const pullRequests = github
      .pullRequests(commit)
      .filter(
        (pullRequest) =>
          pullRequest.merged_at !== null &&
          pullRequest.merge_commit_sha !== null &&
          releaseCommits.has(pullRequest.merge_commit_sha) &&
          pullRequest.base.repo.full_name.toLowerCase() === repository.toLowerCase(),
      );
    if (pullRequests.length === 0) {
      const login = github.commitAuthor(commit);
      if (login !== null) contributors.add(login);
      const author = login === null ? markdownText(authorName) : `@${login}`;
      changes.push(
        `* ${markdownText(subject)} by ${author} in [${commit.slice(0, 7)}](${baseUrl}/commit/${commit})`,
      );
    }
    for (const pullRequest of pullRequests) {
      if (includedPullRequests.has(pullRequest.number)) continue;
      includedPullRequests.add(pullRequest.number);
      const login = pullRequest.user?.login;
      if (login !== undefined) contributors.add(login);
      const author = login === undefined ? "" : ` by @${login}`;
      changes.push(
        `* ${markdownText(pullRequest.title)}${author} in ${baseUrl}/pull/${pullRequest.number}`,
      );
    }
  }
  const sections = [
    `${products[product].name} ${version}`,
    `## What's Changed\n${changes.length === 0 ? "No component changes since the previous release." : changes.join("\n")}`,
  ];
  if (contributors.size > 0)
    sections.push(
      `## Contributors\n${[...contributors]
        .sort()
        .map((login) => `@${login}`)
        .join(", ")}`,
    );
  const changelog =
    previousTag === ""
      ? `${baseUrl}/commits/${encodeURIComponent(tag)}`
      : `${baseUrl}/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(tag)}`;
  sections.push(`**Full Changelog**: ${changelog}`);
  return `${sections.join("\n\n")}\n`;
};
