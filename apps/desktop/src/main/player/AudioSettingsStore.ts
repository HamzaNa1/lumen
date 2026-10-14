import { AudioOutput, VolumeSettings } from "@lumen/contracts";
import { Schema } from "effect";
import { JsonFileStore } from "../storage/JsonFileStore";

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
  private constructor(private readonly store: JsonFileStore<AudioSettings>) {}

  static async open(path: string): Promise<AudioSettingsStore> {
    return new AudioSettingsStore(
      await JsonFileStore.open({
        path,
        schema: AudioSettings,
        defaults: defaultAudioSettings,
        name: "audio settings",
      }),
    );
  }

  /** Settings that last only as long as the store. */
  static inMemory(): AudioSettingsStore {
    return new AudioSettingsStore(JsonFileStore.inMemory(defaultAudioSettings()));
  }

  get current(): AudioSettings {
    return this.store.current;
  }

  update(changes: Partial<AudioSettings>): void {
    this.store.set({ ...this.store.current, ...changes });
  }
}
