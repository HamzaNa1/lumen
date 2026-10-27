import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { expect, repository, type Server } from "./server";

export class ScanWorker {
  private constructor(
    private readonly child: ChildProcess,
    readonly log: string[],
  ) {}
  static async start(server: Server, overrides: NodeJS.ProcessEnv = {}) {
    const child = spawn("bun", [join(repository, "tests/e2e/support/scan-worker-entry.ts")], {
      cwd: repository,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        LUMEN_DATABASE_PATH: server.databasePath,
        LUMEN_DATA_DIR: server.root,
        LUMEN_LOG_FORMAT: "json",
        LUMEN_SCAN_LEASE_MS: "1000",
        ...overrides,
      },
    });
    const log: string[] = [];
    child.stdout?.on("data", (chunk) => log.push(String(chunk)));
    child.stderr?.on("data", (chunk) => log.push(String(chunk)));
    const ready = await once(child, "message", { signal: AbortSignal.timeout(10000) });
    expect(ready[0], log.join("")).toEqual({ ready: true });
    return new ScanWorker(child, log);
  }
  async call(action: "run" | "claim" | "recover" | "backfill", nowMs = Date.now()) {
    const id = crypto.randomUUID();
    const reply = once(this.child, "message", { signal: AbortSignal.timeout(20000) });
    this.child.send({ id, action, nowMs });
    const [message] = await reply;
    expect(message.id).toBe(id);
    return message as { id: string; result?: unknown; error?: string };
  }
  async close() {
    const exited = once(this.child, "exit");
    this.child.disconnect();
    expect((await exited)[0], this.log.join("")).toBe(0);
  }
}
