import { useCallback, useEffect, useState } from "react";
import { useRuntime } from "./Runtime";

/**
 * Whether the player is fullscreen, and the toggle for it. The toggle is undefined where
 * fullscreen is unavailable.
 */
export const useFullscreen = (): readonly [boolean, (() => void) | undefined] => {
  const runtime = useRuntime();
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const unsubscribe = runtime.playback.onFullscreenChange(setFullscreen);
    void runtime.playback
      .fullscreenState()
      .then(setFullscreen)
      .catch(() => undefined);
    return unsubscribe;
  }, [runtime]);

  const toggle = useCallback((): void => {
    void runtime.playback
      .fullscreen(!fullscreen)
      .then(setFullscreen)
      .catch(() => undefined);
  }, [fullscreen, runtime]);

  return [fullscreen, runtime.capabilities.fullscreen ? toggle : undefined];
};
