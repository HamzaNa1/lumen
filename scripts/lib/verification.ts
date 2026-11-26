import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Product, parseProduct } from "./products";

type Runtime = "api" | "browser" | "native" | "tooling";
type Suite = { runtime: Runtime; products: readonly Product[] };
// Every suite is assigned to a real execution boundary and the products it gates.
export const suites: Record<string, Suite> = {
  "administration.e2e.ts": { runtime: "api", products: ["server"] },
  "transport-timeouts.e2e.ts": { runtime: "api", products: ["server"] },
  "transport.e2e.ts": { runtime: "api", products: ["server", "desktop"] },
  "desktop-route-manager.e2e.ts": { runtime: "api", products: ["desktop"] },
  "server-routes.e2e.ts": { runtime: "api", products: ["server"] },
  "client-boundaries.e2e.ts": { runtime: "api", products: ["server", "desktop"] },
  "authentication.e2e.ts": { runtime: "api", products: ["server"] },
  "home-music.e2e.ts": { runtime: "api", products: ["server"] },
  "library-diff.e2e.ts": { runtime: "api", products: ["server"] },
  "catalog.e2e.ts": { runtime: "api", products: ["server"] },
  "catalog-metadata.e2e.ts": { runtime: "api", products: ["server"] },
  "database-storage.e2e.ts": { runtime: "api", products: ["server"] },
  "database-upgrade.e2e.ts": { runtime: "api", products: ["server"] },
  "media-admission.e2e.ts": { runtime: "api", products: ["server"] },
  "media-delivery.e2e.ts": { runtime: "api", products: ["server"] },
  "download-grants.e2e.ts": { runtime: "api", products: ["server"] },
  "metadata-provider.e2e.ts": { runtime: "api", products: ["server"] },
  "playback-state.e2e.ts": { runtime: "api", products: ["server"] },
  "jellyfin-api.e2e.ts": { runtime: "api", products: ["server"] },
  "scanner-transactions.e2e.ts": { runtime: "api", products: ["server"] },
  "scan-retention.e2e.ts": { runtime: "api", products: ["server"] },
  "scan-recovery.e2e.ts": { runtime: "api", products: ["server"] },
  "rate-limit-races.e2e.ts": { runtime: "api", products: ["server"] },
  "server-failures.e2e.ts": { runtime: "api", products: ["server"] },
  "session-expiry.e2e.ts": { runtime: "api", products: ["server"] },
  "watch-recovery.e2e.ts": { runtime: "api", products: ["server", "desktop"] },
  "watch-groups.e2e.ts": { runtime: "api", products: ["server", "desktop"] },
  "watch-transport.e2e.ts": { runtime: "api", products: ["server"] },
  "browser-groups.e2e.ts": { runtime: "browser", products: ["server"] },
  "browser-accounts.e2e.ts": { runtime: "browser", products: ["server"] },
  "browser-controls.e2e.ts": { runtime: "browser", products: ["server"] },
  "browser-failures.e2e.ts": { runtime: "browser", products: ["server"] },
  "browser-journeys.e2e.ts": { runtime: "browser", products: ["server"] },
  "desktop-updates.e2e.ts": { runtime: "native", products: ["desktop"] },
  "macos-packaging.e2e.ts": { runtime: "native", products: ["desktop"] },
  "desktop-sync-races.e2e.ts": { runtime: "native", products: ["desktop"] },
  "desktop-transcoding.e2e.ts": { runtime: "native", products: ["desktop"] },
  "native-audio.e2e.ts": { runtime: "native", products: ["desktop"] },
  "desktop-artwork.e2e.ts": { runtime: "native", products: ["desktop"] },
  "desktop.e2e.ts": { runtime: "native", products: ["desktop"] },
  "desktop-routes.e2e.ts": { runtime: "native", products: ["desktop"] },
  "desktop-lifecycle.e2e.ts": { runtime: "native", products: ["desktop"] },
  "desktop-video-color.e2e.ts": { runtime: "native", products: ["desktop"] },
  "desktop-tracks.e2e.ts": { runtime: "native", products: ["desktop"] },
  "downloads.e2e.ts": { runtime: "native", products: ["server", "desktop"] },
  "media-streaming.e2e.ts": { runtime: "native", products: ["desktop"] },
  // Layout parity compares two clients built from the same revision.
  "client-parity.e2e.ts": { runtime: "native", products: [] },
  "mixed-playback.e2e.ts": { runtime: "native", products: ["server", "desktop"] },
  "verification.e2e.ts": { runtime: "tooling", products: ["server", "desktop"] },
  "protection.e2e.ts": { runtime: "tooling", products: ["server", "desktop"] },
  "release-notes.e2e.ts": { runtime: "tooling", products: ["server", "desktop"] },
  "release-tooling.e2e.ts": { runtime: "tooling", products: ["server", "desktop"] },
  "linux-service.e2e.ts": { runtime: "tooling", products: ["server"] },
};
// Code a suite can exercise. API suites reach the products they gate; every browser suite starts
// the server, and every native suite starts both the server and Electron.
const reachedProducts = (suite: Suite): readonly Product[] =>
  suite.runtime === "api"
    ? suite.products
    : suite.runtime === "browser"
      ? ["server"]
      : ["server", "desktop"];

