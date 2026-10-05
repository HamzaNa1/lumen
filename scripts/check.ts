import { checkWorkspaces, parseProduct, productTests, workspaceFilters } from "./lib/products";
import { run } from "./lib/releases";

const product = parseProduct(process.argv[2]);
const workspaces = checkWorkspaces(product);
const tests = productTests(product);
const steps = {
  lint: () =>
    run(process.execPath, [
      "run",
      "biome",
      "lint",
      ...workspaces,
      ...tests,
      "packages/config",
      "scripts",
      "package.json",
      "biome.json",
      "tsconfig.base.json",
      "tsconfig.scripts.json",
      ...(product === "desktop" ? ["tests/native"] : []),
    ]),
  typecheck: () => {
    run(process.execPath, ["run", ...workspaceFilters(workspaces), "typecheck"]);
    run(process.execPath, ["run", "tsc", "-p", "tsconfig.scripts.json"]);
  },
  test: () => run(process.execPath, ["test", ...tests]),
  // One workspace at a time, in the product's declared order: packages before the apps that
  // bundle them, and the web app before the server that ships it.
  build: () => {
    for (const workspace of workspaces)
      run(process.execPath, ["run", ...workspaceFilters([workspace]), "build"]);
  },
};

const step = process.argv[3];
if (step === undefined) {
  for (const check of Object.values(steps)) check();
} else if (step === "lint" || step === "typecheck" || step === "test" || step === "build") {
  steps[step]();
} else {
  throw new Error("Choose lint, typecheck, test, or build.");
}
