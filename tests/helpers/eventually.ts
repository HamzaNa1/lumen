import { setImmediate, setInterval } from "node:timers/promises";

/** Polls an observable condition with a bounded deadline, closing the timer on every exit. */
export const eventually = async (
  ready: () => boolean | Promise<boolean>,
  timeout = 5000,
): Promise<void> => {
  const deadline = performance.now() + timeout;
  if (await ready()) return;
  for await (const _ of setInterval(10)) {
    if (await ready()) return;
    if (performance.now() >= deadline) throw new Error("Condition did not become true");
  }
};

/** Waits for the next observed call and drains its queued promise continuations. */
export const afterNextObservation = async (count: () => number): Promise<void> => {
  const before = count();
  await eventually(() => count() > before);
  await setImmediate();
};
