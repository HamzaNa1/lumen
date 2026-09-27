import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, latestStableTag, repositoryRoot, run } from "./lib/releases";
import { parseProduct, productWorkspaces, workspaceFilters } from "./lib/products";

const product = parseProduct(process.argv[2]);
const counterpart = product === "server" ? "desktop" : "server";
const tag = latestStableTag(counterpart, git("tag", "--list").split("\n"));
if (tag === undefined)
  throw new Error(
    `No stable ${counterpart} release tag found. Fetch release tags before checking compatibility.`,
  );

const temporary = mkdtempSync(join(tmpdir(), "lumen-release-compatibility-"));
const checkout = join(temporary, "released");
let added = false;
try {
  run("git", ["worktree", "add", "--detach", checkout, tag]);
  added = true;
  run(
    process.execPath,
    ["install", "--frozen-lockfile", ...workspaceFilters(productWorkspaces(counterpart))],
    checkout,
  );
  console.log(`Checking candidate ${product} against ${tag}`);
  execFileSync(process.execPath, ["test", "tests/compatibility/releases.test.ts"], {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      LUMEN_COMPAT_SERVER_ROOT: product === "server" ? repositoryRoot : checkout,
      LUMEN_COMPAT_DESKTOP_ROOT: product === "desktop" ? repositoryRoot : checkout,
    },
  });
} finally {
  if (added) run("git", ["worktree", "remove", "--force", checkout]);
  rmSync(temporary, { recursive: true, force: true });
}
