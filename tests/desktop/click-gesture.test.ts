import { describe, expect, test } from "bun:test";
import { clickGesture } from "../../packages/ui/src/clickGesture.ts";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const record = (delayMs: number) => {
  const calls: Array<"single" | "double"> = [];
  const gesture = clickGesture({
    onSingle: () => calls.push("single"),
    onDouble: () => calls.push("double"),
    delayMs,
  });
  return { calls, gesture };
};

describe("clickGesture", () => {
  test("runs a lone click as a single once the wait ends", async () => {
    const { calls, gesture } = record(20);
    gesture();
    expect(calls).toEqual([]);
    await wait(40);
    expect(calls).toEqual(["single"]);
  });

  test("runs two quick clicks as a double and never as a single", async () => {
    const { calls, gesture } = record(20);
    gesture();
    gesture();
    expect(calls).toEqual(["double"]);
    await wait(40);
    expect(calls).toEqual(["double"]);
  });

  test("runs clicks further apart than the wait as singles", async () => {
    const { calls, gesture } = record(20);
    gesture();
    await wait(40);
    gesture();
    await wait(40);
    expect(calls).toEqual(["single", "single"]);
  });

  test("starts over after a double", async () => {
    const { calls, gesture } = record(20);
    gesture();
    gesture();
    gesture();
    await wait(40);
    expect(calls).toEqual(["double", "single"]);
  });

  test("drops the waiting click when cancelled", async () => {
    const { calls, gesture } = record(20);
    gesture();
    gesture.cancel();
    await wait(40);
    expect(calls).toEqual([]);
  });
});
