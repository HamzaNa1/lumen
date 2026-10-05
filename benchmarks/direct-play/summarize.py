import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


ROOT = Path(__file__).resolve().parent
transport = json.loads((ROOT / "results.json").read_text())
cache = json.loads((ROOT / "cache-results.json").read_text())
modes = ["bridge_1_reader", "bridge_4_readers", "bridge_64KiB_ranges", "direct_64KiB_ranges"]
names = ["64 MiB · 1 reader", "64 MiB · 4 readers", "64 KiB · bridge", "64 KiB · direct"]
metrics = {
    "throughputMiBps": lambda row: row["throughputMiBps"],
    "bridgeCpuMs": lambda row: row["bridge"]["cpuMs"],
    "bridgePeakRssMiB": lambda row: row["bridge"]["peakRssMiB"],
    "serverCpuMs": lambda row: row["server"]["cpuMs"],
    "serverPeakRssMiB": lambda row: row["server"]["peakRssMiB"],
    "firstByteMedianMs": lambda row: np.median([r["firstByteMs"] for r in row["transfers"]]),
    "firstByteP95Ms": lambda row: np.percentile([r["firstByteMs"] for r in row["transfers"]], 95),
}
rng = np.random.default_rng(20261005)
summary = {"refs": transport["refs"], "cacheRefs": {"baseline": cache["base"], "candidate": cache["candidate"]}, "transport": {}, "cache": {}, "policy": transport["policy"], "cancellation": transport["cancellation"]}

for mode in modes:
    rows = {
        version: sorted([row for row in transport["samples"] if row["mode"] == mode and row["version"] == version], key=lambda row: row["round"])
        for version in ["baseline", "candidate"]
    }
    assert len(rows["baseline"]) == len(rows["candidate"]) == transport["methodology"]["rounds"]
    index = rng.integers(0, len(rows["baseline"]), (20000, len(rows["baseline"])))
    result = {}
    for metric, measure in metrics.items():
        values = {version: np.array([measure(row) for row in group]) for version, group in rows.items()}
        baseline = float(np.median(values["baseline"]))
        candidate = float(np.median(values["candidate"]))
        bootstrap = (np.median(values["candidate"][index], axis=1) / np.median(values["baseline"][index], axis=1) - 1) * 100
        result[metric] = {
            "baselineMedian": baseline, "candidateMedian": candidate,
            "changePercent": (candidate / baseline - 1) * 100,
            "pairedBootstrap95Percent": np.percentile(bootstrap, [2.5, 97.5]).tolist(),
            "baselineMinMax": [float(values["baseline"].min()), float(values["baseline"].max())],
            "candidateMinMax": [float(values["candidate"].min()), float(values["candidate"].max())],
        }
    summary["transport"][mode] = result

for metric in ["aheadSeconds", "forwardMiB", "peakRssMiB", "fiveSecondsReadyMs"]:
    values = {version: [row[metric] for row in cache["samples"] if row["version"] == version] for version in ["baseline", "candidate"]}
    a, b = (float(np.median(values[version])) for version in ["baseline", "candidate"])
    summary["cache"][metric] = {"baselineMedian": a, "candidateMedian": b, "changePercent": (b / a - 1) * 100, "baselineSamples": values["baseline"], "candidateSamples": values["candidate"]}
summary["statistics"] = "Median of9 independent process-run summaries;95%paired bootstrap intervals with20000resamples, fixed seed20261005. Cache median of3 runs, no confidence interval. Short loopback timings do not predict WAN or UI latency."
(ROOT / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")

plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False, "axes.spines.right": False})
fig, axes = plt.subplots(2, 2, figsize=(16, 10), gridspec_kw={"height_ratios": [1, 1.12]})
fig.patch.set_facecolor("#f8fafc")
green, red, muted = "#087f8c", "#c44e38", "#4b5563"

