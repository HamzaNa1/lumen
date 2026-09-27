import { appendFileSync } from "node:fs";
import {
  assertCanPromote,
  git,
  planRelease,
  releasePaths,
  remoteTags,
} from "./lib/releases";
import { verifyVersion } from "./version";
import { parseProduct, products } from "./lib/products";

const [command, target, version, previousTag = ""] = process.argv.slice(2);
const product = parseProduct(target);
if (version === undefined) throw new Error("A release version is required.");

if (command === "preflight") {
  if (process.env.GITHUB_REF !== `refs/heads/${process.env.DEFAULT_BRANCH}`) {
    throw new Error("Run releases from the default branch.");
  }
  verifyVersion(product, version);
  const plan = planRelease(product, version, remoteTags());
  const output = process.env.GITHUB_OUTPUT;
  if (output === undefined) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(
    output,
    `version=${plan.version}\ntag=${plan.tag}\nprerelease=${plan.prerelease}\nprevious-tag=${plan.previousTag}\n`,
  );
} else if (command === "promotion-check") {
  assertCanPromote(product, version, remoteTags());
} else if (command === "notes") {
  const revision = process.env.GITHUB_SHA ?? git("rev-parse", "HEAD");
  const range = previousTag === "" ? revision : `${previousTag}..${revision}`;
  const changes = git(
    "log",
    "--no-merges",
    "--format=- %s (%h)",
    range,
    "--",
    ...releasePaths(product),
  );
  console.log(
    `${products[product].name} ${version}\n\n${changes || "No component changes since the previous release."}`,
  );
  if (previousTag !== "") console.log(`\nChanges since \`${previousTag}\`.`);
  if (product === "server") {
    const image = process.env.SERVER_IMAGE;
    const digest = process.env.SERVER_DIGEST;
    if (!image || !digest)
      throw new Error("SERVER_IMAGE and SERVER_DIGEST are required for server release notes.");
    console.log(`\nContainer: \`${image}:${version}\`\n\nDigest: \`${image}@${digest}\``);
  }
} else {
  throw new Error(
    "Usage: bun scripts/release.ts <preflight|notes|promotion-check> <server|desktop> <version> [previous-tag]",
  );
}