export const selectedSuites = (runtime: Runtime, product?: Product, changed?: readonly Product[]) =>
  Object.entries(suites)
    .filter(
      ([, suite]) =>
        suite.runtime === runtime &&
        (product === undefined || suite.products.includes(product)) &&
        (changed === undefined || reachedProducts(suite).some((each) => changed.includes(each))),
    )
    .map(([file]) => file);

export const parseChangedProducts = (value: string | undefined) =>
  value ? value.split(",").map(parseProduct) : undefined;

export const durationsPath = join(import.meta.dirname, "../../tests/e2e/durations.json");
export type Durations = Record<string, Record<string, number>>;
const recordedDurations = (): Durations =>
  existsSync(durationsPath) ? JSON.parse(readFileSync(durationsPath, "utf8")) : {};

export const parseShard = (value: string | undefined) => {
  if (!value) return undefined;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || index < 1 || index > total) throw new Error(`Invalid shard: ${value}`);
  return { index, total };
};

// Longest suites first, each onto the lightest shard. Every runner computes the same plan from the
// committed durations; a suite without a recording weighs the project's average.
export const shardSuites = (
  project: string,
  files: readonly string[],
  shard: { index: number; total: number } | undefined,
  durations = recordedDurations(),
) => {
  if (!shard) return [...files];
  const recorded = durations[project] ?? {};
  const known = files.flatMap((file) => recorded[file] ?? []);
  const average = known.length
    ? known.reduce((sum, seconds) => sum + seconds, 0) / known.length
    : 1;
  const weight = (file: string) => recorded[file] ?? average;
  const shards = Array.from({ length: shard.total }, () => ({ seconds: 0, files: [] as string[] }));
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const lightest = shards.reduce((min, each) => (each.seconds < min.seconds ? each : min));
    lightest.seconds += weight(file);
    lightest.files.push(file);
  }
  return shards[shard.index - 1]?.files ?? [];
};

export const verifyTestOwnership = (root: string): void => {
  const expected = new Set(Object.keys(suites).map((file) => `e2e/${file}`));
  for (const file of readdirSync(join(root, "tests"), { recursive: true }).map(String)) {
    if (!/[._](test|spec|e2e)\.[cm]?[jt]sx?$/.test(file)) continue;
    if (!expected.delete(file.replaceAll("\\", "/")))
      throw new Error(`Test suite has no verification owner: ${file}`);
  }
  if (expected.size)
    throw new Error(`Required test suites are missing: ${[...expected].join(", ")}`);
};
