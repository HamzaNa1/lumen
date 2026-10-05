import type { PlayerState, WatchAction } from "@lumen/contracts";

/** This device's player, as the viewer's own commands reach it. */
export interface LocalPlayback<Started> {
  readonly start: (itemId: string, startAtSeconds?: number) => Promise<Started>;
  readonly pause: (sessionId: string, paused: boolean) => Promise<PlayerState>;
  readonly seek: (sessionId: string, positionSeconds: number) => Promise<PlayerState>;
  /** The state of a session that is still the one playing; throws for any other. */
  readonly getActiveState: (sessionId: string) => PlayerState;
}

export interface GroupPlayback {
  readonly grouped: boolean;
  readonly action: (action: WatchAction) => Promise<void>;
}

/**
 * Carries out what a viewer asks of playback. Watching alone, that is this device's player.
 * In a watch group it is the group: the command goes to everyone, and this device's player
 * follows the group's shared state like every other member's, so it is not touched here.
 */
export const viewerPlayback = <Started>(watch: GroupPlayback, local: LocalPlayback<Started>) => ({
  /** Resolves to null when the group, rather than this player, was asked to play. */
  start: async (itemId: string, startAtSeconds?: number, title?: string): Promise<Started | null> => {
    if (!watch.grouped) return local.start(itemId, startAtSeconds);
    await watch.action({
      type: "play",
      itemId,
      positionSeconds: startAtSeconds ?? 0,
      ...(title === undefined ? {} : { title }),
    });
    return null;
  },
  pause: async (sessionId: string, paused: boolean): Promise<PlayerState> => {
    if (!watch.grouped) return local.pause(sessionId, paused);
    const state = local.getActiveState(sessionId);
    await watch.action({
      type: "pause",
      itemId: state.itemId,
      paused,
      positionSeconds: state.positionSeconds,
    });
    return local.getActiveState(sessionId);
  },
  seek: async (sessionId: string, positionSeconds: number): Promise<PlayerState> => {
    if (!watch.grouped) return local.seek(sessionId, positionSeconds);
    const state = local.getActiveState(sessionId);
    await watch.action({ type: "seek", itemId: state.itemId, positionSeconds });
    return local.getActiveState(sessionId);
  },
});
