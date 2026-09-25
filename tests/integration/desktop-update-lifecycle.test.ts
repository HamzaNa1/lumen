import { expect, test } from "bun:test";
import { ShutdownCoordinator } from "../../apps/desktop/src/main/lifecycle/ShutdownCoordinator";

test("normal quit suspends checks and waits for player and bridge once", async () => {
  const calls: string[] = [];
  const shutdown = new ShutdownCoordinator({
    suspend: () => { calls.push("suspend"); },
    cleanup: async () => { calls.push("player"); await Promise.resolve(); calls.push("bridge"); },
    fallback: () => { calls.push("fallback"); },
    quit: () => { calls.push("quit"); },
  });
  const event = { preventDefault: () => { calls.push("prevent"); } };
  shutdown.beforeQuit(event);
  shutdown.beforeQuit(event);
  await new Promise((resolve) => setTimeout(resolve, 0));
  shutdown.beforeQuit(event);
  expect(calls).toEqual(["prevent", "suspend", "player", "prevent", "bridge", "quit"]);
});

test("a failed cleanup invokes fallback and still reaches final quit", async () => {
  const calls: string[] = [];
  const shutdown = new ShutdownCoordinator({
    suspend: () => undefined,
    cleanup: async () => { throw new Error("stop failed"); },
    fallback: () => { calls.push("kill resources"); },
    quit: () => { calls.push("quit"); },
  });
  shutdown.beforeQuit({ preventDefault: () => undefined });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toEqual(["kill resources", "quit"]);
});

test("a shutdown deadline kills owned resources before final quit", async () => {
  const calls: string[] = [];
  const shutdown = new ShutdownCoordinator({
    suspend: () => undefined,
    cleanup: () => new Promise<void>(() => undefined),
    fallback: () => { calls.push("kill resources"); },
    quit: () => { calls.push("quit"); },
    deadlineMs: 1,
  });
  shutdown.beforeQuit({ preventDefault: () => undefined });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(calls).toEqual(["kill resources", "quit"]);
});
