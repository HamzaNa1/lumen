import { VolumeMemory } from "@lumen/contracts";
import { Schema } from "effect";
import type { VolumeMemoryStorage } from "./HtmlMediaPlayer";

// Named for when it held a single volume; what was kept there then still reads as the latest.
const STORAGE_KEY = "lumen.volume";

/** The volumes this browser's viewer set, kept for each title they play here. */
export const storedVolumeMemory: VolumeMemoryStorage = {
  read: () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored === null ? null : Schema.decodeUnknownSync(VolumeMemory)(JSON.parse(stored));
    } catch {
      // Storage is unavailable or holds something else: the browser's own volume stands.
      return null;
    }
  },
  write: (memory) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
    } catch {
      // Storage is unavailable (private browsing, blocked site data): the volume lasts the page.
    }
  },
};
