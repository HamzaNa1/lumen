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


parser = argparse.ArgumentParser(description="Compare typecheck commands on macOS.")
parser.add_argument("--before", type=Path, required=True)
parser.add_argument("--before-ref", default="HEAD", help="Git revision used for the before directory")
parser.add_argument("--after", type=Path, required=True)
parser.add_argument("--bun", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--runs", type=int, default=7)
args = parser.parse_args()
if platform.system() != "Darwin" or args.runs < 1:
    parser.error("Requires macOS /usr/bin/time -l and at least one measured run.")

env = {**os.environ, "PATH": f"{args.bun.absolute().parent}:{os.environ['PATH']}"}
commands = {
    "all": ["run", "typecheck"],
    "server": ["run", "check:server", "typecheck"],
    "desktop": ["run", "check:desktop", "typecheck"],
}
roots = {"before": args.before.resolve(), "after": args.after.resolve()}


def capture(command, cwd=None):
    return subprocess.check_output(command, cwd=cwd, env=env, text=True).strip()


result = {
    "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "host": {
        "os": capture(["sw_vers", "-productVersion"]),
        "cpu": capture(["sysctl", "-n", "machdep.cpu.brand_string"]),
        "memory_bytes": int(capture(["sysctl", "-n", "hw.memsize"])),
        "architecture": platform.machine(),
        "bun": capture([str(args.bun), "--version"]),
    },
    "before_commit": capture(["git", "rev-parse", args.before_ref], roots["after"]),
    "after": "Migration working tree based on before_commit",
    "compilers": {
        variant: capture([str(args.bun), "run", compiler, "--version"], root)
        for (variant, root), compiler in zip(roots.items(), ["tsc", "tsrs"])
    },
    "method": {
        "warmups_per_variant_per_command": 1,
        "measured_runs_per_variant_per_command": args.runs,
        "order": "before/after on even rounds, after/before on odd rounds; sequential",
        "dependencies": "Shared installed dependencies; identical application source and tsconfigs",
        "wall_time": "Python monotonic clock around /usr/bin/time -l bun <command>",
        "memory": "macOS time maximum resident set size, bytes; maximum child RSS, not summed concurrent process-tree memory",
        "cache": "Warm filesystem caches, no incremental compilation",
    },
    "commands": {},
}

for name, command in commands.items():
    samples = {variant: [] for variant in roots}
    for round_index in range(-1, args.runs):
        variants = ["before", "after"] if round_index % 2 == 0 else ["after", "before"]
        for variant in variants:
            started = time.perf_counter()
            completed = subprocess.run(
                ["/usr/bin/time", "-l", str(args.bun), *command],
                cwd=roots[variant], env=env, capture_output=True, text=True,
            )
            elapsed = time.perf_counter() - started
            if completed.returncode != 0:
                raise RuntimeError(f"{name} {variant} failed:\n{completed.stdout}\n{completed.stderr}")
            rss = re.search(r"(\d+)\s+maximum resident set size", completed.stderr)
            if rss is None:
                raise RuntimeError(f"Missing RSS measurement: {completed.stderr}")
            print(f"{name} {variant} {'warmup' if round_index == -1 else round_index + 1}: {elapsed:.3f}s", flush=True)
            if round_index >= 0:
                samples[variant].append({
                    "round": round_index + 1, "seconds": elapsed,
                    "max_rss_bytes": int(rss[1]), "exit_code": completed.returncode,
                })
    summaries = {
        variant: {
            "median_seconds": statistics.median(s["seconds"] for s in entries),
            "min_seconds": min(s["seconds"] for s in entries),
            "max_seconds": max(s["seconds"] for s in entries),
            "median_max_rss_bytes": statistics.median(s["max_rss_bytes"] for s in entries),
        }
        for variant, entries in samples.items()
    }
    result["commands"][name] = {"command": ["bun", *command], "samples": samples, "summary": summaries}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
