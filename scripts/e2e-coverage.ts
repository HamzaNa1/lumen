import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "@babel/core";
import { eachMapping, TraceMap } from "@jridgewell/trace-mapping";
import { createInstrumenter } from "istanbul-lib-instrument";

if (process.argv.length > 2) throw new Error("Coverage requires the complete E2E suite.");
const root = process.cwd();
const output = resolve(root, "coverage");
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "raw"), { recursive: true });
const workspace = await mkdtemp(join(tmpdir(), "lumen-e2e-coverage-"));
const run = (args: string[], env = {}) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: workspace,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
interface FileInventory {
  lines: number[];
  statementLines: Record<string, number>;
}
const inventory: Record<string, FileInventory> = {};
try {
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter((path) => path !== "" && existsSync(join(root, path)));
  for (const path of files) {
    const source = join(root, path);
    try {
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await cp(source, join(workspace, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if ((await run(["install", "--frozen-lockfile"])) !== 0)
    throw new Error("Coverage dependency installation failed");
  const instrumenter = createInstrumenter({
    esModules: true,
    coverageGlobalScope: "globalThis",
    coverageGlobalScopeFunc: false,
    parserPlugins: ["jsx"],
    produceSourceMap: false,
  });
  for (const path of files.filter(
    (path) =>
      /^(apps|packages)\/[^/]+\/src\/.*\.[cm]?[jt]sx?$/.test(path) &&
      !/\.d\.ts$|generated|packages\/testkit\//.test(path),
  )) {
    const transformed = transformSync(await readFile(join(root, path), "utf8"), {
      filename: path,
      babelrc: false,
      configFile: false,
      sourceMaps: true,
      plugins: [
        [
          fileURLToPath(import.meta.resolve("@babel/plugin-transform-typescript")),
          { allExtensions: true, isTSX: /\.[jt]sx$/.test(path), onlyRemoveTypeImports: true },
        ],
      ],
    });
    if (!transformed?.code || !transformed.map) continue;
    const mappings: { line: number; column: number; source: number }[] = [];
    eachMapping(new TraceMap(JSON.stringify(transformed.map)), (mapping) => {
      if (mapping.originalLine !== null)
        mappings.push({
          line: mapping.generatedLine,
          column: mapping.generatedColumn,
          source: mapping.originalLine,
        });
    });
    const code = instrumenter.instrumentSync(transformed.code, path);
    const statementLines: Record<string, number> = {};
    for (const [id, { start, end }] of Object.entries(
      instrumenter.lastFileCoverage().statementMap,
    )) {
      const mapping = mappings.find(
        (mapping) =>
          (mapping.line > start.line ||
            (mapping.line === start.line && mapping.column >= start.column)) &&
          (mapping.line < end.line || (mapping.line === end.line && mapping.column < end.column)),
      );
      if (mapping) statementLines[id] = mapping.source;
    }
    inventory[path] = {
      lines: [...new Set(Object.values(statementLines))].sort((a, b) => a - b),
      statementLines,
    };
    await writeFile(join(workspace, path), code);
  }
  const env = { LUMEN_COVERAGE_DIR: join(output, "raw"), LUMEN_BROWSER_ARTIFACT_ROOT: root };
  for (const app of ["web", "desktop"])
    if ((await run(["run", "--cwd", `apps/${app}`, "build"], env)) !== 0)
      throw new Error("Instrumented build failed");
  const testsExitCode = await run(["scripts/test-e2e.ts", "source", "--no-build"], env);
  const covered: Record<string, Set<number>> = {};
  for (const file of await readdir(join(output, "raw"))) {
    const payload = JSON.parse(await readFile(join(output, "raw", file), "utf8")) as Record<
      string,
      { s: Record<string, number> }
    >;
    for (const [path, counters] of Object.entries(payload)) {
      const source = inventory[path];
      if (!source) continue;
      const hits = covered[path] ?? new Set<number>();
      covered[path] = hits;
      for (const [id, count] of Object.entries(counters.s))
        if (count > 0 && source.statementLines[id]) hits.add(source.statementLines[id]);
    }
  }
  if (!Object.keys(covered).length) throw new Error("E2E processes produced no coverage evidence");
  const workspaces: Record<string, { total: number; covered: number; uncovered: number }> = {};
  const lcov: string[] = [];
  const summary: Record<string, { total: number; covered: number; uncovered: number }> = {};
  for (const [path, { lines }] of Object.entries(inventory)) {
    const hit = covered[path] ?? new Set();
    const counts = { total: lines.length, covered: hit.size, uncovered: lines.length - hit.size };
    summary[path] = counts;
    const product = path.split("/").slice(0, 2).join("/");
    const total = workspaces[product] ?? { total: 0, covered: 0, uncovered: 0 };
    workspaces[product] = total;
    for (const key of ["total", "covered", "uncovered"] as const) total[key] += counts[key];
    lcov.push(
      `SF:${path}`,
      ...lines.map((line) => `DA:${line},${hit.has(line) ? 1 : 0}`),
      `LF:${counts.total}`,
      `LH:${counts.covered}`,
      "end_of_record",
    );
  }
  const budgets = JSON.parse(
    await readFile(join(root, "coverage-baseline.json"), "utf8"),
  ) as Record<string, number>;
  if (Object.values(budgets).some((value) => !Number.isInteger(value) || value < 0))
    throw new Error("Invalid uncovered-line budgets");
  const regressions = Object.entries(workspaces)
    .filter(([path, totals]) => totals.uncovered > (budgets[path] ?? 0))
    .map(
      ([path, totals]) =>
        `${path}: ${totals.uncovered} uncovered lines exceeds baseline ${budgets[path] ?? 0}`,
    );
  await writeFile(join(output, "lcov.info"), `${lcov.join("\n")}\n`);
  await writeFile(
    join(output, "summary.json"),
    JSON.stringify(
      { metric: "statement-start-lines", testsExitCode, files: summary, workspaces, regressions },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(workspaces, null, 2));
  for (const regression of regressions) console.error(regression);
  process.exitCode = testsExitCode !== 0 || regressions.length ? 1 : 0;
} finally {
  await rm(workspace, { recursive: true, force: true });
}
