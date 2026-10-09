import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioSettingsStore } from "../../apps/desktop/src/main/player/AudioSettingsStore";

const withSettingsFile = async (run: (path: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "audio-settings-"));
  try {
    await run(join(directory, "nested", "audio-settings.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** Waits for the store's writes to leave the expected settings in its file. */
const expectStored = async (path: string, expected: object): Promise<void> => {
  const deadline = Date.now() + 5000;
  for (;;) {
    const stored: unknown = JSON.parse(await readFile(path, "utf8").catch(() => "null"));
    if (Date.now() >= deadline) expect(stored).toMatchObject(expected);
    if (Bun.deepEquals({ ...(stored as object), ...expected }, stored)) return;
    await Bun.sleep(10);
  }
};

describe("desktop audio settings", () => {
  test("what the viewer sets is there the next time the app opens", () =>
    withSettingsFile(async (path) => {
      const store = await AudioSettingsStore.open(path);
      expect(store.current).toMatchObject({ volume: 100, muted: false });
      store.update({ volume: 40, muted: true });
      store.update({ audioOutput: "stereo" });
      const expected = { volume: 40, muted: true, audioOutput: "stereo" };
      await expectStored(path, expected);
      expect((await AudioSettingsStore.open(path)).current).toEqual(expected);
    }));

  test("a drag of the volume slider leaves its last value on disk", () =>
    withSettingsFile(async (path) => {
      const store = await AudioSettingsStore.open(path);
      for (let volume = 0; volume <= 60; volume += 1) store.update({ volume });
      await expectStored(path, { volume: 60 });
    }));

  test("settings that cannot be read fall back to the defaults", () =>
    withSettingsFile(async (path) => {
      const defaults = AudioSettingsStore.inMemory().current;
      const store = await AudioSettingsStore.open(path);
      store.update({ volume: 10 });
      await expectStored(path, { volume: 10 });
      await writeFile(path, JSON.stringify({ volume: 400, muted: false, audioOutput: "stereo" }));
      expect((await AudioSettingsStore.open(path)).current).toEqual(defaults);
    }));
});
