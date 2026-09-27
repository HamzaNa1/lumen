import { semver } from "bun";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type Product, productWorkspaces } from "./products";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export const isReleaseVersion = (value: string | undefined): value is string => {
  if (value === undefined) return false;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  return match !== null && (match[4]?.split(".").every((part) => !/^0\d+$/.test(part)) ?? true);
};

export const run = (command: string, args: string[], cwd = repositoryRoot): void => {
  execFileSync(command, args, { cwd, stdio: "inherit" });
};

export const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();

export const remoteTags = (): string[] =>
  git("ls-remote", "--tags", "--refs", "origin")
    .split("\n")
    .map((line) => line.split("\trefs/tags/")[1])
    .filter((tag): tag is string => tag !== undefined);

export const releaseTag = (product: Product, version: string): string => {
  if (!isReleaseVersion(version)) throw new Error(`Invalid release version: ${version}`);
  return `v${version}+${product}`;
};

export const productTags = (product: Product, tags: readonly string[]) =>
  tags
    .flatMap((tag) => {
      let version: string;
      if (tag.startsWith("v") && tag.endsWith(`+${product}`)) {
        version = tag.slice(1, -`+${product}`.length);
      } else if (tag.startsWith(`${product}-v`)) {
        version = tag.slice(`${product}-v`.length);
      } else if (tag.startsWith("v")) {
        version = tag.slice(1);
      } else {
        return [];
      }
      return isReleaseVersion(version) ? [{ tag, version }] : [];
    })
    .sort((a, b) => semver.order(b.version, a.version));

export const latestStableTag = (product: Product, tags: readonly string[]): string | undefined =>
  productTags(product, tags).find(({ version }) => !version.includes("-"))?.tag;

export const planRelease = (product: Product, version: string, tags: readonly string[]) => {
  const tag = releaseTag(product, version);
  const history = productTags(product, tags);
  const existing = history.find((entry) => entry.version === version);
  if (existing !== undefined) throw new Error(`${existing.tag} already exists.`);
  const prerelease = version.includes("-");
  const previous = history.find((entry) => prerelease || !entry.version.includes("-"));
  if (previous !== undefined && semver.order(version, previous.version) <= 0) {
    throw new Error(`${tag} must be newer than ${previous.tag}.`);
  }
  return { version, tag, prerelease, previousTag: previous?.tag ?? "" };
};

export const assertCanPromote = (
  product: Product,
  version: string,
  tags: readonly string[],
): void => {
  if (version.includes("-")) throw new Error("Prereleases cannot update latest.");
  const canonicalTag = releaseTag(product, version);
  const tag = tags.find((entry) => entry === canonicalTag || entry === `${product}-v${version}`);
  if (tag === undefined) throw new Error(`${canonicalTag} has not been published.`);
  planRelease(
    product,
    version,
    tags.filter((entry) => entry !== tag),
  );
};

export const releasePaths = (product: Product): string[] => [
  ...productWorkspaces(product),
  "package.json",
  "bunfig.toml",
  "tsconfig.base.json",
  "scripts",
  `.github/workflows/release-${product}.yml`,
  ".github/workflows/release-preflight.yml",
];
