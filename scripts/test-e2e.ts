import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseProduct } from "./lib/products";
import { repositoryRoot } from "./lib/releases";
import { verifyTestOwnership } from "./lib/verification";
import { withReleasedCounterpart } from "./lib/verification-workspace";

const product = process.argv[2] === "source" ? undefined : parseProduct(process.argv[2]);
const args = process.argv.slice(3);
const build = !args.includes("--no-build");
verifyTestOwnership(repositoryRoot);
const verify = (workspace: string) => {
  const run = (args: string[]) =>
    execFileSync(process.execPath, args, {
      cwd: workspace,
      stdio: "inherit",
      env: {
        ...process.env,
        LUMEN_BROWSER_PRODUCT: product ?? "source",
        LUMEN_BROWSER_ARTIFACT_ROOT: process.env.LUMEN_BROWSER_ARTIFACT_ROOT ?? repositoryRoot,
      },
    });
  if (!existsSync(join(workspace, "apps/desktop/node_modules/electron/path.txt")))
    run(["apps/desktop/node_modules/electron/install.js"]);
  if (build) {
    run(["run", "--cwd", "apps/web", "build"]);
    run(["run", "--cwd", "apps/desktop", "build"]);
  }
  run(["run", "playwright", "test", ...args.filter((arg) => arg !== "--no-build")]);
};
const awake =
  process.platform === "darwin"
    ? spawn("caffeinate", ["-d", "-i", "-w", String(process.pid)])
    : undefined;
try {
  if (product) withReleasedCounterpart(product, verify);
  else verify(repositoryRoot);
} finally {
  awake?.kill();
}
