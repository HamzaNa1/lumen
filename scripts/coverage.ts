import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "@babel/core";
import { eachMapping, TraceMap } from "@jridgewell/trace-mapping";
import { createInstrumenter } from "istanbul-lib-instrument";

if (process.argv.length > 2)
  throw new Error("Coverage requires the full suite; use bun test for focused runs.");

const root = process.cwd();
const output = resolve(root, "coverage");
// Never let an interrupted or failed run reuse another run's evidence.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const tests = Bun.spawn(
  [
    process.execPath,
    "test",
    "--coverage",
    "--coverage-reporter=lcov",
    "--coverage-dir=coverage/raw",
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
const testsExitCode = await tests.exited;

const hits = new Map<string, Map<number, number>>();
let current: Map<number, number> | undefined;
const raw = await readFile(resolve(output, "raw/lcov.info"), "utf8");
for (const entry of raw.split(/\r?\n/u)) {
  if (entry.startsWith("SF:")) {
    const source = entry.slice(3);
    const path = (isAbsolute(source) ? relative(root, source) : source).replaceAll("\\", "/");
    current = hits.get(path) ?? new Map();
    hits.set(path, current);
  } else if (entry.startsWith("DA:")) {
    const [line, count] = entry.slice(3).split(",").map(Number);
    if (
      line === undefined ||
      count === undefined ||
      !current ||
      !Number.isInteger(line) ||
      line < 1 ||
      !Number.isFinite(count) ||
      count < 0
    )
      throw new Error(`Invalid LCOV entry: ${entry}`);
    current.set(line, Math.max(current.get(line) ?? 0, count));
  } else if (entry === "end_of_record") current = undefined;
}
if (hits.size === 0) throw new Error("Bun produced no coverage records.");

interface Totals {
  total: number;
  covered: number;
  uncovered: number;
}
const files: Record<string, Totals & { loaded: boolean }> = {};
const workspaces: Record<string, Totals> = {};
const lcov: string[] = [];
const instrumenter = createInstrumenter({
  parserPlugins: ["jsx"],
  produceSourceMap: false,
});
const excluded = [
  "packages/testkit/**",
  "**/*.d.{ts,mts,cts}",
  "**/*.{test,spec,e2e,generated}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
  "**/{__tests__,__fixtures__,generated,node_modules,dist,out}/**",
].map((pattern) => new Bun.Glob(pattern));
const sourceFiles: string[] = [];
for await (const path of new Bun.Glob(
  "{apps,packages}/*/src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
).scan(root)) {
  if (!excluded.some((pattern) => pattern.match(path))) sourceFiles.push(path);
}
if (sourceFiles.length === 0) throw new Error("No production source files found.");
for (const path of sourceFiles.sort()) {
  // Lower runtime TypeScript and exports without executing modules. Parsing TypeScript alone
  // misses enums/parameter properties; leaving export-default expressions intact misses those too.
  const transformed = transformSync(await readFile(resolve(root, path), "utf8"), {
    filename: path,
    babelrc: false,
    configFile: false,
    sourceMaps: true,
    plugins: [
      [
        fileURLToPath(import.meta.resolve("@babel/plugin-transform-typescript")),
        { allExtensions: true, isTSX: /\.[jt]sx$/u.test(path), onlyRemoveTypeImports: true },
      ],
      fileURLToPath(import.meta.resolve("@babel/plugin-transform-modules-commonjs")),
    ],
  });
  if (transformed?.code == null || !transformed.map)
    throw new Error(`Cannot inventory source: ${path}`);
  const sourceMap = new TraceMap(JSON.stringify(transformed.map));
  const mappings: { line: number; column: number; sourceLine: number }[] = [];
  eachMapping(sourceMap, (mapping) => {
    if (mapping.originalLine !== null)
      mappings.push({
        line: mapping.generatedLine,
        column: mapping.generatedColumn,
        sourceLine: mapping.originalLine,
      });
  });
  instrumenter.instrumentSync(transformed.code, path);
  const lines = [
    ...new Set(
      Object.values(instrumenter.lastFileCoverage().statementMap)
        .map(
          ({ start, end }) =>
            mappings.find(
              (mapping) =>
                (mapping.line > start.line ||
                  (mapping.line === start.line && mapping.column >= start.column)) &&
                (mapping.line < end.line ||
                  (mapping.line === end.line && mapping.column < end.column)),
            )?.sourceLine,
        )
        .filter((line): line is number => line !== undefined),
    ),
  ].sort((a, b) => a - b);
  const measured = hits.get(path);
  const covered = lines.filter((line) => (measured?.get(line) ?? 0) > 0).length;
  const total = lines.length;
  files[path] = { total, covered, uncovered: total - covered, loaded: measured !== undefined };
  const workspace = path.split("/").slice(0, 2).join("/");
  const totals = workspaces[workspace] ?? { total: 0, covered: 0, uncovered: 0 };
  totals.total += total;
  totals.covered += covered;
  totals.uncovered += total - covered;
  workspaces[workspace] = totals;
  lcov.push(
    `SF:${path}`,
    ...lines.map((line) => `DA:${line},${measured?.get(line) ?? 0}`),
    `LF:${total}`,
    `LH:${covered}`,
    "end_of_record",
  );
}

const baseline: unknown = JSON.parse(
  await readFile(resolve(root, "coverage-baseline.json"), "utf8"),
);
if (
  baseline === null ||
  typeof baseline !== "object" ||
  Array.isArray(baseline) ||
  Object.values(baseline).some((budget) => !Number.isInteger(budget) || budget < 0)
) {
  throw new Error(
    "coverage-baseline.json must map workspaces to nonnegative uncovered-line budgets.",
  );
}
const budgets = baseline as Record<string, number>;
const regressions: string[] = [];
for (const [workspace, totals] of Object.entries(workspaces)) {
  const budget = budgets[workspace] ?? 0;
  console.log(
    `${workspace}: ${totals.covered}/${totals.total} statement lines covered; ${totals.uncovered} uncovered (baseline ${budget})`,
  );
  if (totals.uncovered > budget)
    regressions.push(
      `${workspace}: ${totals.uncovered} uncovered lines exceeds baseline ${budget}`,
    );
}
await writeFile(resolve(output, "lcov.info"), `${lcov.join("\n")}\n`);
await writeFile(
  resolve(output, "summary.json"),
  `${JSON.stringify({ metric: "statement-start-lines", testsExitCode, files, workspaces, regressions }, null, 2)}\n`,
);
for (const regression of regressions) console.error(regression);
process.exitCode = testsExitCode !== 0 || regressions.length > 0 ? 1 : 0;
