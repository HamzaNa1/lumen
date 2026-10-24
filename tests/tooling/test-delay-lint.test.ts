import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const lint = (source: string, directory = "tests/helpers") => {
  const root = resolve(import.meta.dir, "../..");
  const fixture = mkdtempSync(resolve(root, directory, ".lint-fixture-"));
  try {
    const path = resolve(fixture, "fixture.ts");
    writeFileSync(path, source);
    const result = Bun.spawnSync(
      [process.execPath, "run", "biome", "lint", "--only=plugin", path],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    return { code: result.exitCode, output: result.stderr.toString() + result.stdout.toString() };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
};

test.each([
  "setTimeout(() => {}, 1);",
  "globalThis.setTimeout(() => {}, 1);",
  'import * as timers from "node:timers/promises"; timers.setTimeout(1);',
  'import { sleep as pause } from "bun"; pause(1);',
  "window.setTimeout(() => {}, 1);",
  "Bun.sleep(1);",
  "Bun.sleepSync(1);",
  "Effect.sleep(1);",
  "sleep(1);",
  "delay(1);",
  "page.waitForTimeout(1);",
  'import { setTimeout as pause } from "node:timers/promises"; pause(1);',
  'import { setTimeout } from "node:timers"; setTimeout(() => {}, 1);',
])("rejects test delay: %s", (source) => {
  const result = lint(source);
  expect(result.code).toBe(1);
  expect(result.output).toContain("plugin");
});

test.each([
  "test.setTimeout(60_000);",
  "jest.advanceTimersByTime(100);",
  'spyOn(globalThis, "setTimeout");',
  "await eventually(() => ready);",
  "const description = 'Bun.sleep(100)';",
])("allows deterministic synchronization and test deadlines: %s", (source) => {
  expect(lint(source).code).toBe(0);
});

test("applies the delay ban only to tests", () => {
  expect(lint("setTimeout(() => {}, 1);", "apps/server/src").code).toBe(0);
});
