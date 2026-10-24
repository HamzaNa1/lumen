import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "@babel/core";
import { eachMapping, TraceMap } from "@jridgewell/trace-mapping";
import { createInstrumenter } from "istanbul-lib-instrument";
import {
  coverageProjects,
  type FileInventory,
  mergeCoverage,
  writeCoverageReport,
} from "./lib/e2e-coverage";

const root = process.cwd();
const [command, project, ...extra] = process.argv.slice(2);
if (
  extra.length ||
  (command !== undefined && command !== "collect" && command !== "merge") ||
  (command === "collect" && !coverageProjects.includes(project ?? "")) ||
  (command !== "collect" && project !== undefined)
)
  throw new Error("Usage: bun scripts/e2e-coverage.ts [collect <project>|merge]");
if (command === "merge") {
  process.exitCode = await mergeCoverage(root);
} else {
  await collect();
}
async function collect() {
  const output = resolve(root, "coverage");
  if (command !== "collect") await rm(output, { recursive: true, force: true });
  const raw = command === "collect" ? join(output, "raw", project ?? "") : join(output, "raw");
  await rm(raw, { recursive: true, force: true });
  await mkdir(raw, { recursive: true });
  if (command === "collect") {
    await mkdir(join(output, "shards"), { recursive: true });
    await rm(join(output, "shards", `${project}.json`), { force: true });
  }
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
  const inventory: Record<string, FileInventory> = {};
  const sources = createHash("sha256");
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
      const source = await readFile(join(root, path), "utf8");
      sources.update(path).update("\0").update(source).update("\0");
      const transformed = transformSync(source, {
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
    const env = { LUMEN_COVERAGE_DIR: raw, LUMEN_BROWSER_ARTIFACT_ROOT: root };
    for (const app of ["web", "desktop"])
      if ((await run(["run", "--cwd", `apps/${app}`, "build"], env)) !== 0)
        throw new Error("Instrumented build failed");
    const testsExitCode = await run(
      [
        "scripts/test-e2e.ts",
        "source",
        "--no-build",
        ...(project ? ["--project", project, "--no-deps"] : []),
      ],
      env,
    );
    const covered: Record<string, Set<number>> = {};
    for (const file of await readdir(raw)) {
      const payload = JSON.parse(await readFile(join(raw, file), "utf8")) as Record<
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
    if (!Object.keys(covered).length)
      throw new Error("E2E processes produced no coverage evidence");
    if (command === "collect") {
      await writeFile(
        join(output, "shards", `${project}.json`),
        JSON.stringify({
          project,
          revision: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
          }).trim(),
          sourceHash: sources.digest("hex"),
          testsExitCode,
          inventory,
          covered: Object.fromEntries(
            Object.entries(covered).map(([path, hits]) => [path, [...hits]]),
          ),
        }),
      );
      process.exitCode = testsExitCode;
    } else {
      process.exitCode = await writeCoverageReport(root, inventory, covered, testsExitCode);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
