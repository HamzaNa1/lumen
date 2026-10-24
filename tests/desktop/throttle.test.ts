import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { throttle } from "../../packages/ui/src/throttle.ts";

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("throttle", () => {
  test("runs the first call at once", () => {
    const calls: Array<number> = [];
    const throttled = throttle((value: number) => calls.push(value), 20);
    throttled(1);
    expect(calls).toEqual([1]);
    throttled.cancel();
  });

  test("keeps only the latest call made inside the interval", async () => {
    const calls: Array<number> = [];
    const throttled = throttle((value: number) => calls.push(value), 20);
    throttled(1);
    throttled(2);
    throttled(3);
    expect(calls).toEqual([1]);
    jest.advanceTimersByTime(40);
    expect(calls).toEqual([1, 3]);
  });

  test("keeps the interval between a trailing call and the next one", async () => {
    const calls: Array<number> = [];
    const throttled = throttle((value: number) => calls.push(value), 40);
    throttled(1);
    throttled(2);
    jest.advanceTimersByTime(50);
    throttled(3);
    expect(calls).toEqual([1, 2]);
    jest.advanceTimersByTime(60);
    expect(calls).toEqual([1, 2, 3]);
  });

  test("runs at once again after a quiet interval", async () => {
    const calls: Array<number> = [];
    const throttled = throttle((value: number) => calls.push(value), 20);
    throttled(1);
    jest.advanceTimersByTime(40);
    throttled(2);
    expect(calls).toEqual([1, 2]);
    throttled.cancel();
  });

  test("drops the waiting call when cancelled", async () => {
    const calls: Array<number> = [];
    const throttled = throttle((value: number) => calls.push(value), 20);
    throttled(1);
    throttled(2);
    throttled.cancel();
    jest.advanceTimersByTime(40);
    expect(calls).toEqual([1]);
  });
});
