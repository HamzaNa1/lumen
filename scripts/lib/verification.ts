import { readdirSync } from "node:fs";
import { join } from "node:path";
import { compatibilitySuites, type Product } from "./products";

// Source parity compares two unreleased builds. It protects main CI, not independent releases.
export const browserSuites = {
  "web-app.e2e.ts": "server",
  "artwork-cache.e2e.ts": "server",
  "desktop-renderer.e2e.ts": "desktop",
  "desktop-parity.e2e.ts": "source",
} as const;

export const productBrowserTests = (product: Product): string[] =>
  Object.entries(browserSuites)
    .filter(([, owner]) => owner === product)
    .map(([file]) => file);

export const assertVerificationCoverage = (files: readonly string[]): void => {
  const expected = new Set([
    ...Object.keys(compatibilitySuites).map((file) => `tests/compatibility/${file}`),
    ...Object.keys(browserSuites).map((file) => `tests/browser/${file}`),
  ]);
  for (const file of files) {
    if (!expected.delete(file)) throw new Error(`Test suite has no verification owner: ${file}`);
  }
  if (expected.size > 0)
    throw new Error(`Required test suites are missing: ${[...expected].join(", ")}`);
};

export const verifyTestOwnership = (root: string): void =>
  assertVerificationCoverage([
    ...["compatibility", "browser"].flatMap((directory) =>
      readdirSync(join(root, "tests", directory), { recursive: true })
        .map(String)
        .filter((file) => /[._](test|spec|e2e)\.[cm]?[jt]sx?$/.test(file))
        .map((file) => `tests/${directory}/${file.replaceAll("\\", "/")}`),
    ),
  ]);
