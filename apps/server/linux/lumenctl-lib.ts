export class UsageError extends Error {}

export interface LogsOptions {
  readonly follow: boolean;
  readonly lines: string | undefined;
  readonly since: string | undefined;
  readonly until: string | undefined;
  readonly update: boolean;
  readonly extra: readonly string[];
}

export type LogsArgsResult =
  | { readonly kind: "help" }
  | { readonly kind: "run"; readonly options: LogsOptions };

export interface StatsOptions {
  readonly noStream: boolean;
  readonly json: boolean;
}

export type StatsArgsResult =
  | { readonly kind: "help" }
  | { readonly kind: "run"; readonly options: StatsOptions };

export interface StatsSample {
  readonly activeState: string | undefined;
  readonly subState: string | undefined;
  readonly invocationId: string | undefined;
  readonly timestampNs: bigint;
  readonly cpuUsageNs: bigint | undefined;
  readonly memoryUsageBytes: bigint | undefined;
  readonly memoryLimitBytes: bigint | undefined;
  readonly netIngressBytes: bigint | undefined;
  readonly netEgressBytes: bigint | undefined;
  readonly blockReadBytes: bigint | undefined;
  readonly blockWriteBytes: bigint | undefined;
  readonly pids: bigint | undefined;
}

export interface StatsRow {
  readonly name: string;
  readonly state: string;
  readonly cpuPercent: number | undefined;
  readonly memoryUsageBytes: bigint | undefined;
  readonly memoryLimitBytes: bigint | undefined;
  readonly memoryPercent: number | undefined;
  readonly netIngressBytes: bigint | undefined;
  readonly netEgressBytes: bigint | undefined;
  readonly blockReadBytes: bigint | undefined;
  readonly blockWriteBytes: bigint | undefined;
  readonly pids: bigint | undefined;
}

export const LOGS_USAGE =
  "usage: lumenctl logs [-f|--follow] [-n|--tail <N|all>] [--since <time>] [--until <time>] [--update] [-- <journalctl args>]";
export const STATS_USAGE = "usage: lumenctl stats [--no-stream] [--json]";

export const STATS_PROPERTIES = [
  "ActiveState",
  "SubState",
  "InvocationID",
  "ControlGroup",
  "CPUUsageNSec",
  "MemoryCurrent",
  "MemoryMax",
  "TasksCurrent",
  "IOReadBytes",
  "IOWriteBytes",
  "IPIngressBytes",
  "IPEgressBytes",
] as const;

const UINT64_MAX = 18446744073709551615n;

const relativeTimeUnits: Readonly<Record<string, string>> = {
  s: "seconds",
  m: "minutes",
  h: "hours",
  d: "days",
  w: "weeks",
};

const normalizeTimeSpec = (value: string): string => {
  const match = /^(\d+)([smhdw])$/u.exec(value.trim());
  if (match?.[1] === undefined || match[2] === undefined) return value;
  return `${match[1]} ${relativeTimeUnits[match[2]]} ago`;
};

const parseLineCount = (value: string): string => {
  if (value === "all" || /^\d+$/u.test(value)) return value;
  throw new UsageError(`invalid line count: ${value}`);
};

const requireValue = (argv: readonly string[], index: number, flag: string): string => {
  const value = argv[index];
  if (value === undefined) throw new UsageError(`${flag} requires a value`);
  return value;
};

export const parseLogsArgs = (argv: readonly string[]): LogsArgsResult => {
  let follow = false;
  let lines: string | undefined;
  let since: string | undefined;
  let until: string | undefined;
  let update = false;
  const extra: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--") {
      extra.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "-f" || arg === "--follow") {
      follow = true;
      continue;
    }
    if (arg === "--update") {
      update = true;
      continue;
    }
    if (arg === "-n" || arg === "--lines" || arg === "--tail") {
      lines = parseLineCount(requireValue(argv, ++i, arg));
      continue;
    }
    if (arg.startsWith("--lines=") || arg.startsWith("--tail=") || arg.startsWith("-n=")) {
      lines = parseLineCount(arg.slice(arg.indexOf("=") + 1));
      continue;
    }
    if (/^-n\d+$/u.test(arg)) {
      lines = parseLineCount(arg.slice(2));
      continue;
    }
    if (arg === "-S" || arg === "--since") {
      since = normalizeTimeSpec(requireValue(argv, ++i, arg));
      continue;
    }
    if (arg.startsWith("--since=")) {
      since = normalizeTimeSpec(arg.slice("--since=".length));
      continue;
    }
    if (arg === "-U" || arg === "--until") {
      until = normalizeTimeSpec(requireValue(argv, ++i, arg));
      continue;
    }
    if (arg.startsWith("--until=")) {
      until = normalizeTimeSpec(arg.slice("--until=".length));
      continue;
    }
    throw new UsageError(`unknown option: ${arg}`);
  }

  return {
    kind: "run",
    options: { follow, lines, since, until, update, extra },
  };
};

