import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { test as base, expect, repository } from "./server";

export const test = base.extend<{
  transport: { origin: string; brief: string; bridge: string; bindRejected: boolean };
}>({
  transport: async ({ playwright: _playwright }, use) => {
    const child = spawn("bun", [join(repository, "tests/e2e/support/transport-entry.ts")], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: process.env,
    });
    const errors: string[] = [];
    child.stderr?.on("data", (data) => errors.push(String(data)));
    try {
      const [ready] = await once(child, "message", { signal: AbortSignal.timeout(15000) });
      await use(ready);
    } finally {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(10000) });
      child.kill("SIGTERM");
      const [code] = await exited;
      expect(code, errors.join("")).toBe(0);
    }
  },
});
export { expect } from "./server";
