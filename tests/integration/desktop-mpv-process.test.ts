import { describe, expect, mock, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { MpvProcess } from "../../apps/desktop/src/main/player/MpvProcess";

describe("MPV subprocess lifecycle", () => {
  test("stop and overlapping stops wait until the old process releases its window and audio", async () => {
    const child = Object.assign(new EventEmitter(), { kill: mock(() => true) });
    const player = Reflect.construct(MpvProcess, [
      child,
      null,
      "test-pipe",
      () => undefined,
    ]) as MpvProcess;
    let stopped = 0;
    const first = player.stop().then(() => stopped++);
    const second = player.stop().then(() => stopped++);
    await Promise.resolve();
    expect(stopped).toBe(0);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(player.socketPath).toBeNull();

    child.emit("exit", 0);
    await Promise.all([first, second]);
    expect(stopped).toBe(2);
    await player.stop();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  test("stopping an already exited process does not send another signal", async () => {
    const child = Object.assign(new EventEmitter(), {
      kill: mock(() => true),
    }) as unknown as ChildProcess;
    const player = Reflect.construct(MpvProcess, [
      child,
      null,
      "test-pipe",
      () => undefined,
    ]) as MpvProcess;
    child.emit("exit", 1);
    await player.stop();
    expect(child.kill).not.toHaveBeenCalled();
    expect(player.socketPath).toBeNull();
  });

  test("a missing executable is a recoverable startup error", async () => {
    const child = Object.assign(new EventEmitter(), { kill: mock(() => true) });
    const player = Reflect.construct(MpvProcess, [
      child,
      null,
      "test-pipe",
      () => undefined,
    ]) as MpvProcess;
    const error = new Error("spawn mpv.exe ENOENT");
    child.emit("error", error);
    expect(player.error).toBe(error);
    expect(player.socketPath).toBeNull();
    await player.stop();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
