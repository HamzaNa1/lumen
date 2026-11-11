import { type PlaybackSessionApi, ServerUnreachableError } from "@lumen/client";
import type { PlayerSession, PreloadTicket, TrackChoiceInput, TrackMemory } from "@lumen/contracts";

/**
 * What the player needs from wherever an item is played from: the server, or this device's
 * downloads while the server cannot be reached.
 */
export interface PlaybackClient extends PlaybackSessionApi {
  readonly serverOrigin: string;
  /** The server the bytes belong to; null until the server has said who it is. */
  readonly serverId: string | null;
  readonly supportsTranscoding: boolean;
  readonly startPlayback: (itemId: string) => Promise<PlayerSession>;
  readonly saveTrackChoice: (
    sessionId: string,
    choice: TrackChoiceInput,
  ) => Promise<TrackMemory | null>;
  /** Extends a session's grant to the item after the one it plays; absent where nothing can. */
  readonly preloadNext?: (sessionId: string, itemId: string) => Promise<PreloadTicket | null>;
  /** Set when nothing can be fetched: only bytes already on this device can play. */
  readonly offline?: boolean;
}

/**
 * Plays from the server, and from this device's download of an item when the server cannot be
 * reached as playback starts. Each playback gets its own, so the choice holds for that session.
 */
export const withOfflineFallback = (
  online: PlaybackClient,
  offline: PlaybackClient,
  playsOffline: (itemId: string) => boolean,
): PlaybackClient => {
  let current = online;
  return {
    get serverOrigin() {
      return current.serverOrigin;
    },
    get serverId() {
      return online.serverId ?? offline.serverId;
    },
    get supportsTranscoding() {
      return current.supportsTranscoding;
    },
    get offline() {
      return current.offline === true;
    },
    startPlayback: async (itemId) => {
      current = online;
      try {
        return await online.startPlayback(itemId);
      } catch (cause) {
        if (!(cause instanceof ServerUnreachableError) || !playsOffline(itemId)) throw cause;
        current = offline;
        return offline.startPlayback(itemId);
      }
    },
    heartbeat: (sessionId, state) => current.heartbeat(sessionId, state),
    progress: (sessionId, state, sequence, init) =>
      current.progress(sessionId, state, sequence, init),
    stopPlayback: (sessionId) => current.stopPlayback(sessionId),
    saveTrackChoice: (sessionId, choice) => current.saveTrackChoice(sessionId, choice),
    preloadNext: async (sessionId, itemId) =>
      (await current.preloadNext?.(sessionId, itemId)) ?? null,
  };
};
