import { expect, test } from "bun:test";
import {
  WatchDriftCorrection,
  watchSamplePosition,
  type WatchPlaybackSample,
} from "../../packages/client/src/index.ts";

const sample: WatchPlaybackSample = {
  sessionId: "session",
  itemId: "item",
  positionSeconds: 10,
  durationSeconds: 100,
  paused: false,
  advancing: true,
  speed: 0.99,
  sampledAtMs: 1000,
};

test("timestamped positions project the measured rate and reject stale or invalid measurements", () => {
  expect(watchSamplePosition(sample, 1240)).toBeCloseTo(10.2376, 6);
  for (const state of [{ paused: true }, { advancing: false }])
    expect(watchSamplePosition({ ...sample, ...state }, 1240)).toBe(10);
  expect(watchSamplePosition({ ...sample, durationSeconds: 10.1 }, 1240)).toBe(10.1);
  for (const time of [999, 1251, NaN, Infinity])
    expect(watchSamplePosition(sample, time)).toBeNull();
});

test("jitter and isolated drift never trigger speed changes, even with timer jitter", () => {
  const correction = new WatchDriftCorrection();
  let now = 0;
  for (let i = 0; i < 200; i++) {
    now += [480, 620, 370, 910][i % 4] ?? 500;
    const drift = [0.02, 0.14, -0.12, 0.24, 0.03, -0.25][i % 6] ?? 0;
    expect(correction.update(10, 10 + drift, false, now)).toEqual({ seek: null, speed: 1 });
  }
});

test.each([-1, 1])(
  "sustained drift converges gently and settles exactly to 1x (direction %s)",
  (direction) => {
    const correction = new WatchDriftCorrection();
    let drift = direction * 0.4;
    let now = 0;
    let speed = 1;
    const rates: number[] = [];
    for (let i = 0; i < 240; i++) {
      const elapsed = [450, 580, 320, 750][i % 4] ?? 500;
      drift -= ((speed - 1) * elapsed) / 1000;
      now += elapsed;
      const result = correction.update(10, 10 + drift, false, now);
      expect(result.seek).toBeNull();
      speed = result.speed;
      expect(speed).toBeGreaterThanOrEqual(0.99);
      expect(speed).toBeLessThanOrEqual(1.01);
      expect((speed - 1) * direction).toBeGreaterThanOrEqual(0);
      rates.push(speed);
    }
    expect(rates.slice(0, 3)).toEqual([1, 1, 1]);
    expect(rates).toContain(1 + direction * 0.01);
    expect(rates).toContain(1 + direction * 0.003);
    expect(Math.abs(drift)).toBeLessThanOrEqual(0.05);
    expect(speed).toBe(1);
  },
);

test("hysteresis survives enter-threshold jitter and demands new evidence after reversals or timer gaps", () => {
  const correction = new WatchDriftCorrection();
  expect(correction.update(10, 10.2, false, 0).speed).toBe(1);
  expect(correction.update(10, 10.2, false, 1500).speed).toBe(1.008);
  expect(correction.update(10, 10.1, false, 2000).speed).toBe(1.004);
  expect(correction.update(10, 9.8, false, 2500).speed).toBe(1);
  expect(correction.update(10, 9.8, false, 4000).speed).toBe(0.992);
  expect(correction.update(10, 9.8, false, 6000).speed).toBe(1);
  expect(correction.update(10, 9.8, false, 5500).speed).toBe(1);
  correction.reset();
  expect(correction.update(10, 9.8, false, 7000).speed).toBe(1);
});

test("large drift and shared pauses resynchronize immediately and reset persistence", () => {
  const correction = new WatchDriftCorrection();
  for (const target of [9, 11])
    expect(correction.update(10, target, false, 0)).toEqual({ seek: target, speed: 1 });
  expect(correction.update(10, 10.5, true, 0)).toEqual({ seek: 10.5, speed: 1 });
  expect(correction.update(10, 10.04, true, 0)).toEqual({ seek: null, speed: 1 });
});
