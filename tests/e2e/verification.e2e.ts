import { cpSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./support/cli";
import { repository } from "./support/server";

test("the E2E runner installs Electron only when selected projects can launch it", async ({
  workspace,
}) => {
  cpSync(join(repository, "tests/e2e"), join(workspace.root, "tests/e2e"), { recursive: true });
  workspace.write("package.json", { scripts: { playwright: "bun -e 'process.exit(0)'" } });
  workspace.write("apps/desktop/node_modules/electron/install.js", "process.exit(81);\n");
  for (const projects of [
    ["--project", "api"],
    ["--project=tooling"],
    ["--project", "chromium", "firefox", "webkit"],
    ["--project", "api", "--project", "tooling"],
  ]) {
    const result = workspace.script("test-e2e", ["source", "--no-build", ...projects]);
    expect(result.status, result.stderr).toBe(0);
  }
  for (const projects of [
    [],
    ["--project", "native"],
    ["--project", "chromium", "native"],
    ["--project=chromium", "--project=native"],
    ["--project", "*"],
  ])
    expect(workspace.script("test-e2e", ["source", "--no-build", ...projects]).status).not.toBe(0);
});

test("CI change detection follows workspace dependents and fails open for unknown changes or missing history", async ({
  workspace,
}) => {
  workspace.write("packages/client/package.json", {
    name: "client",
    dependencies: { "packages-contracts": "workspace:*" },
  });
  workspace.write("packages/app/package.json", {
    name: "app",
    dependencies: { client: "workspace:*" },
  });
  workspace.write("apps/desktop/package.json", {
    name: "desktop",
    devDependencies: { app: "workspace:*" },
  });
  workspace.git("add", ".");
  workspace.git("commit", "-m", "Workspace dependency graph");
  const classify = (base: string, event = "pull_request") => {
    const result = workspace.script("ci-changes", [], {
      GITHUB_EVENT_NAME: event,
      CI_BASE_SHA: base,
      CI_HEAD_SHA: workspace.git("rev-parse", "HEAD"),
      GITHUB_OUTPUT: "",
    });
    expect(result.status, result.stderr).toBe(0);
    return Object.fromEntries(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
  };
  const all = { coverage: "true", desktop: "true", server: "true" };
  for (const [path, expected] of [
    ["README.md", { coverage: "false", desktop: "false", server: "false" }],
    ["apps/server/src/main.ts", { coverage: "true", desktop: "false", server: "true" }],
    ["apps/desktop/src/main.ts", { coverage: "true", desktop: "true", server: "false" }],
    ["packages/contracts/src/ipc.ts", all],
    ["packages/client/src/index.ts", all],
    ["new-workspace/source.ts", all],
    [".github/workflows/checks.yml", all],
    ["bun.lock", all],
  ] as const) {
    const base = workspace.git("rev-parse", "HEAD");
    workspace.write(path, "changed\n");
    workspace.git("add", path);
    workspace.git("commit", "-m", `Change ${path}`);
    expect(classify(base)).toEqual(expected);
  }
  const beforeRename = workspace.git("rev-parse", "HEAD");
  workspace.git("mv", "apps/desktop/src/main.ts", "docs-moved.md");
  workspace.git("commit", "-m", "Move source out of desktop");
  expect(classify(beforeRename)).toEqual(all);
  expect(classify("f".repeat(40))).toEqual(all);
  expect(classify(workspace.git("rev-parse", "HEAD"), "push")).toEqual(all);
  const beforeDelete = workspace.git("rev-parse", "HEAD");
  workspace.git("rm", "packages/client/package.json");
  workspace.git("commit", "-m", "Remove workspace manifest");
  expect(classify(beforeDelete)).toEqual(all);
});

test("the required CI gate rejects failures, cancellations, missing results and unplanned skips", async ({
  workspace,
}) => {
  const workflow = JSON.parse(
    workspace.run("bun", [
      "-e",
      "console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))",
      join(repository, ".github/workflows/checks.yml"),
    ]),
  ) as { jobs: Record<string, { needs?: string[]; steps: { run?: string }[] }> };
  const gate = workflow.jobs.check;
  if (!gate?.needs || !gate.steps[0]?.run) throw new Error("Missing required CI gate");
  expect([...gate.needs].sort()).toEqual(
    Object.keys(workflow.jobs)
      .filter((job) => job !== "check")
      .sort(),
  );
  workspace.write("gate.sh", gate.steps[0].run);
  const flags = { coverage: "true", desktop: "true", server: "true" };
  const results: Record<string, { result: string; outputs?: typeof flags }> = Object.fromEntries(
    gate.needs.map((job) => [job, { result: "success" }]),
  );
  results.changes = { result: "success", outputs: flags };
  const run = () => workspace.command("bash", ["gate.sh"], { RESULTS: JSON.stringify(results) });
  expect(run().status).toBe(0);
  for (const job of gate.needs) {
    for (const state of ["failure", "cancelled", "skipped", ""]) {
      results[job] = { ...results[job], result: state };
      expect(run().status, `${job}: ${state}`).not.toBe(0);
    }
    results[job] = { ...results[job], result: "success" };
  }
  results.changes = {
    result: "success",
    outputs: { coverage: "false", desktop: "false", server: "false" },
  };
  for (const job of gate.needs.filter((job) => !["changes", "quality"].includes(job)))
    results[job] = { result: "skipped" };
  expect(run().status).toBe(0);
  results.quality = { result: "skipped" };
  expect(run().status).not.toBe(0);
  results.quality = { result: "success" };
  results.changes = { result: "success", outputs: { ...flags, desktop: "invalid" } };
  expect(run().status).not.toBe(0);
});

test("Playwright discovery assigns every E2E suite, selects product owners and fails on missing or unowned tests", async ({
  workspace,
}) => {
  cpSync(join(repository, "tests/e2e"), join(workspace.root, "tests/e2e"), { recursive: true });
  cpSync(join(repository, "playwright.config.ts"), join(workspace.root, "playwright.config.ts"));
  for (const path of ["apps", "packages"]) {
    rmSync(join(workspace.root, path), { recursive: true });
    symlinkSync(join(repository, path), join(workspace.root, path), "junction");
  }
  // Discovery must resolve the same packages without starting servers or building either product.
  symlinkSync(join(repository, "node_modules"), join(workspace.root, "node_modules"), "junction");
  const discoverNative = (shard?: string) => {
    const result = workspace.command(
      "bun",
      [
        "run",
        "playwright",
        "test",
        "--list",
        "--project",
        "native",
        "--no-deps",
        ...(shard ? ["--shard", shard] : []),
      ],
      { LUMEN_BROWSER_PRODUCT: "source" },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.split("\n").filter((line) => line.includes("[native]"));
  };
  const native = discoverNative();
  const shards = [1, 2, 3].flatMap((shard) => discoverNative(`${shard}/3`));
  expect(shards.length).toBeGreaterThan(0);
  expect(new Set(shards).size).toBe(shards.length);
  expect(shards.sort()).toEqual(native.sort());
  for (const product of ["source", "server", "desktop"]) {
    const result = workspace.command("bun", ["run", "playwright", "test", "--list"], {
      LUMEN_BROWSER_PRODUCT: product,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("mixed-playback.e2e.ts");
    expect(result.stdout).toContain("release-tooling.e2e.ts");
    if (product === "desktop") {
      expect(result.stdout).not.toContain("browser-journeys.e2e.ts");
      expect(result.stdout).not.toContain("browser-groups.e2e.ts");
      expect(result.stdout).not.toContain("watch-transport.e2e.ts");
      expect(result.stdout).not.toContain("catalog.e2e.ts");
    } else {
      for (const browser of ["chromium", "firefox", "webkit"])
        expect(result.stdout).toContain(`[${browser}]`);
    }
  }
  workspace.write("tests/unowned.test.ts", "");
  expect(workspace.command("bun", ["run", "playwright", "test", "--list"]).stderr).toContain(
    "no verification owner",
  );
  rmSync(join(workspace.root, "tests/unowned.test.ts"));
  workspace.write("tests/e2e/unowned.spec.ts", "");
  expect(workspace.command("bun", ["run", "playwright", "test", "--list"]).stderr).toContain(
    "no verification owner",
  );
  rmSync(join(workspace.root, "tests/e2e/unowned.spec.ts"));
  rmSync(join(workspace.root, "tests/e2e/authentication.e2e.ts"));
  expect(workspace.command("bun", ["run", "playwright", "test", "--list"]).stderr).toContain(
    "Required test suites are missing",
  );
});

test("coverage CLI inventories unexecuted source, ignores helpers, replaces stale evidence and preserves failing process exits", async ({
  workspace,
}) => {
  const manifest = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
  workspace.write("package.json", {
    name: "coverage-fixture",
    private: true,
    type: "module",
    workspaces: ["apps/*", "packages/*"],
    devDependencies: manifest.devDependencies,
  });
  workspace.write(".gitignore", "node_modules/\ncoverage/\n");
  for (const app of ["web", "desktop"])
    workspace.write(`apps/${app}/package.json`, {
      name: `coverage-${app}`,
      type: "module",
      scripts: { build: "bun -e 'void 0'" },
    });
  workspace.write("apps/server/src/visible.ts", "export const answer = () => 42;\n");
  workspace.write("apps/server/src/forgotten.ts", "export const forgotten = () => 7;\n");
  workspace.write("apps/server/src/types.d.ts", "export interface OnlyAType { value: string }\n");
  workspace.write("tests/helper.ts", "export const helper = () => 1;\n");
  workspace.write(
    "scripts/exercise.ts",
    `import { answer } from "../apps/server/src/visible";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
if (answer() !== 42) throw new Error("Wrong answer");
writeFileSync(join(process.env.LUMEN_COVERAGE_DIR, "process.json"), JSON.stringify(globalThis.__coverage__));
process.exitCode = process.env.E2E_FORCE_FAILURE === "1" ? 1 : 0;
`,
  );
  workspace.write(
    "scripts/test-e2e.ts",
    `const child = Bun.spawn([process.execPath, "scripts/exercise.ts"], { stdio: ["ignore", "inherit", "inherit"], env: process.env }); process.exit(await child.exited);`,
  );
  workspace.write("coverage-baseline.json", { "apps/server": 0 });
  workspace.run("bun", ["install"]);
  const run = (extra = {}) => workspace.script("e2e-coverage", [], extra);
  const first = run();
  expect(first.status).toBe(1);
  const summary = () =>
    JSON.parse(readFileSync(join(workspace.root, "coverage/summary.json"), "utf8"));
  expect(summary().files["apps/server/src/forgotten.ts"].uncovered).toBeGreaterThan(0);
  expect(summary().files).not.toHaveProperty("tests/helper.ts");
  expect(summary().files["apps/server/src/types.d.ts"]).toBeUndefined();
  rmSync(join(workspace.root, "apps/server/src/forgotten.ts"));
  const passing = run();
  expect(passing.status, passing.stderr).toBe(0);
  workspace.write("coverage/raw/stale.json", "not JSON");
  const failed = run({ E2E_FORCE_FAILURE: "1" });
  expect(failed.status).toBe(1);
  expect(summary().testsExitCode).toBe(1);
  expect(summary().regressions).toEqual([]);
  const collected = workspace.script("e2e-coverage", ["collect", "api"]);
  expect(collected.status, collected.stderr).toBe(0);
  const shard = JSON.parse(readFileSync(join(workspace.root, "coverage/shards/api.json"), "utf8"));
  expect(shard).toMatchObject({
    project: "api",
    revision: workspace.git("rev-parse", "HEAD"),
    testsExitCode: 0,
  });
  expect(shard.covered["apps/server/src/visible.ts"]).not.toHaveLength(0);
  expect(workspace.script("e2e-coverage", ["collect", "missing-project"]).status).not.toBe(0);
});

test("coverage merging requires every successful same-revision shard and unions hits without relaxing budgets", async ({
  workspace,
}) => {
  const projects = ["api", "chromium", "firefox", "webkit", "native"];
  const source = "apps/server/src/example.ts";
  const shard = {
    revision: workspace.git("rev-parse", "HEAD"),
    sourceHash: "matching-production-source",
    testsExitCode: 0,
    inventory: { [source]: { lines: [1, 2, 3], statementLines: { 0: 1, 1: 2, 2: 3 } } },
  };
  workspace.write("coverage-baseline.json", { "apps/server": 0 });
  const save = (project: string, overrides = {}) =>
    workspace.write(`coverage/shards/${project}.json`, {
      ...shard,
      project,
      covered: { [source]: project === "api" ? [1, 2] : [2, 3] },
      ...overrides,
    });
  const merge = () => workspace.script("e2e-coverage", ["merge"]);
  for (const project of projects.slice(0, -1)) save(project);
  expect(merge().status).not.toBe(0);
  save("native");
  expect(merge().status).toBe(0);
  const summary = JSON.parse(readFileSync(join(workspace.root, "coverage/summary.json"), "utf8"));
  expect(summary.workspaces["apps/server"]).toEqual({ total: 3, covered: 3, uncovered: 0 });
  for (const invalid of [
    { testsExitCode: 1 },
    { revision: "old-commit" },
    { project: "api" },
    { sourceHash: "different-source" },
    { inventory: { [source]: { lines: [1], statementLines: { 0: 1 } } } },
    { covered: {} },
    { covered: { [source]: [99] } },
  ]) {
    save("native", invalid);
    expect(merge().status).not.toBe(0);
  }
  for (const project of projects) save(project, { covered: { [source]: [1] } });
  expect(merge().status).not.toBe(0);
  expect(
    JSON.parse(readFileSync(join(workspace.root, "coverage/summary.json"), "utf8")).regressions,
  ).toEqual(["apps/server: 2 uncovered lines exceeds baseline 0"]);
});

test("the enforced Biome command rejects test delays and permits observable waits and application timers", async ({
  workspace,
}) => {
  for (const path of ["biome.json", "tooling"])
    cpSync(join(repository, path), join(workspace.root, path), { recursive: true });
  const biome = join(repository, "node_modules/.bin/biome");
  for (const source of [
    "setTimeout(() => {}, 10);",
    "await Bun.sleep(10);",
    "await page.waitForTimeout(10);",
  ]) {
    workspace.write("tests/example.e2e.ts", source);
    expect(workspace.command(biome, ["check", "tests/example.e2e.ts"]).status).not.toBe(0);
  }
  workspace.write("tests/example.e2e.ts", "await expect.poll(readiness).toBe(true);\n");
  expect(workspace.command(biome, ["check", "tests/example.e2e.ts"]).status).toBe(0);
  workspace.write("apps/server/src/timer.ts", "setTimeout(() => {}, 10);\n");
  expect(workspace.command(biome, ["check", "apps/server/src/timer.ts"]).status).toBe(0);
});

for (const product of ["server", "desktop"] as const)
  test(`released-counterpart runner loads candidate ${product}, stable dependencies and fails on candidate regressions`, async ({
    workspace,
  }) => {
    const candidate = join(workspace.root, "candidate");
    const released = join(workspace.root, "released");
    const counterpart = product === "server" ? "desktop" : "server";
    for (const tree of ["candidate", "released"])
      for (const name of [
        "apps/server",
        "apps/desktop",
        "apps/web",
        "packages/database",
        "packages/client",
        "packages/contracts",
      ]) {
        workspace.write(`${tree}/${name}/package.json`, { type: "module" });
        const broken =
          tree === "candidate" &&
          (name === `apps/${counterpart}` ||
            (product === "desktop" && ["apps/web", "packages/database"].includes(name)));
        workspace.write(
          `${tree}/${name}/index.ts`,
          broken
            ? 'throw new Error("Unreleased counterpart regression");'
            : `export const version = "${tree}";`,
        );
      }
    workspace.write("candidate/package.json", { type: "module" });
    const supportFiles = [
      ".github/rulesets/main.json",
      "biome.json",
      "tooling/test-policy.grit",
      "tsconfig.scripts.json",
    ];
    for (const path of supportFiles) {
      workspace.write(`candidate/${path}`, "candidate test support");
      workspace.write(`released/${path}`, "released test support");
    }
    workspace.write(
      "candidate/tests/e2e/check.ts",
      `
import { readFileSync } from "node:fs";
import { version as own } from "../../apps/${product}/index";
import { version as other } from "../../apps/${counterpart}/index";
import { version as client } from "../../packages/client/index";
import { version as database } from "../../packages/database/index";
if (own !== "candidate" || other !== "released" || client !== "candidate" || database !== "${product === "server" ? "candidate" : "released"}") throw new Error("Wrong dependency versions");
for (const path of ${JSON.stringify(supportFiles)})
  if (readFileSync(new URL("../../" + path, import.meta.url), "utf8") !== "candidate test support") throw new Error("Wrong test support: " + path);
console.log("candidate and released versions verified");`,
    );
    workspace.write(
      "scripts/verify-fixture.ts",
      `
import { createVerificationWorkspace } from "./lib/verification-workspace";
createVerificationWorkspace({ product: ${JSON.stringify(product)}, candidate: ${JSON.stringify(candidate)}, released: ${JSON.stringify(released)}, workspace: ${JSON.stringify(join(workspace.root, "verification"))} });
`,
    );
    expect(workspace.script("verify-fixture", []).status).toBe(0);
    const run = () => workspace.command("bun", ["verification/tests/e2e/check.ts"]);
    expect(run()).toMatchObject({
      status: 0,
      stdout: "candidate and released versions verified\n",
    });
    workspace.write(
      `candidate/apps/${product}/index.ts`,
      'throw new Error("Candidate regression"); export const version = "candidate";',
    );
    expect(run().status).not.toBe(0);
    expect(run().stderr).toContain("Candidate regression");
  });

for (const product of ["server", "desktop"]) {
  test(`${product} verification CLI rejects owned lint, type and build failures without building the other product`, async ({
    workspace,
  }) => {
    for (const path of ["biome.json", "tooling", "tsconfig.base.json", "tsconfig.scripts.json"])
      cpSync(join(repository, path), join(workspace.root, path), { recursive: true });
    symlinkSync(join(repository, "node_modules"), join(workspace.root, "node_modules"), "junction");
    for (const name of [
      "apps/server",
      "apps/desktop",
      "apps/web",
      "packages/contracts",
      "packages/database",
      "packages/client",
      "packages/ui",
      "packages/app",
      "packages/config",
    ]) {
      workspace.write(`${name}/package.json`, {
        name: name.replace("/", "-"),
        type: "module",
        scripts: {
          build: "bun build ./src/index.ts --outdir dist",
          typecheck: "bun ../../scripts/typecheck.ts -p tsconfig.json",
        },
      });
      workspace.write(`${name}/tsconfig.json`, {
        extends: "../../tsconfig.base.json",
        include: ["src/**/*.ts"],
        compilerOptions: { types: ["bun"] },
      });
      workspace.write(`${name}/src/index.ts`, 'export const value: string = "valid";\n');
    }
    workspace.write("tests/e2e/placeholder.ts", 'export const helper = "valid";\n');
    const other = product === "server" ? "desktop" : "server";
    workspace.write(`apps/${other}/src/index.ts`, 'import "./unreleased-missing-module";\n');
    expect(workspace.script("check", [product, "build"]).status).toBe(0);
    for (const [step, source, diagnostic] of [
      ["lint", 'export const value: any = "invalid";\n', "noExplicitAny"],
      ["typecheck", "export const value: string = 1;\n", "TS2322"],
      ["build", 'import "./missing-build-input";\n', "missing-build-input"],
    ] as const) {
      workspace.write(`apps/${product}/src/index.ts`, source);
      const result = workspace.script("check", [product, step]);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(diagnostic);
      expect(result.stdout + result.stderr).not.toContain("unreleased-missing-module");
    }
    workspace.write(`apps/${product}/src/index.ts`, 'export const value: string = "valid";\n');
    workspace.write("packages/contracts/src/index.ts", "export const value: string = 1;\n");
    const sharedFailure = workspace.script("check", [product, "typecheck"]);
    expect(sharedFailure.status).not.toBe(0);
    expect(sharedFailure.stdout + sharedFailure.stderr).toContain("TS2322");
  });
}

test("release builds start after validation and publication remains gated by every verification job", async ({
  workspace,
}) => {
  type Job = {
    needs?: string | string[];
    if?: string;
    uses?: string;
    steps?: { uses?: string; run?: string }[];
  };
  const workflow = (name: string) =>
    JSON.parse(
      workspace.run("bun", [
        "-e",
        "console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))",
        join(repository, `.github/workflows/${name}.yml`),
      ]),
    ) as { jobs: Record<string, Job> };
  const preflight = workflow("release-preflight");
  expect(Object.keys(preflight.jobs)).toEqual(["validate"]);
  expect(preflight.jobs.validate?.steps?.map((step) => step.uses).filter(Boolean)).toEqual([
    "actions/checkout@v4",
    "oven-sh/setup-bun@v2",
  ]);
  const verify = workflow("release-verify");
  expect(Object.keys(verify.jobs).sort()).toEqual(["browser", "product"]);
  for (const job of Object.values(verify.jobs)) {
    expect(job.needs).toBeUndefined();
    expect(job.if).toBeUndefined();
  }
  for (const product of ["desktop", "server"]) {
    const { jobs } = workflow(`release-${product}`);
    expect(jobs.verify?.uses).toBe("./.github/workflows/release-verify.yml");
    const parallel =
      product === "desktop" ? ["verify", "native-desktop", "package"] : ["verify", "server-image"];
    for (const name of parallel) expect(jobs[name]?.needs).toBe("preflight");
    const dependencies = (name: string): string[] => {
      const needs = jobs[name]?.needs ?? [];
      return typeof needs === "string" ? [needs] : needs;
    };
    const ancestors = (name: string): string[] =>
      dependencies(name).flatMap((dependency) => [dependency, ...ancestors(dependency)]);
    const publishers =
      product === "desktop" ? ["publish"] : ["server-manifest", "publish", "promote"];
    for (const publisher of publishers) {
      expect(ancestors(publisher)).toEqual(expect.arrayContaining(["preflight", ...parallel]));
      // An always() or !cancelled() override could publish after a failed prerequisite.
      expect(jobs[publisher]?.if ?? "").not.toMatch(/always\(|cancelled\(|failure\(/);
    }
  }
});

test("server manifest rejects incomplete or corrupt digests before tagging and exports the combined digest", async ({
  workspace,
}) => {
  const workflow = JSON.parse(
    workspace.run("bun", [
      "-e",
      "console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))",
      join(repository, ".github/workflows/release-server.yml"),
    ]),
  ) as { jobs: Record<string, { steps: { id?: string; run?: string }[] }> };
  const script = workflow.jobs["server-manifest"]?.steps.find(
    (step) => step.id === "manifest",
  )?.run;
  if (!script) throw new Error("Missing manifest publication step");
  workspace.write("manifest.sh", script);
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  const digest = `sha256:${"c".repeat(64)}`;
  const run = (files: string[], result = digest) => {
    rmSync(join(workspace.root, "digests"), { recursive: true, force: true });
    workspace.write("digests/.keep", "");
    for (const file of files) workspace.write(`digests/${file}`, "");
    workspace.write("docker-calls", "");
    workspace.write("output", "");
    return workspace.command(
      "bash",
      [
        "-c",
        `docker() {
          printf '%s\\n' "$*" >> "$CALLS"
          if [[ "$*" == *inspect* ]]; then printf '{"digest":"%s"}\\n' "$MANIFEST_DIGEST"; fi
        }
        export -f docker
        cd digests
        bash -e -o pipefail ../manifest.sh`,
      ],
      {
        IMAGE: "ghcr.io/example/lumen-server",
        VERSION: "1.2.3-rc.1",
        GITHUB_SHA: "d".repeat(40),
        GITHUB_OUTPUT: join(workspace.root, "output"),
        CALLS: join(workspace.root, "docker-calls"),
        MANIFEST_DIGEST: result,
      },
    );
  };
  for (const files of [[], [first], [first, "invalid"], [first, second, "e".repeat(64)]]) {
    expect(run(files).status).not.toBe(0);
    expect(readFileSync(join(workspace.root, "docker-calls"), "utf8")).toBe("");
  }
  const result = run([first, second]);
  expect(result.status, result.stderr).toBe(0);
  const calls = readFileSync(join(workspace.root, "docker-calls"), "utf8");
  expect(calls).toContain("--tag ghcr.io/example/lumen-server:1.2.3-rc.1");
  expect(calls).toContain(`--tag ghcr.io/example/lumen-server:sha-${"d".repeat(40)}`);
  for (const hash of [first, second])
    expect(calls).toContain(`ghcr.io/example/lumen-server@sha256:${hash}`);
  expect(calls).not.toContain(":latest");
  expect(readFileSync(join(workspace.root, "output"), "utf8")).toBe(`digest=${digest}\n`);
  expect(run([first, second], "invalid").status).not.toBe(0);
  expect(readFileSync(join(workspace.root, "output"), "utf8")).toBe("");
});
