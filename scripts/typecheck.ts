import { spawn } from "bun";

const supportsTsrs =
  (process.platform === "darwin" && process.arch === "arm64") ||
  (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64"));

// tsrs 0.18 publishes native binaries only for these platforms.
const compiler = supportsTsrs ? "tsrs" : "tsc";
const child = spawn([process.execPath, "run", compiler, ...process.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
