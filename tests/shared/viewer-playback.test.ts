import { expect, test } from "bun:test";
import { type LocalPlayback, viewerPlayback } from "../../packages/client/src/index.ts";
import type { PlayerState, WatchAction } from "../../packages/contracts/src/index.ts";

const setup = (grouped: boolean) => {
  const state = { sessionId: "session", itemId: "item", positionSeconds: 12 } as PlayerState;
  const local: string[] = [];
  const group: WatchAction[] = [];
  const player: LocalPlayback<string> = {
    start: async (itemId, startAtSeconds) => {
      local.push(`start ${itemId} @${startAtSeconds}`);
      return "started";
    },
    pause: async (sessionId, paused) => {
      local.push(`pause ${sessionId} ${paused}`);
      return state;
    },
    seek: async (sessionId, positionSeconds) => {
      local.push(`seek ${sessionId} @${positionSeconds}`);
      return state;
    },
    getActiveState: (sessionId) => {
      if (sessionId !== state.sessionId) throw new Error("Playback session is not active");
      return state;
    },
  };
  const commands = viewerPlayback(
    { grouped, action: async (action) => void group.push(action) },
    player,
  );
  return { commands, local, group, state };
};

test("a viewer watching alone commands this device's player", async () => {
  const { commands, local, group, state } = setup(false);
  expect(await commands.start("item", 30)).toBe("started");
  expect(await commands.pause("session", true)).toBe(state);
  expect(await commands.seek("session", 45)).toBe(state);
  expect(local).toEqual(["start item @30", "pause session true", "seek session @45"]);
  expect(group).toEqual([]);
});

test("a viewer in a watch group commands the group and leaves this device's player to follow", async () => {
  const { commands, local, group, state } = setup(true);
  expect(await commands.start("item")).toBeNull();
  expect(await commands.pause("session", true)).toBe(state);
  expect(await commands.seek("session", 45)).toBe(state);
  expect(group).toEqual([
    { type: "play", itemId: "item", positionSeconds: 0 },
    { type: "pause", itemId: "item", paused: true, positionSeconds: 12 },
    { type: "seek", itemId: "item", positionSeconds: 45 },
  ]);
  expect(local).toEqual([]);
  // A session that is no longer playing cannot command the group.
  await expect(commands.pause("replaced", true)).rejects.toThrow("not active");
  expect(group).toHaveLength(3);
});

for (const command of ["pause", "seek"] as const) {
  test(`a delayed group ${command} cannot return a replaced session's state`, async () => {
    const { state } = setup(true);
    let active: PlayerState | null = state;
    let answer!: () => void;
    const gate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const commands = viewerPlayback(
      { grouped: true, action: () => gate },
      {
        start: async () => undefined,
        pause: async () => state,
        seek: async () => state,
        getActiveState: (sessionId) => {
          if (active?.sessionId !== sessionId) throw new Error("Playback session is not active");
          return active;
        },
      },
    );
    const pending =
      command === "pause" ? commands.pause("session", true) : commands.seek("session", 45);
    active = { ...state, sessionId: "replacement" };
    answer();
    await expect(pending).rejects.toThrow("not active");
  });
}
