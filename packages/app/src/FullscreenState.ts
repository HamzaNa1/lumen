import type { PlaybackRuntime, Unsubscribe } from "@lumen/client/runtime";

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
