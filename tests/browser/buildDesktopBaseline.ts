// Builds the desktop renderer as it was before the application moved into the shared packages,
// so the parity test can hold today's desktop build against it. The commit is fixed: this
// checks the extraction against an independent reference rather than comparing two builds
// that could share the same regression.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BASELINE_COMMIT = "2f68444cb7884c64cca7028a061e7922cd3705e2";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const output = join(repository, "apps/desktop/out/renderer-baseline");
const marker = join(output, "commit");

if (existsSync(marker) && readFileSync(marker, "utf8") === BASELINE_COMMIT) process.exit(0);

const checkout = join(mkdtempSync(join(tmpdir(), "lumen-baseline-")), "source");
const run = (cwd: string, command: string, ...args: string[]): void => {
  execFileSync(command, args, { cwd, stdio: "inherit" });
};
run(repository, "git", "worktree", "add", "--detach", checkout, BASELINE_COMMIT);
try {
  run(checkout, "bun", "install", "--frozen-lockfile");
  run(join(checkout, "apps/desktop"), "bunx", "electron-vite", "build");
  rmSync(output, { recursive: true, force: true });
  cpSync(join(checkout, "apps/desktop/out/renderer"), output, { recursive: true });
  writeFileSync(marker, BASELINE_COMMIT);
} finally {
  run(repository, "git", "worktree", "remove", "--force", checkout);
}