for ax, metric, count, higher_better, title in [
    (axes[0, 0], "throughputMiBps", 4, True, "Throughput by transfer size"),
    (axes[0, 1], "serverCpuMs", 4, False, "Server CPU time"),
]:
    for i, mode in enumerate(modes[:count]):
        item = summary["transport"][mode][metric]
        change = item["changePercent"]
        low, high = item["pairedBootstrap95Percent"]
        color = green if (change > 0) == higher_better else red
        ax.barh(i, change, color=color, height=0.56)
        ax.errorbar(change, i, xerr=[[max(0, change - low)], [max(0, high - change)]], fmt="none", ecolor="#18212f", capsize=4)
        position = max(high, change) + 1.5 if change >= 0 else min(low, change) - 1.5
        ax.text(position, i, f"{change:+.1f}%", ha="left" if change >= 0 else "right", va="center", weight="bold", color=color)
    ax.set_yticks(range(count), names[:count])
    ax.invert_yaxis()
    ax.axvline(0, color="#9ca3af", lw=0.8)
    bounds = [value for mode in modes[:count] for value in summary["transport"][mode][metric]["pairedBootstrap95Percent"]]
    ax.set_xlim(min(-10, min(bounds) - 15), max(10, max(bounds) + 15))
    ax.set_xlabel("Change (%) · whiskers: paired 95% bootstrap interval")
    ax.set_title(title, loc="left", pad=16, weight="bold")
    ax.grid(axis="x", alpha=0.14)
    ax.set_axisbelow(True)

ax = axes[1, 0]
ax.set_title("Paused cache: headroom vs memory", loc="left", pad=16, weight="bold")
for i, (metric, label, unit) in enumerate([("aheadSeconds", "Buffered ahead", "s"), ("peakRssMiB", "mpv peak RSS", "MiB")]):
    item = summary["cache"][metric]
    ax.barh(i - 0.17, 100, height=0.30, color="#94a3b8", label="Before" if i == 0 else None)
    ax.barh(i + 0.17, 100 + item["changePercent"], height=0.30, color=green if i == 0 else red, label="After" if i == 0 else None)
    ax.text(102, i - 0.17, f"{item['baselineMedian']:.2f}{unit}", va="center", color=muted)
    ax.text(102 + item["changePercent"], i + 0.17, f"{item['candidateMedian']:.2f}{unit} ({item['changePercent']:+.1f}%)", va="center", weight="bold")
ax.set_xlim(0, 180)
ax.set_yticks([0, 1], ["Buffered ahead", "mpv peak RSS"])
ax.invert_yaxis()
ax.set_xlabel("Baseline = 100 · mpv 0.41 · 24 Mbit/s · 3 paired runs")

ax = axes[1, 1]
ax.axis("off")
ax.set_title("Reliability and default admission", loc="left", pad=16, weight="bold")
latency = np.median([row["abortLatencyMs"] for row in transport["cancellation"] if row["abortLatencyMs"] is not None])
def successes(scenario):
    rows = {row["version"]: row for row in transport["policy"] if row["scenario"] == scenario}
    return " → ".join(f"{rows[version]['statuses'].get('206', 0)}/{rows[version]['requests']}" for version in ["baseline", "candidate"])

blocks = [
    ("After exhausting the API request budget", f"Media successes: {successes('api_budget_exhaustion')}", green),
    ("Immediate 200-request media burst", f"Media successes: {successes('immediate_range_burst')}", red),
    ("Revoke while the downstream reader is paused", f"Upstream release: >1000 ms → {latency:.2f} ms", green),
    ("64 KiB bridge ranges: first-byte latency", f"{summary['transport']['bridge_64KiB_ranges']['firstByteMedianMs']['baselineMedian']:.3f} ms → {summary['transport']['bridge_64KiB_ranges']['firstByteMedianMs']['candidateMedian']:.3f} ms", red),
]
for i, (label, value, color) in enumerate(blocks):
    y = 0.91 - i * 0.235
    ax.text(0, y, label, transform=ax.transAxes, color=muted)
    ax.text(0, y - 0.075, value, transform=ax.transAxes, fontsize=12.5, weight="bold", color=color)

fig.suptitle("Direct-play benchmark: gains and regressions", x=0.045, ha="left", fontsize=22, weight="bold", color="#111827")
fig.text(0.045, 0.928, f"Transport: {transport['refs']['baseline'][:7]} → {transport['refs']['candidate'][:7]} · Apple M2 · macOS · Node 24.21.0 / Bun 1.4.2", color=muted)
fig.text(0.045, 0.025, f"9 alternating paired transport runs; warm 64 MiB file; real handler + native bridge; fixed grant metadata replaces DB authorization.\nCache measurements retained from {cache['base'][:7]} → {cache['candidate'][:7]}; cache profile unchanged. Loopback/headless, not WAN or packaged UI.\nThroughput tests relax limits equally; admission uses defaults. RSS is sampled memory. No performance tuning after measurement.", fontsize=9, color=muted, linespacing=1.5)
fig.subplots_adjust(left=0.16, right=0.95, top=0.855, bottom=0.16, hspace=0.50, wspace=0.80)
fig.savefig(ROOT / "comparison.png", dpi=160, facecolor=fig.get_facecolor())
plt.close(fig)
