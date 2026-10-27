import { execFileSync } from "node:child_process";
import { parseProduct } from "./lib/products";

const target = process.argv[2];
if (target !== "source") parseProduct(target);
const args = process.argv.slice(3);
const projects = args.some((arg) => arg === "--project" || arg.startsWith("--project="))
  ? []
  : target === "desktop"
    ? ["--project", "native", "--no-deps"]
    : ["--project", "chromium", "--project", "firefox", "--project", "webkit"];
execFileSync(process.execPath, ["scripts/test-e2e.ts", target ?? "source", ...projects, ...args], {
  stdio: "inherit",
});
