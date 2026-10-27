import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkWorkspaces, parseProduct, workspaceFilters } from "./lib/products";
import { run } from "./lib/releases";
import { suites } from "./lib/verification";
import { withReleasedCounterpart } from "./lib/verification-workspace";

const product = parseProduct(process.argv[2]);
const workspaces = checkWorkspaces(product);
const tests = ["tests/e2e"];
const steps = {
  lint: () =>
    run(process.execPath, [
      "run",
      "biome",
      "check",
      ...workspaces,
      ...tests,
      "packages/config",
      "scripts",
      "package.json",
      "biome.json",
      "tsconfig.base.json",
      "tsconfig.scripts.json",
    ]),
  typecheck: () => {
    run(process.execPath, ["run", ...workspaceFilters(workspaces), "typecheck"]);
    run(process.execPath, ["run", "scripts/typecheck.ts", "-p", "tsconfig.scripts.json"]);
    withReleasedCounterpart(product, (workspace) => {
      const config = "tests/e2e/tsconfig.product.json";
      writeFileSync(
        join(workspace, config),
        JSON.stringify({
          extends: "./tsconfig.json",
          include: Object.entries(suites)
            .filter(([, suite]) => suite.products.includes(product))
            .map(([path]) => path),
        }),
      );
      run(process.execPath, ["run", "scripts/typecheck.ts", "-p", config], workspace);
    });
  },

  // One workspace at a time, in the product's declared order: packages before the apps that
  // bundle them, and the web app before the server that ships it.
  build: () => {
    for (const workspace of workspaces)
      run(process.execPath, ["run", ...workspaceFilters([workspace]), "build"]);
  },
  test: () => run(process.execPath, ["scripts/test-e2e.ts", product]),
};

const step = process.argv[3];
if (step === undefined) {
  for (const check of Object.values(steps)) check();
} else if (step === "lint" || step === "typecheck" || step === "test" || step === "build") {
  steps[step]();
} else {
  throw new Error("Choose lint, typecheck, test, or build.");
}
