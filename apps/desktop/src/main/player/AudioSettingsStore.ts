import {
  AudioOutput,
  rememberTitleVolume,
  VolumeMemory,
  volumeForTitle,
  type VolumeSettings,
} from "@lumen/contracts";
import { Schema } from "effect";
import { JsonFileStore } from "../storage/JsonFileStore";

const AudioSettings = Schema.Struct({ ...VolumeMemory.fields, audioOutput: AudioOutput });
export type AudioSettings = Schema.Schema.Type<typeof AudioSettings>;

const defaultAudioSettings = (): AudioSettings => ({
  volume: 100,
  muted: false,
  // Avoid relying on a Windows driver to downmix center/surround channels.
  // Automatic output remains available for a correctly configured surround system.
  audioOutput: process.platform === "win32" ? "stereo" : "auto-safe",
});

/** The viewer's audio output, and the volume they keep for each title this installation plays. */
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

  /** The volume a title plays at; see {@link volumeForTitle}. */
  volumeFor(titleId: string | null): VolumeSettings {
    return volumeForTitle(this.store.current, titleId);
  }

  rememberVolume(titleId: string | null, volume: VolumeSettings): void {
    this.update(rememberTitleVolume(this.store.current, titleId, volume));
  }

  update(changes: Partial<AudioSettings>): void {
    this.store.set({ ...this.store.current, ...changes });
  }
}
