import { useCallback, useEffect, useRef, useState } from "react";
import { createFullscreenController, type FullscreenController } from "./FullscreenState";
import { useRuntime } from "./Runtime";

/**
 * Whether the player is fullscreen, and the toggle for it. The toggle is undefined where
 * fullscreen is unavailable.
 */
export const useFullscreen = (): readonly [boolean, (() => void) | undefined] => {
  const runtime = useRuntime();
  const [fullscreen, setFullscreen] = useState(false);
  const controller = useRef<FullscreenController | null>(null);

  useEffect(() => {
    const next = createFullscreenController(runtime.playback, setFullscreen);
    controller.current = next;
    return () => {
      if (controller.current === next) controller.current = null;
      next.dispose();
    };
  }, [runtime]);

  const toggle = useCallback((): void => {
    controller.current?.toggle();
  }, []);

  return [fullscreen, runtime.capabilities.fullscreen ? toggle : undefined];
};
