import { describe, expect, test } from "bun:test";
import { throttle } from "../../packages/ui/src/throttle.ts";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
    await wait(40);
    expect(calls).toEqual([1, 3]);
  });

  test("keeps the interval between a trailing call and the next one", async () => {
    const calls: Array<number> = [];
    const throttled = throttle((value: number) => calls.push(value), 40);
    throttled(1);
    throttled(2);
    await wait(50);
    throttled(3);
    expect(calls).toEqual([1, 2]);
    await wait(60);
    expect(calls).toEqual([1, 2, 3]);
  });

  test("runs at once again after a quiet interval", async () => {
    const calls: Array<number> = [];
    const throttled = throttle((value: number) => calls.push(value), 20);
    throttled(1);
    await wait(40);
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
    await wait(40);
    expect(calls).toEqual([1]);
  });
});