export const buildJournalctlArgs = (options: LogsOptions): string[] => {
  const args = ["-u", options.update ? "lumen-update.service" : "lumen.service", "--no-pager"];
  const hasRange = options.since !== undefined || options.until !== undefined;
  if (options.lines !== undefined) {
    args.push(`--lines=${options.lines}`);
  } else if (hasRange) {
    // journalctl -f defaults to 10 lines even with --since unless --lines=all is explicit.
    if (options.follow) args.push("--lines=all");
  } else {
    args.push("--lines=100");
  }
  if (options.since !== undefined) args.push(`--since=${options.since}`);
  if (options.until !== undefined) args.push(`--until=${options.until}`);
  if (options.follow) args.push("--follow");
  args.push(...options.extra);
  return args;
};

export const parseStatsArgs = (argv: readonly string[]): StatsArgsResult => {
  let noStream = false;
  let json = false;
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "--no-stream") {
      noStream = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new UsageError(`unknown option: ${arg}`);
  }
  return { kind: "run", options: { noStream, json } };
};

export const parseUint64 = (value: string | undefined): bigint | undefined => {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed === UINT64_MAX ? undefined : parsed;
};

export const parseInactiveFileBytes = (memoryStat: string): bigint | undefined => {
  const match = /^inactive_file\s+(\d+)$/mu.exec(memoryStat);
  return match?.[1] === undefined ? undefined : BigInt(match[1]);
};

export const parseUnitStatsSample = (
  properties: Readonly<Record<string, string>>,
  timestampNs: bigint,
  totalMemoryBytes: bigint,
  inactiveFileBytes?: bigint,
): StatsSample => {
  const activeState = properties.ActiveState || undefined;
  const subState = properties.SubState || undefined;
  const invocationId = properties.InvocationID || undefined;
  const rawMemory = parseUint64(properties.MemoryCurrent);
  const memoryUsageBytes =
    rawMemory === undefined
      ? undefined
      : inactiveFileBytes !== undefined
        ? rawMemory > inactiveFileBytes
          ? rawMemory - inactiveFileBytes
          : 0n
        : rawMemory;
  const rawMax = parseUint64(properties.MemoryMax);
  const memoryLimitBytes =
    rawMax !== undefined && rawMax > 0n && (totalMemoryBytes <= 0n || rawMax < totalMemoryBytes)
      ? rawMax
      : totalMemoryBytes > 0n
        ? totalMemoryBytes
        : undefined;

  return {
    activeState,
    subState,
    invocationId,
    timestampNs,
    cpuUsageNs: parseUint64(properties.CPUUsageNSec),
    memoryUsageBytes,
    memoryLimitBytes,
    netIngressBytes: parseUint64(properties.IPIngressBytes),
    netEgressBytes: parseUint64(properties.IPEgressBytes),
    blockReadBytes: parseUint64(properties.IOReadBytes),
    blockWriteBytes: parseUint64(properties.IOWriteBytes),
    pids: parseUint64(properties.TasksCurrent),
  };
};

const serviceState = (activeState: string | undefined, subState: string | undefined): string => {
  if (activeState === "active" && subState === "running") return "running";
  if (activeState === "inactive") return "stopped";
  if (activeState === "failed") return "failed";
  return activeState ?? "unknown";
};

const percentOf = (numerator: bigint, denominator: bigint): number =>
  Number((numerator * 10_000n + denominator / 2n) / denominator) / 100;

