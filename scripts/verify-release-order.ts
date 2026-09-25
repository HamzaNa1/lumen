const version = process.argv[2];
const repository = process.env.GH_REPO;
if (!version || !repository || !/^[-\w]+\/[-\w]+$/u.test(repository)) {
  throw new Error("Usage: GH_REPO=owner/repo bun scripts/verify-release-order.ts <version>");
}
if (!version.includes("-")) {
  const parse = (value: string): number[] | null =>
    /^\d+\.\d+\.\d+$/u.test(value) ? value.split(".").map(Number) : null;
  const desired = parse(version);
  if (!desired) throw new Error("Invalid stable version");
  const result = Bun.spawnSync([
    "gh", "api", "--paginate", "--jq", ".[] | select(.draft == false and .prerelease == false) | .tag_name",
    `repos/${repository}/releases?per_page=100`,
  ], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("Could not inspect published releases");
  const tags = new TextDecoder().decode(result.stdout).trim().split("\n").filter(Boolean);
  for (const tag of tags) {
    const previous = parse(tag.replace(/^v/u, ""));
    if (!previous) continue;
    const comparison = desired.findIndex((part, index) => part !== previous[index]);
    if (comparison < 0 || (desired[comparison] ?? 0) < (previous[comparison] ?? 0)) {
      throw new Error(`Stable release ${version} must be newer than ${tag}`);
    }
  }
}
console.log(`Release order verified: ${version}`);
