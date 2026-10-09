import { AudioOutput, VolumeSettings } from "@lumen/contracts";
import { Schema } from "effect";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const AudioSettings = Schema.Struct({ ...VolumeSettings.fields, audioOutput: AudioOutput });
export type AudioSettings = Schema.Schema.Type<typeof AudioSettings>;

const defaultAudioSettings = (): AudioSettings => ({
  volume: 100,
  muted: false,
  // Avoid relying on a Windows driver to downmix center/surround channels.
  // Automatic output remains available for a correctly configured surround system.
  audioOutput: process.platform === "win32" ? "stereo" : "auto-safe",
});

/** The viewer's volume and audio output, shared by everything this installation plays. */
export class AudioSettingsStore {
  private writing = false;
  private unwritten = false;

  private constructor(
    private settings: AudioSettings,
    private readonly path: string | null,
  ) {}

  static async open(path: string): Promise<AudioSettingsStore> {
    try {
      const stored = Schema.decodeUnknownSync(AudioSettings)(
        JSON.parse(await readFile(path, "utf8")),
      );
      return new AudioSettingsStore(stored, path);
    } catch {
      // Nothing was kept yet, or what was kept is unreadable: start from the defaults.
      return new AudioSettingsStore(defaultAudioSettings(), path);
    }
  }

  /** Settings that last only as long as the store. */
  static inMemory(): AudioSettingsStore {
    return new AudioSettingsStore(defaultAudioSettings(), null);
  }

  get current(): AudioSettings {
    return this.settings;
  }

  update(changes: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...changes };
    if (this.path === null) return;
    this.unwritten = true;
    if (!this.writing) void this.write(this.path);
  }

  /** One write at a time, so a drag of the volume slider ends with its last value on disk. */
  private async write(path: string): Promise<void> {
    this.writing = true;
    try {
      while (this.unwritten) {
        this.unwritten = false;
        const temporary = `${path}.tmp`;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temporary, JSON.stringify(this.settings));
        await rename(temporary, path);
      }
    } catch (cause) {
      console.error("Failed to save audio settings", cause);
    } finally {
      this.writing = false;
    }
  }
}