export const computeStatsRow = (current: StatsSample, previous?: StatsSample): StatsRow => {
  let cpuPercent: number | undefined;
  if (
    previous !== undefined &&
    current.activeState === "active" &&
    previous.activeState === "active" &&
    current.invocationId !== undefined &&
    current.invocationId === previous.invocationId &&
    current.cpuUsageNs !== undefined &&
    previous.cpuUsageNs !== undefined
  ) {
    const deltaCpuNs = current.cpuUsageNs - previous.cpuUsageNs;
    const deltaWallNs = current.timestampNs - previous.timestampNs;
    if (deltaCpuNs >= 0n && deltaWallNs > 0n) {
      cpuPercent = percentOf(deltaCpuNs, deltaWallNs);
    }
  }

  const memoryPercent =
    current.memoryUsageBytes !== undefined &&
    current.memoryLimitBytes !== undefined &&
    current.memoryLimitBytes > 0n
      ? percentOf(current.memoryUsageBytes, current.memoryLimitBytes)
      : undefined;

  return {
    name: "lumen",
    state: serviceState(current.activeState, current.subState),
    cpuPercent,
    memoryUsageBytes: current.memoryUsageBytes,
    memoryLimitBytes: current.memoryLimitBytes,
    memoryPercent,
    netIngressBytes: current.netIngressBytes,
    netEgressBytes: current.netEgressBytes,
    blockReadBytes: current.blockReadBytes,
    blockWriteBytes: current.blockWriteBytes,
    pids: current.pids,
  };
};

const formatSize = (bytes: bigint, base: 1000 | 1024, units: readonly string[]): string => {
  if (bytes < BigInt(base)) return `${bytes}B`;
  let value = Number(bytes);
  let unit = 0;
  while (value >= base && unit < units.length - 1) {
    value /= base;
    unit++;
  }
  const digits = value < 10 ? 2 : value < 100 ? 1 : 0;
  if (Number(value.toFixed(digits)) >= base && unit < units.length - 1) {
    return `${(value / base).toFixed(2)}${units[unit + 1]}`;
  }
  return `${value.toFixed(digits)}${units[unit]}`;
};

const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;
const DECIMAL_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"] as const;

export const formatBinaryBytes = (bytes: bigint): string => formatSize(bytes, 1024, BINARY_UNITS);
export const formatDecimalBytes = (bytes: bigint): string => formatSize(bytes, 1000, DECIMAL_UNITS);

const formatPair = (
  first: bigint | undefined,
  second: bigint | undefined,
  format: (bytes: bigint) => string,
): string =>
  first !== undefined && second !== undefined ? `${format(first)} / ${format(second)}` : "-- / --";

export const formatStatsTable = (row: StatsRow): string => {
  const memory =
    row.memoryUsageBytes !== undefined
      ? `${formatBinaryBytes(row.memoryUsageBytes)} / ${
          row.memoryLimitBytes !== undefined ? formatBinaryBytes(row.memoryLimitBytes) : "--"
        }`
      : "-- / --";

  const columns: ReadonlyArray<readonly [string, string, number]> = [
    ["NAME", row.name, 5],
    ["STATE", row.state, 8],
    ["CPU %", row.cpuPercent === undefined ? "--" : `${row.cpuPercent.toFixed(2)}%`, 7],
    ["MEM USAGE / LIMIT", memory, 19],
    ["MEM %", row.memoryPercent === undefined ? "--" : `${row.memoryPercent.toFixed(2)}%`, 6],
    ["NET I/O", formatPair(row.netIngressBytes, row.netEgressBytes, formatDecimalBytes), 17],
    ["BLOCK I/O", formatPair(row.blockReadBytes, row.blockWriteBytes, formatDecimalBytes), 17],
    ["PIDS", row.pids === undefined ? "--" : `${row.pids}`, 4],
  ];

  const widths = columns.map(([header, value, minWidth]) =>
    Math.max(minWidth, header.length, value.length),
  );
  const render = (cells: readonly string[]) =>
    cells
      .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("   ");

  return `${render(columns.map(([header]) => header))}\n${render(columns.map(([, value]) => value))}`;
};

const toJsonNumber = (value: bigint | undefined): number | null =>
  value === undefined ? null : Number(value);

export const formatStatsJson = (row: StatsRow): string =>
  JSON.stringify({
    name: row.name,
    state: row.state,
    cpuPercent: row.cpuPercent ?? null,
    memoryUsageBytes: toJsonNumber(row.memoryUsageBytes),
    memoryLimitBytes: toJsonNumber(row.memoryLimitBytes),
    memoryPercent: row.memoryPercent ?? null,
    netIngressBytes: toJsonNumber(row.netIngressBytes),
    netEgressBytes: toJsonNumber(row.netEgressBytes),
    blockReadBytes: toJsonNumber(row.blockReadBytes),
    blockWriteBytes: toJsonNumber(row.blockWriteBytes),
    pids: toJsonNumber(row.pids),
  });
