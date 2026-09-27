import { checkWorkspaces, parseProduct, workspaceFilters } from "./lib/products";
import { run } from "./lib/releases";

const product = parseProduct(process.argv[2]);
run(process.execPath, [
  "install",
  "--frozen-lockfile",
  "--filter",
  "./",
  ...workspaceFilters(checkWorkspaces(product)),
]);
