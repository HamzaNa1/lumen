import { VolumeSettings } from "@lumen/contracts";
import { Schema } from "effect";
import type { VolumeSettingsStorage } from "./HtmlMediaPlayer";

const STORAGE_KEY = "lumen.volume";

/** The volume this browser's viewer last set, shared by everything they play here. */
export const storedVolumeSettings: VolumeSettingsStorage = {
  read: () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored === null
        ? null
        : Schema.decodeUnknownSync(VolumeSettings)(JSON.parse(stored));
    } catch {
      // Storage is unavailable or holds something else: the browser's own volume stands.
      return null;
    }
  },
  write: (settings) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage is unavailable (private browsing, blocked site data): the volume lasts the page.
    }
  },
};
