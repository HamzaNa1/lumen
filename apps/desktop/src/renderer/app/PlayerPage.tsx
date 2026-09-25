import { useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef } from "react";
import { bridge, useWorkspace } from "./Workspace";

export const PlayerPage = (): React.ReactElement => {
  const { playingItem, player, beginPlayback, reportPlaybackError } = useWorkspace();
  const navigate = useNavigate();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const hasPlayback = playingItem !== null || player !== null;

  useEffect(() => {
    if (!hasPlayback) void navigate({ to: "/", replace: true });
  }, [hasPlayback, navigate]);

  useEffect(
    () => () => {
      void bridge.player.fullscreen(false).catch(() => undefined);
    },
    [],
  );

  useLayoutEffect(() => {
    if (!hasPlayback) return;
    const surface = surfaceRef.current;
    if (surface === null) return;
    let disposed = false;
    const syncSurface = async (): Promise<void> => {
      const bounds = surface.getBoundingClientRect();
      if (bounds.width < 1 || bounds.height < 1) return;
      await bridge.player.surface({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    };
    void syncSurface()
      .then(() => {
        if (!disposed && playingItem !== null) void beginPlayback(playingItem);
      })
      .catch(reportPlaybackError);
    const observer = new ResizeObserver(() => void syncSurface().catch(reportPlaybackError));
    observer.observe(surface);
    return () => {
      disposed = true;
      observer.disconnect();
      void bridge.player.surface(null).catch(() => undefined);
    };
  }, [beginPlayback, hasPlayback, playingItem, reportPlaybackError]);

  if (playingItem === null && player === null) {
    return <div className="watch-page" />;
  }

  return (
    <div className="watch-page">
      <div className="watch-surface" ref={surfaceRef} />
    </div>
  );
};
