import { expect, test } from "bun:test";
import { decodeConfig } from "../../apps/server/src/config/Config";

test("numeric configuration uses defaults when environment values are absent", () => {
  expect(decodeConfig({})).toMatchObject({
    port: 3210,
    maxConcurrentRequests: 128,
    scanLeaseMs: 300_000,
  });
});

test("numeric environment overrides are decoded as numbers", () => {
  expect(
    decodeConfig({
      LUMEN_PORT: "4321",
      LUMEN_MAX_CONCURRENT_REQUESTS: "16",
      LUMEN_SCAN_LEASE_MS: "1500",
    }),
  ).toMatchObject({ port: 4321, maxConcurrentRequests: 16, scanLeaseMs: 1500 });
});

test.each(["1", "65535"])("the port accepts its inclusive boundary %s", (port) => {
  expect(decodeConfig({ LUMEN_PORT: port }).port).toBe(Number(port));
});

test.each(["0", "65536"])("the port rejects values outside its bounds: %s", (port) => {
  expect(() => decodeConfig({ LUMEN_PORT: port })).toThrow(
    "LUMEN_PORT is outside its allowed range",
  );
});

test.each(["", "-1", "1.5", "1e3", "NaN", "Infinity"])(
  "numeric configuration rejects non-digit input: %s",
  (value) => {
    expect(() => decodeConfig({ LUMEN_MAX_CONCURRENT_REQUESTS: value })).toThrow();
  },
);

test("numeric configuration rejects integers that cannot be represented safely", () => {
  expect(() => decodeConfig({ LUMEN_MAX_CONCURRENT_REQUESTS: "9007199254740993" })).toThrow(
    "LUMEN_MAX_CONCURRENT_REQUESTS must be an integer",
  );
});
