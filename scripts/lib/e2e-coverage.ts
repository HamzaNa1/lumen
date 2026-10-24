import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const coverageProjects: readonly string[] = [
  "api",
  "chromium",
  "firefox",
  "webkit",
  "native",
];
export interface FileInventory {
  lines: number[];
  statementLines: Record<string, number>;
}
interface CoverageShard {
  project: string;
  revision: string;
  sourceHash: string;
  testsExitCode: number;
  inventory: Record<string, FileInventory>;
  covered: Record<string, number[]>;
}

export async function mergeCoverage(root: string): Promise<number> {
  for (const file of ["summary.json", "lcov.info"])
    await rm(join(root, "coverage", file), { force: true });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  let reference: CoverageShard | undefined;
  const covered: Record<string, Set<number>> = {};
  for (const project of coverageProjects) {
    const shard: CoverageShard = JSON.parse(
      await readFile(join(root, "coverage/shards", `${project}.json`), "utf8"),
    );
    if (shard.project !== project || shard.revision !== revision || shard.testsExitCode !== 0)
      throw new Error(`Invalid or unsuccessful coverage shard: ${project}`);
    if (
      !shard.sourceHash ||
      !Object.keys(shard.inventory).length ||
      !Object.keys(shard.covered).length
    )
      throw new Error(`Empty coverage shard: ${project}`);
    reference ??= shard;
    if (
      shard.sourceHash !== reference.sourceHash ||
      !isDeepStrictEqual(shard.inventory, reference.inventory)
    )
      throw new Error(`Coverage sources differ: ${project}`);
    for (const [path, lines] of Object.entries(shard.covered)) {
      const source = shard.inventory[path];
      if (!source || lines.some((line) => !source.lines.includes(line)))
        throw new Error(`Unknown covered source line: ${project}/${path}`);
      const hits = covered[path] ?? new Set<number>();
      covered[path] = hits;
      for (const line of lines) hits.add(line);
    }
  }
  if (!reference) throw new Error("No coverage shards");
  return writeCoverageReport(root, reference.inventory, covered, 0);
}

export async function writeCoverageReport(
  root: string,
  inventory: Record<string, FileInventory>,
  covered: Record<string, Set<number>>,
  testsExitCode: number,
): Promise<number> {
  const output = join(root, "coverage");
  await mkdir(output, { recursive: true });
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
  return testsExitCode !== 0 || regressions.length ? 1 : 0;
}
