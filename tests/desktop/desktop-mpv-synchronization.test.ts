import { expect, spyOn, test } from "bun:test";
import { sampleMpvPlayback } from "../../apps/desktop/src/main/player/MpvSynchronization";

const state = {
  sessionId: "session",
  itemId: "item",
  positionSeconds: 1,
  durationSeconds: 100,
  paused: false,
};

test("MPV samples position and motion atomically without using cached UI state", async () => {
  let clock = 1000;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  try {
    const sample = await sampleMpvPlayback(
      {
        command: async (args) => {
          expect(args[0]).toBe("expand-text");
          expect(String(args[1])).toContain(`\${=paused-for-cache}`);
          clock += 40;
          return "12.5\tno\tno\tno\tno\t0.99";
        },
      },
      state,
    );
    expect(sample).toEqual({
      ...state,
      positionSeconds: 12.5,
      speed: 0.99,
      sampledAtMs: 1020,
      advancing: true,
    });
  } finally {
    now.mockRestore();
  }
});

test.each(["yes\tno\tno\tno", "no\tyes\tno\tno", "no\tno\tyes\tno", "no\tno\tno\tyes"])(
  "MPV never projects motion during pause, cache pause, seeking or EOF (%s)",
  async (flags) => {
    const sample = await sampleMpvPlayback({ command: async () => `12.5\t${flags}\t1` }, state);
    expect(sample?.advancing).toBe(false);
  },
);

test("delayed and unavailable MPV samples cannot manufacture drift", async () => {
  let clock = 1000;
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  try {
    expect(
      await sampleMpvPlayback(
        {
          command: async () => {
            clock += 110;
            return "12.5\tno\tno\tno\tno\t1";
          },
        },
        state,
      ),
    ).toBeNull();
    for (const value of [
      null,
      "",
      "(unavailable)\tno\tno\tno\tno\t1",
      "NaN\tno\tno\tno\tno\t1",
      "12\tno\tunknown\tno\tno\t1",
    ])
      expect(await sampleMpvPlayback({ command: async () => value }, state)).toBeNull();
    expect(
      sampleMpvPlayback(
        {
          command: async () => {
            throw new Error("IPC closed");
          },
        },
        state,
      ),
    ).rejects.toThrow("IPC closed");
  } finally {
    now.mockRestore();
  }
});

test("an unresponsive sync read yields control without waiting for the transport timeout", async () => {
  let release = (_value: string) => {};
  const answer = new Promise<string>((resolve) => {
    release = resolve;
  });
  expect(await sampleMpvPlayback({ command: () => answer }, state)).toBeNull();
  release("12.5\tno\tno\tno\tno\t1");
  await answer;
});
