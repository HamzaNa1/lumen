import { expect, test } from "bun:test";
import { ServerClock } from "../../apps/desktop/src/main/watch-groups/ServerClock";
test("maps different monotonic origins and subtracts server processing time", () => {
  const clock = new ServerClock();
  for (let i = 0; i < 3; i++) {
    const key = String(i);
    clock.begin(key, 100 + i * 100);
    expect(clock.receive(key, 1_110 + i * 100, 1_130 + i * 100, 140 + i * 100)).toBe(true);
  }
  expect(clock.estimate(350)).toEqual({ serverNowMs: 1_350, uncertaintyMs: 10, fine: true });
  expect(clock.receive("unknown", 1, 2, 3)).toBe(false);
  expect(clock.estimate(16_000)?.fine).toBe(false);
  clock.reset();
  expect(clock.estimate(400)).toBeNull();
});

test("negative offsets, outliers, impossible RTT and expired probes cannot corrupt mapping", () => {
  const clock = new ServerClock();
  for (let i = 0; i < 3; i++) {
    clock.begin(String(i), 10_000 + i * 100);
    clock.receive(String(i), 1_010 + i * 100, 1_010 + i * 100, 10_020 + i * 100);
  }
  clock.begin("outlier", 10_300);
  clock.receive("outlier", 1_700, 1_700, 11_200);
  expect(clock.estimate(11_300)?.serverNowMs).toBe(2_300);
  clock.begin("negative-rtt", 11_400);
  expect(clock.receive("negative-rtt", 3_000, 4_000, 11_500)).toBe(false);
  clock.begin("expired", 11_500);
  expect(clock.receive("expired", 3_000, 3_000, 17_000)).toBe(false);
  clock.begin("nan", 17_000);
  expect(clock.receive("nan", NaN, 3_000, 17_020)).toBe(false);
  expect(clock.receive("0", 1, 2, 3)).toBe(false);
  clock.reset();
  for (let i = 0; i < 3; i++) {
    clock.begin(String(i), 50 + i * 10);
    clock.receive(String(i), 550 + i * 10, 550 + i * 10, 50 + i * 10);
  }
  expect(clock.estimate(100)?.serverNowMs).toBe(600);
});
