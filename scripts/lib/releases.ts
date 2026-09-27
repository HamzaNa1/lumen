import { semver } from "bun";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const products = {
  server: { name: "Lumen Server", manifest: "apps/server/package.json", packages: ["database"] },
  desktop: { name: "Lumen Desktop", manifest: "apps/desktop/package.json", packages: ["ui"] },
} as const;
export type Product = keyof typeof products;

export const parseProduct = (value: string | undefined): Product => {
  if (value !== "server" && value !== "desktop") throw new Error("Choose server or desktop.");
  return value;
};

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

export const productTags = (product: Product, tags: readonly string[]) =>
  tags
    .flatMap((tag) => {
      const prefix = tag.startsWith(`${product}-v`) ? `${product}-v` : "v";
      if (!tag.startsWith(prefix)) return [];
      const version = tag.slice(prefix.length);
      return isReleaseVersion(version) ? [{ tag, version }] : [];
    })
    .sort((a, b) => semver.order(b.version, a.version));

export const latestStableTag = (product: Product, tags: readonly string[]): string | undefined =>
  productTags(product, tags).find(({ version }) => !version.includes("-"))?.tag;

export const planRelease = (product: Product, version: string, tags: readonly string[]) => {
  if (!isReleaseVersion(version)) throw new Error(`Invalid release version: ${version}`);
  const tag = `${product}-v${version}`;
  if (tags.includes(tag)) throw new Error(`${tag} already exists.`);
  const prerelease = version.includes("-");
  const previous = productTags(product, tags).find(
    (entry) => prerelease || !entry.version.includes("-"),
  );
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
  const tag = `${product}-v${version}`;
  if (!tags.includes(tag)) throw new Error(`${tag} has not been published.`);
  planRelease(
    product,
    version,
    tags.filter((entry) => entry !== tag),
  );
};

export const releasePaths = (product: Product): string[] => [
  `apps/${product}`,
  "packages/contracts",
  ...products[product].packages.map((name) => `packages/${name}`),
  "package.json",
  "bunfig.toml",
  "tsconfig.base.json",
  "scripts",
  `.github/workflows/release-${product}.yml`,
  ".github/workflows/release-preflight.yml",
];
