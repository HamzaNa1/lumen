import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test as base, expect } from "@playwright/test";
import { repository } from "./server";

export class CliWorkspace {
  readonly root = mkdtempSync(join(tmpdir(), "lumen-cli-e2e-"));
  constructor() {
    cpSync(join(repository, "scripts"), join(this.root, "scripts"), { recursive: true });
    cpSync(join(repository, ".github/rulesets"), join(this.root, ".github/rulesets"), {
      recursive: true,
    });
    this.write("package.json", {
      name: "e2e",
      private: true,
      type: "module",
      version: "0.0.7",
      workspaces: ["apps/*", "packages/*"],
    });
    for (const path of ["apps/server", "apps/desktop", "packages/contracts"])
      this.write(`${path}/package.json`, {
        name: path.replace("/", "-"),
        private: true,
        version: "0.0.7",
      });
    this.run("bun", ["install", "--lockfile-only"]);
    this.git("init", "-b", "main");
    this.git("config", "user.name", "E2E");
    this.git("config", "user.email", "e2e@example.invalid");
    this.git("config", "commit.gpgsign", "false");
    this.git("config", "core.hooksPath", join(this.root, "no-hooks"));
    this.git("add", ".");
    this.git("commit", "-m", "Initial fixture");
  }
  write(path: string, content: unknown) {
    mkdirSync(dirname(join(this.root, path)), { recursive: true });
    writeFileSync(
      join(this.root, path),
      typeof content === "string" ? content : JSON.stringify(content, null, 2),
    );
  }
  command(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    const result = spawnSync(command, args, {
      cwd: this.root,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, ...env },
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }
  run(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    const result = this.command(command, args, env);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }
  git(...args: string[]) {
    return this.run("git", args);
  }
  script(file: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    return this.command("bun", [`scripts/${file}.ts`, ...args], env);
  }
  close() {
    rmSync(this.root, { recursive: true, force: true });
  }
}
export const bunExecutable = () =>
  execFileSync("bun", ["-e", "console.log(process.execPath)"], { encoding: "utf8" }).trim();
export const test = base.extend<{ workspace: CliWorkspace }>({
  workspace: async ({ playwright: _playwright }, use) => {
    const workspace = new CliWorkspace();
    try {
      await use(workspace);
    } finally {
      workspace.close();
    }
  },
});
export { expect } from "@playwright/test";
