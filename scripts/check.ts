import { checkWorkspaces, parseProduct, workspaceFilters } from "./lib/products";
import { run } from "./lib/releases";

const product = parseProduct(process.argv[2]);
const workspaces = checkWorkspaces(product);
const tests = [`tests/${product}`, "tests/shared", "tests/tooling"];
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
  build: () => run(process.execPath, ["run", ...workspaceFilters(workspaces), "build"]),
};

const step = process.argv[3];
if (step === undefined) {
  for (const check of Object.values(steps)) check();
} else if (step === "lint" || step === "typecheck" || step === "test" || step === "build") {
  steps[step]();
} else {
  throw new Error("Choose lint, typecheck, test, or build.");
}
