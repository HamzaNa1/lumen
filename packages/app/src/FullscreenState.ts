import type { PlaybackRuntime, Unsubscribe } from "@lumen/client/runtime";

type FullscreenPlayback = Pick<
  PlaybackRuntime,
  "fullscreen" | "fullscreenState" | "onFullscreenChange"
>;

export interface FullscreenController {
  readonly toggle: () => void;
  readonly dispose: Unsubscribe;
}

export const observeFullscreenState = (
  playback: Pick<PlaybackRuntime, "fullscreenState" | "onFullscreenChange">,
  onChange: (fullscreen: boolean) => void,
): Unsubscribe => {
  let active = true;
  let changed = false;
  const unsubscribe = playback.onFullscreenChange((fullscreen) => {
    if (!active) return;
    changed = true;
    onChange(fullscreen);
  });
  void playback
    .fullscreenState()
    .then((fullscreen) => {
      // A native event is newer than the initial snapshot, even if its IPC reply arrives later.
      if (active && !changed) onChange(fullscreen);
    })
    .catch(() => undefined);
  return () => {
    active = false;
    unsubscribe();
  };
};

/**
 * Tracks fullscreen state and toggles from the latest requested target so a second toggle made
 * before the platform finishes its transition reverses it instead of repeating the same request.
 */
export const createFullscreenController = (
  playback: FullscreenPlayback,
  onChange: (fullscreen: boolean) => void,
): FullscreenController => {
  let active = true;
  let actual = false;
  let target = false;
  let inFlight = 0;

  const stopObserving = observeFullscreenState(playback, (fullscreen) => {
    actual = fullscreen;
    if (inFlight === 0) target = fullscreen;
    onChange(fullscreen);
  });

  const toggle = (): void => {
    if (!active) return;
    const next = !target;
    target = next;
    inFlight += 1;
    // Completion of the request need not mean the native fullscreen transition has finished.
    void playback.fullscreen(next).then(
      (current) => {
        inFlight = Math.max(0, inFlight - 1);
        if (inFlight === 0) target = current;
      },
      () => {
        inFlight = Math.max(0, inFlight - 1);
        if (inFlight === 0) target = actual;
      },
    );
  };

  const dispose = (): void => {
    active = false;
    stopObserving();
  };

  return { toggle, dispose };
};
