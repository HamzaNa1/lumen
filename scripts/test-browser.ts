import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseProduct } from "./lib/products";
import { repositoryRoot, run } from "./lib/releases";
import { verifyTestOwnership } from "./lib/verification";
import { withReleasedCounterpart } from "./lib/verification-workspace";

const product = process.argv[2] === "source" ? undefined : parseProduct(process.argv[2]);
verifyTestOwnership(repositoryRoot);
if (product !== "desktop") run(process.execPath, ["run", "build:web"]);
if (product !== "server") {
  run(process.execPath, ["run", "--cwd", "apps/desktop", "build"]);
  run(process.execPath, ["tests/browser/buildDesktopBaseline.ts"]);
}
const verify = (workspace: string) => {
  execFileSync(
    process.execPath,
    [
      "run",
      "playwright",
      "test",
      "--output",
      join(repositoryRoot, "test-results", product ?? "source"),
      ...process.argv.slice(3),
    ],
    {
      cwd: workspace,
      stdio: "inherit",
      env: {
        ...process.env,
        LUMEN_BROWSER_PRODUCT: product ?? "source",
        LUMEN_BROWSER_ARTIFACT_ROOT: repositoryRoot,
      },
    },
  );
};
if (product === "desktop") withReleasedCounterpart(product, verify);
else verify(repositoryRoot);
