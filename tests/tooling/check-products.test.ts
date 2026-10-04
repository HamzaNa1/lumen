import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "lumen-check-test-"));
  directories.push(root);
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  for (const path of ["scripts", "biome.json", "tsconfig.base.json", "tsconfig.scripts.json"])
    cpSync(join(repository, path), join(root, path), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
  write("package.json", JSON.stringify(manifest));
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "junction");
  for (const path of [
    "apps/server",
    "apps/desktop",
    "packages/contracts",
    "packages/database",
    "packages/ui",
    "packages/client",
    "packages/app",
    "apps/web",
    "packages/testkit",
    "packages/config",
  ]) {
    write(
      `${path}/package.json`,
      JSON.stringify({
        name: path.replace("/", "-"),
        scripts: {
          typecheck: "tsc -p tsconfig.json",
          build: "bun build src/index.ts --outdir dist",
        },
      }),
    );
    write(
      `${path}/tsconfig.json`,
      JSON.stringify({
        extends: "../../tsconfig.base.json",
        compilerOptions: { types: [] },
        include: ["src/**/*.ts"],
      }),
    );
    write(`${path}/src/index.ts`, "export const value: string = 'valid';\n");
  }
  for (const owner of ["server", "desktop", "web", "shared", "tooling"])
    write(
      `tests/${owner}/example.test.ts`,
      'import { test, expect } from "bun:test"; test("works", () => expect(1).toBe(1));\n',
    );
  write("tests/native/example.ts", "export const native = true;\n");
  write(
    "tests/compatibility/example.test.ts",
    'throw new Error("Unreleased counterpart is broken");\n',
  );
  const check = async (product: string) => {
    const child = Bun.spawn([process.execPath, "run", `check:${product}`], {
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
  return { write, check };
};

test.each(["server", "desktop"])(
  "%s checks ignore the counterpart's code, dependencies, and tests",
  async (product) => {
    const { write, check } = fixture();
    const counterpart = product === "server" ? "desktop" : "server";
    write(`apps/${counterpart}/src/index.ts`, "export const broken: string = 1;\n");
    // The database belongs to the server alone; the web app ships only with the server.
    const unowned = product === "server" ? [] : ["packages/database", "apps/web"];
    for (const path of unowned) write(`${path}/src/index.ts`, "export const broken: string = 1;\n");
    if (product === "desktop")
      write("tests/web/example.test.ts", 'throw new Error("Counterpart test failure");\n');
    write(`apps/${counterpart}/scripts/broken.ts`, "export const broken: any = 1;\n");
    write(`tests/${counterpart}/example.test.ts`, 'throw new Error("Counterpart test failure");\n');
    const result = await check(product);
    expect(result.output).not.toContain("Counterpart test failure");
    expect(result.exitCode, result.output).toBe(0);
  },
  30_000,
);

test.each(["server", "desktop"])(
  "%s checks reject errors in shared contracts",
  async (product) => {
    const { write, check } = fixture();
    write("packages/contracts/src/index.ts", "export const broken: string = 1;\n");
    const result = await check(product);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("TS2322");
  },
  30_000,
);

for (const product of ["server", "desktop"]) {
  test.each(["lint", "typecheck", "test", "build"])(
    `${product} checks reject their own %s failure`,
    async (step) => {
      const { write, check } = fixture();
      if (step === "lint") write(`apps/${product}/src/index.ts`, "export const broken: any = 1;\n");
      if (step === "typecheck")
        write(`apps/${product}/src/index.ts`, "export const broken: string = 1;\n");
      if (step === "test")
        write(`tests/${product}/example.test.ts`, 'throw new Error("Product test failure");\n');
      if (step === "build")
        write(
          `apps/${product}/package.json`,
          JSON.stringify({
            name: `apps-${product}`,
            scripts: {
              typecheck: "tsc -p tsconfig.json",
              build: "bun build missing-entry.ts --outdir dist",
            },
          }),
        );
      const result = await check(product);
      expect(result.exitCode).not.toBe(0);
      const failure = {
        lint: "noExplicitAny",
        typecheck: "TS2322",
        test: "Product test failure",
        build: "missing-entry.ts",
      }[step];
      expect(result.output).toContain(failure);
    },
    30_000,
  );
}

test.each([
  ["server", "apps/web"],
  ["server", "packages/app"],
  ["server", "packages/client"],
  ["desktop", "packages/app"],
  ["desktop", "packages/client"],
])(
  "%s checks reject errors in %s, which ships in it",
  async (product, workspace) => {
    const { write, check } = fixture();
    write(`${workspace}/src/index.ts`, "export const broken: string = 1;\n");
    const result = await check(product);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("TS2322");
  },
  30_000,
);

test("server checks run the web app's tests", async () => {
  const { write, check } = fixture();
  write("tests/web/example.test.ts", 'throw new Error("Web test failure");\n');
  const result = await check("server");
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("Web test failure");
});
