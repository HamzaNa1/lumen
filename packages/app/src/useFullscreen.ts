import { useCallback, useEffect, useState } from "react";
import { observeFullscreenState } from "./FullscreenState";
import { useRuntime } from "./Runtime";

/**
 * Whether the player is fullscreen, and the toggle for it. The toggle is undefined where
 * fullscreen is unavailable.
 */
export const useFullscreen = (): readonly [boolean, (() => void) | undefined] => {
  const runtime = useRuntime();
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => observeFullscreenState(runtime.playback, setFullscreen), [runtime]);

  const toggle = useCallback((): void => {
    // Completion of the request need not mean the native fullscreen transition has finished.
    void runtime.playback.fullscreen(!fullscreen).catch(() => undefined);
  }, [fullscreen, runtime]);

  return [fullscreen, runtime.capabilities.fullscreen ? toggle : undefined];
};
