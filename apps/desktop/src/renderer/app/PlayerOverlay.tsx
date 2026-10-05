import { PlayerView } from "@lumen/app";
import type { PlayerDisplay } from "@lumen/contracts";
import { useEffect, useState } from "react";
import type { DesktopBridge } from "../../shared/bridge";

/**
 * The controls window that floats above the native video. The main window decides what is
 * playing and hears about the viewer's actions; both travel through the main process.
 */
export const PlayerOverlay = ({
  bridge,
}: {
  readonly bridge: DesktopBridge;
}): React.ReactElement => {
  const [display, setDisplay] = useState<PlayerDisplay | null>(null);

  useEffect(() => {
    const unsubscribe = bridge.player.onDisplay(setDisplay);
    void bridge.player
      .displayState()
      .then(setDisplay)
      .catch(() => undefined);
    return unsubscribe;
  }, [bridge]);

  useEffect(() => {
    // When macOS makes the overlay the key window, Chromium focuses its first control (Back) as if
    // the viewer had pressed Tab, which draws a focus ring as soon as playback starts. Drop that
    // focus unless a key press or click in the overlay caused it.
    let inputPending = false;
    const onInput = (): void => {
      inputPending = true;
      setTimeout(() => {
        inputPending = false;
      }, 0);
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (inputPending || !(event.target instanceof HTMLElement)) return;
      if (event.target.closest(".media-player-header") !== null) event.target.blur();
    };
    window.addEventListener("keydown", onInput, true);
    window.addEventListener("pointerdown", onInput, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onInput, true);
      window.removeEventListener("pointerdown", onInput, true);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, []);

  return (
    <PlayerView display={display} onAction={(action) => void bridge.player.overlayAction(action)} />
  );
};
