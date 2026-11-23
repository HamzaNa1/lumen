import argparse
import datetime
import json
import os
from pathlib import Path
import platform
import re
import statistics
import subprocess
import time


parser = argparse.ArgumentParser(description="Compare E2E runner wall time between two checkouts on macOS.")
parser.add_argument("--before", type=Path, required=True)
parser.add_argument("--after", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--runs", type=int, default=3)
parser.add_argument("--only", nargs="*", help="Run only these scenarios")
args = parser.parse_args()
if platform.system() != "Darwin" or args.runs < 1:
    parser.error("Requires macOS /usr/bin/time -l and at least one measured run.")

# Both checkouts must have dependencies installed, apps/web built, and apps/desktop built for native.
roots = {"before": args.before.resolve(), "after": args.after.resolve()}
env = {key: value for key, value in os.environ.items() if key != "CI"}
# Flashwright replaces the list reporter for coding agents and keeps a warm session between local
# runs; both are off so each sample is a cold run with the reporters Playwright uses.
env.update(FLASHWRIGHT_AGENT_MODE="0", FLASHWRIGHT_SESSION="0")
runner = ["bun", "scripts/test-e2e.ts", "source", "--no-deps", "--no-build"]
scenarios = {
    "tooling": ["--project", "tooling"],
    "api": ["--project", "api"],
    "chromium": ["--project", "chromium"],
    "native": ["client-parity.e2e.ts", "desktop-artwork.e2e.ts", "desktop-updates.e2e.ts", "--project", "native"],
    "single-test": ["browser-journeys.e2e.ts", "--project", "chromium", "-g", "administrators configure transcoding"],
}
if args.only:
    scenarios = {name: scenarios[name] for name in args.only}


def capture(command, cwd=None):
    return subprocess.check_output(command, cwd=cwd, env=env, text=True).strip()


result = {
    "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "host": {
        "os": capture(["sw_vers", "-productVersion"]),
        "cpu": capture(["sysctl", "-n", "machdep.cpu.brand_string"]),
        "logical_cpus": int(capture(["sysctl", "-n", "hw.ncpu"])),
        "memory_bytes": int(capture(["sysctl", "-n", "hw.memsize"])),
        "bun": capture(["bun", "--version"]),
        "node": capture(["node", "--version"]),
    },
    "runners": {variant: capture(["bun", "run", "playwright", "--version"], root) for variant, root in roots.items()},
    "commits": {variant: capture(["git", "rev-parse", "HEAD"], root) for variant, root in roots.items()},
    "method": {
        "warmups_per_variant_per_scenario": 1,
        "measured_runs_per_variant_per_scenario": args.runs,
        "order": "before/after on even rounds, after/before on odd rounds; sequential",
        "wall_time": "Python monotonic clock around /usr/bin/time -l of the runner, excluding builds",
        "cpu_time": "user + system seconds from /usr/bin/time -l for the reaped process tree",
        "runner_duration": "stats.duration from the Playwright JSON reporter",
    },
    "scenarios": {},
}

for name, scenario in scenarios.items():
    samples = {variant: [] for variant in roots}
    for round_index in range(-1, args.runs):
        variants = ["before", "after"] if round_index % 2 == 0 else ["after", "before"]
        for variant in variants:
            started = time.perf_counter()
            completed = subprocess.run(
                ["/usr/bin/time", "-l", *runner, *scenario],
                cwd=roots[variant], env=env, capture_output=True, text=True,
            )
            elapsed = time.perf_counter() - started
            report = json.loads((roots[variant] / "test-results/source/results.json").read_text())
            stats = report["stats"]
            if completed.returncode != 0 or stats["unexpected"] or stats["flaky"]:
                raise RuntimeError(f"{name} {variant} failed:\n{completed.stdout[-4000:]}\n{completed.stderr[-4000:]}")
            cpu = re.search(r"([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys", completed.stderr)
            if cpu is None:
                raise RuntimeError(f"Missing CPU measurement: {completed.stderr[-2000:]}")
            print(f"{name} {variant} {'warmup' if round_index == -1 else round_index + 1}: {elapsed:.2f}s", flush=True)
            if round_index >= 0:
                samples[variant].append({
                    "round": round_index + 1,
                    "seconds": elapsed,
                    "cpu_seconds": float(cpu[2]) + float(cpu[3]),
                    "runner_seconds": stats["duration"] / 1000,
                    "passed": stats["expected"],
                    "skipped": stats["skipped"],
                })
    summaries = {
        variant: {
            "median_seconds": statistics.median(s["seconds"] for s in entries),
            "min_seconds": min(s["seconds"] for s in entries),
            "max_seconds": max(s["seconds"] for s in entries),
            "median_cpu_seconds": statistics.median(s["cpu_seconds"] for s in entries),
            "median_runner_seconds": statistics.median(s["runner_seconds"] for s in entries),
            "passed": entries[0]["passed"],
        }
        for variant, entries in samples.items()
    }
    summaries["speedup"] = summaries["before"]["median_seconds"] / summaries["after"]["median_seconds"]
    result["scenarios"][name] = {"command": [*runner, *scenario], "samples": samples, "summary": summaries}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
