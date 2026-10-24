import { execFileSync } from "node:child_process";
import { parseProduct } from "./lib/products";

// A built desktop and web app exercise the actual released counterpart, including its dependencies.
const product = parseProduct(process.argv[2]);
execFileSync(
  process.execPath,
  [
    "scripts/test-e2e.ts",
    product,
    "--project",
    "native",
    "--no-deps",
    "--grep",
    "real browser and Electron",
  ],
  { stdio: "inherit" },
);
