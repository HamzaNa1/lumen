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

  return (
    <PlayerView display={display} onAction={(action) => void bridge.player.overlayAction(action)} />
  );
};
