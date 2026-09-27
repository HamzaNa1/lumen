import { useNavigate } from "@tanstack/react-router";
import { usePlayerShortcuts } from "@lumen/ui";
import { useEffect, useLayoutEffect, useRef } from "react";
import { bridge, useWorkspace } from "./Workspace";

export const PlayerPage = (): React.ReactElement => {
  const {
    playingItem,
    player,
    group,
    playbackLoading,
    playbackError,
    surfaceReady,
    reportPlaybackError,
  } = useWorkspace();
  const navigate = useNavigate();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const hasPlayback =
    playingItem !== null ||
    player !== null ||
    (group?.snapshot?.playback.type === "playback" &&
      group.snapshot.playback.state.media !== null &&
      ["playing", "paused"].includes(group.snapshot.playback.state.mode));

  usePlayerShortcuts({
    enabled:
      player !== null &&
      !playbackLoading &&
      playbackError === null &&
      (group === null || group.status === "ready"),
    position: player?.positionSeconds ?? 0,
    duration: player?.durationSeconds ?? null,
    onPause: () => {
      if (player !== null)
        void bridge.player.pause(player.sessionId, !player.paused).catch(() => undefined);
    },
    onSeek: (positionSeconds) => {
      if (player !== null)
        void bridge.player.seek(player.sessionId, positionSeconds).catch(() => undefined);
    },
  });

  useEffect(() => {
    if (!hasPlayback) void navigate({ to: group === null ? "/" : "/watch-groups", replace: true });
  }, [group, hasPlayback, navigate]);

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
        if (!disposed) surfaceReady();
      })
      .catch(reportPlaybackError);
    const observer = new ResizeObserver(() => void syncSurface().catch(reportPlaybackError));
    observer.observe(surface);
    return () => {
      disposed = true;
      observer.disconnect();
      void bridge.player.surface(null).catch(() => undefined);
    };
  }, [surfaceReady, hasPlayback, reportPlaybackError]);

  if (!hasPlayback) {
    return <div className="watch-page" />;
  }

  return (
    <div className="watch-page">
      <div className="watch-surface" ref={surfaceRef} />
    </div>
  );
};
