import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Durations, durationsPath, suites } from "./lib/verification";

// Refreshes the suite durations that shard plans weigh from CI runs' Playwright reports:
// bun scripts/record-test-durations.ts <run-id>...
type Report = { suites?: ReportSuite[] };
type ReportSuite = {
  title: string;
  file: string;
  suites?: ReportSuite[];
  specs?: {
    title: string;
    tests: { projectName: string; results: { duration: number; status?: string }[] }[];
  }[];
};

const runs = process.argv.slice(2);
if (runs.length === 0 || runs.some((run) => !/^\d+$/.test(run)))
  throw new Error("Pass one or more GitHub Actions run ids.");
const directory = mkdtempSync(join(tmpdir(), "lumen-test-durations-"));
// Shards and platforms each report part of a project, so average per test before summing per file.
const samples = new Map<string, { project: string; file: string; total: number; count: number }>();
const collect = (suite: ReportSuite, path: string[]) => {
  for (const spec of suite.specs ?? [])
    for (const test of spec.tests)
      for (const result of test.results) {
        if (result.status === "skipped") continue;
        const key = JSON.stringify([test.projectName, suite.file, ...path, spec.title]);
        const sample = samples.get(key) ?? {
          project: test.projectName,
          file: suite.file,
          total: 0,
          count: 0,
        };
        sample.total += result.duration;
        sample.count += 1;
        samples.set(key, sample);
      }
  for (const child of suite.suites ?? []) collect(child, [...path, child.title]);
};
try {
  for (const run of runs)
    execFileSync(
      "gh",
      ["run", "download", run, "--pattern", "e2e-*", "--dir", join(directory, run)],
      {
        stdio: "inherit",
      },
    );
  for (const path of readdirSync(directory, { recursive: true }).map(String))
    if (path.endsWith("results.json")) {
      const report: Report = JSON.parse(readFileSync(join(directory, path), "utf8"));
      for (const suite of report.suites ?? []) collect(suite, []);
    }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

const measured: Durations = {};
for (const { project, file, total, count } of samples.values()) {
  measured[project] ??= {};
  measured[project][file] = (measured[project][file] ?? 0) + total / count / 1000;
}
const previous: Durations = existsSync(durationsPath)
  ? JSON.parse(readFileSync(durationsPath, "utf8"))
  : {};
const durations: Durations = {};
for (const project of [...new Set([...Object.keys(previous), ...Object.keys(measured)])].sort()) {
  const files = { ...previous[project], ...measured[project] };
  durations[project] = Object.fromEntries(
    Object.keys(files)
      .filter((file) => file in suites)
      .sort()
      .map((file) => [file, Math.round(files[file] ?? 0)]),
  );
}
writeFileSync(durationsPath, `${JSON.stringify(durations, null, 2)}\n`);
console.log(`Recorded ${samples.size} test durations in ${durationsPath}`);
