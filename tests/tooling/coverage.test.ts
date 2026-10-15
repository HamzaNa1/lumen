import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const command = fileURLToPath(new URL("../../scripts/coverage.ts", import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "lumen-coverage-test-"));
  directories.push(root);
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await write("apps/example/src/used.ts", "export const used = () => 42;\n");
  await write(
    "tests/example.test.ts",
    'import { test, expect } from "bun:test";\nimport { used } from "../apps/example/src/used";\ntest("works", () => expect(used()).toBe(42));\n',
  );
  await write("coverage-baseline.json", JSON.stringify({ "apps/example": 0 }));
  const run = async () => {
    const child = Bun.spawn([process.execPath, command], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, output: stdout + stderr };
  };
  return { root, write, run };
};

test("an unimported production module remains uncovered and fails the regression budget", async () => {
  const { root, write, run } = await fixture();
  await write(
    "apps/example/src/unused.ts",
    'throw new Error("must not execute source for coverage");\n',
  );
  const result = await run();
  expect(result.output).not.toContain("error: must not execute source for coverage");
  expect(result.exitCode).toBe(1);
  const summary = await Bun.file(join(root, "coverage/summary.json")).json();
  expect(summary.workspaces["apps/example"]).toMatchObject({ total: 2, covered: 1, uncovered: 1 });
  expect(summary.files["apps/example/src/unused.ts"]).toMatchObject({
    total: 1,
    covered: 0,
    loaded: false,
  });
  expect(await Bun.file(join(root, "coverage/lcov.info")).text()).toContain(
    "SF:apps/example/src/unused.ts\nDA:1,0\nLF:1\nLH:0",
  );
  expect(result.output).toContain("apps/example: 1 uncovered lines exceeds baseline 0");

  await write("coverage-baseline.json", JSON.stringify({ "apps/example": 1 }));
  const accepted = await run();
  expect(accepted.exitCode, accepted.output).toBe(0);
  await write("packages/new/src/unused.ts", "export const untested = () => 7;\n");
  const expanded = await run();
  expect(expanded.exitCode).toBe(1);
  expect(expanded.output).toContain("packages/new: 1 uncovered lines exceeds baseline 0");
});

test("test helpers, declarations, and generated output cannot inflate production coverage", async () => {
  const { root, write, run } = await fixture();
  for (const path of [
    "packages/testkit/src/helper.ts",
    "apps/example/src/types.d.ts",
    "apps/example/src/client.generated.ts",
    "apps/example/src/generated/client.ts",
    "apps/example/dist/bundle.js",
    "tests/helpers/setup.ts",
  ]) {
    await write(path, "export const helper = () => 1;\n");
  }
  const result = await run();
  expect(result.exitCode, result.output).toBe(0);
  const summary = await Bun.file(join(root, "coverage/summary.json")).json();
  expect(Object.keys(summary.files)).toEqual(["apps/example/src/used.ts"]);
  expect(summary.workspaces["apps/example"]).toEqual({ total: 1, covered: 1, uncovered: 0 });
});

test.each([
  "export enum State { Playing, Paused }\n",
  "export class Session { constructor(public id: string) {} }\n",
  'export default console.log("must not execute");\n',
])("unimported runtime declarations and default expressions count: %s", async (source) => {
  const { root, write, run } = await fixture();
  await write("apps/example/src/runtime.ts", source);
  const result = await run();
  expect(result.exitCode).toBe(1);
  const summary = await Bun.file(join(root, "coverage/summary.json")).json();
  expect(summary.files["apps/example/src/runtime.ts"]).toMatchObject({
    total: 1,
    covered: 0,
    loaded: false,
  });
});

test("JSX runtime source is inventoried while pure type modules contribute no statements", async () => {
  const { root, write, run } = await fixture();
  await write("apps/example/src/component.jsx", "export const view = <main>Hello</main>;\n");
  await write("apps/example/src/model.ts", "export interface Model { id: string }\n");
  const result = await run();
  expect(result.exitCode).toBe(1);
  const summary = await Bun.file(join(root, "coverage/summary.json")).json();
  expect(summary.files["apps/example/src/component.jsx"]).toMatchObject({
    total: 1,
    covered: 0,
    loaded: false,
  });
  expect(summary.files["apps/example/src/model.ts"]).toMatchObject({
    total: 0,
    covered: 0,
    loaded: false,
  });
});

test("failing tests remain failures even when coverage meets its budget, and stale evidence is replaced", async () => {
  const { root, write, run } = await fixture();
  await write("coverage/stale.json", "stale");
  await write(
    "tests/failure.test.ts",
    'import { test, expect } from "bun:test"; test("fails", () => expect(1).toBe(2));\n',
  );
  const result = await run();
  expect(result.exitCode).toBe(1);
  expect(await Bun.file(join(root, "coverage/stale.json")).exists()).toBe(false);
  const summary = await Bun.file(join(root, "coverage/summary.json")).json();
  expect(summary.testsExitCode).toBe(1);
  expect(summary.regressions).toEqual([]);
});
