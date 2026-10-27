import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Product } from "./products";

type Runtime = "api" | "browser" | "native" | "tooling";
// Every suite is assigned to a real execution boundary and the products it gates.
export const suites: Record<string, { runtime: Runtime; products: readonly Product[] }> = {
  "administration.e2e.ts": { runtime: "api", products: ["server"] },
  "transport.e2e.ts": { runtime: "api", products: ["server", "desktop"] },
  "client-boundaries.e2e.ts": { runtime: "api", products: ["server", "desktop"] },
  "authentication.e2e.ts": { runtime: "api", products: ["server"] },
  "home-music.e2e.ts": { runtime: "api", products: ["server"] },
  "catalog.e2e.ts": { runtime: "api", products: ["server"] },
  "catalog-metadata.e2e.ts": { runtime: "api", products: ["server"] },
  "database-storage.e2e.ts": { runtime: "api", products: ["server"] },
  "database-upgrade.e2e.ts": { runtime: "api", products: ["server"] },
  "media-admission.e2e.ts": { runtime: "api", products: ["server"] },
  "media-delivery.e2e.ts": { runtime: "api", products: ["server"] },
  "metadata-provider.e2e.ts": { runtime: "api", products: ["server"] },
  "playback-state.e2e.ts": { runtime: "api", products: ["server"] },
  "scanner-transactions.e2e.ts": { runtime: "api", products: ["server"] },
  "scan-recovery.e2e.ts": { runtime: "api", products: ["server"] },
  "rate-limit-races.e2e.ts": { runtime: "api", products: ["server"] },
  "server-failures.e2e.ts": { runtime: "api", products: ["server"] },
  "session-expiry.e2e.ts": { runtime: "api", products: ["server"] },
  "watch-recovery.e2e.ts": { runtime: "api", products: ["server", "desktop"] },
  "watch-groups.e2e.ts": { runtime: "api", products: ["server", "desktop"] },
  "browser-groups.e2e.ts": { runtime: "browser", products: ["server", "desktop"] },
  "browser-accounts.e2e.ts": { runtime: "browser", products: ["server"] },
  "browser-controls.e2e.ts": { runtime: "browser", products: ["server"] },
  "browser-failures.e2e.ts": { runtime: "browser", products: ["server"] },
  "browser-journeys.e2e.ts": { runtime: "browser", products: ["server"] },
  "desktop-updates.e2e.ts": { runtime: "native", products: ["desktop"] },
  "desktop-sync-races.e2e.ts": { runtime: "native", products: ["desktop"] },
  "native-audio.e2e.ts": { runtime: "native", products: ["desktop"] },
  "desktop-artwork.e2e.ts": { runtime: "native", products: ["desktop"] },
  "desktop.e2e.ts": { runtime: "native", products: ["desktop"] },
  "desktop-lifecycle.e2e.ts": { runtime: "native", products: ["desktop"] },
  "desktop-tracks.e2e.ts": { runtime: "native", products: ["desktop"] },
  "mixed-playback.e2e.ts": { runtime: "native", products: ["server", "desktop"] },
  "verification.e2e.ts": { runtime: "tooling", products: ["server", "desktop"] },
  "protection.e2e.ts": { runtime: "tooling", products: ["server", "desktop"] },
  "release-notes.e2e.ts": { runtime: "tooling", products: ["server", "desktop"] },
  "release-tooling.e2e.ts": { runtime: "tooling", products: ["server", "desktop"] },
};
export const selectedSuites = (runtime: Runtime, product?: Product) =>
  Object.entries(suites)
    .filter(
      ([, suite]) =>
        suite.runtime === runtime && (product === undefined || suite.products.includes(product)),
    )
    .map(([file]) => file);

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
