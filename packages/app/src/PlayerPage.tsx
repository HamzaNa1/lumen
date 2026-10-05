import { usePlayerShortcuts } from "@lumen/ui";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef } from "react";
import { PlayerView } from "./PlayerView";
import { useRuntime } from "./Runtime";
import { useWorkspace } from "./Workspace";

export const PlayerPage = (): React.ReactElement => {
  const {
    watchPlayback,
    playingItem,
    player,
    playbackLoading,
    playbackError,
    playerDisplay,
    onPlayerAction,
    beginPlayback,
    reportPlaybackError,
  } = useWorkspace();
  const runtime = useRuntime();
  const navigate = useNavigate();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const hasPlayback = watchPlayback !== null || playingItem !== null || player !== null;
  // Inline controls bind the same shortcuts themselves.
  const inlineControls = runtime.playback.presentation.kind === "inline";

  usePlayerShortcuts({
    enabled: !inlineControls && player !== null && !playbackLoading && playbackError === null,
    position: player?.positionSeconds ?? 0,
    duration: player?.durationSeconds ?? null,
    onPause: () => {
      if (player !== null)
        void runtime.playback.pause(player.sessionId, !player.paused).catch(() => undefined);
    },
    onSeek: (positionSeconds) => {
      if (player !== null)
        void runtime.playback.seek(player.sessionId, positionSeconds).catch(() => undefined);
    },
  });

  useEffect(() => {
    if (!hasPlayback) void navigate({ to: "/", replace: true });
  }, [hasPlayback, navigate]);

  useEffect(
    () => () => {
      void runtime.playback.fullscreen(false).catch(() => undefined);
    },
    [runtime],
  );

  useLayoutEffect(() => {
    if (!hasPlayback) return;
    const element = surfaceRef.current;
    if (element === null) return;
    let disposed = false;
    const surface = runtime.playback.mountSurface(element, reportPlaybackError);
    void surface.ready
      .then(() => {
        if (!disposed && playingItem !== null) void beginPlayback(playingItem);
      })
      .catch(reportPlaybackError);
    return () => {
      disposed = true;
      surface.release();
    };
  }, [beginPlayback, hasPlayback, playingItem, reportPlaybackError, runtime]);

  if (!hasPlayback) {
    return <div className="watch-page" />;
  }

  return (
    <div className={`watch-page${inlineControls ? " has-inline-controls" : ""}`}>
      <div className="watch-surface" ref={surfaceRef} />
      {inlineControls ? <PlayerView display={playerDisplay} onAction={onPlayerAction} /> : null}
    </div>
  );
};
