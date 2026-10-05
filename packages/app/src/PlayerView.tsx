import type { PlayerAction } from "@lumen/client/runtime";
import type { PlayerDisplay, PlayerState } from "@lumen/contracts";
import { MediaPlayer } from "@lumen/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRuntime } from "./Runtime";
import { useWatchStatus, waitingSummary, WatchGroups } from "./WatchGroups";
import "./player.css";

/**
 * The player controls and their state, drawn over whatever surface the platform plays video on.
 * `display` is null until the application has said what is playing.
 */
export const PlayerView = ({
  display,
  onAction,
}: {
  readonly display: PlayerDisplay | null;
  readonly onAction: (action: PlayerAction) => void;
}): React.ReactElement => {
  const runtime = useRuntime();
  const { capabilities } = runtime;
  const nativeAudio = runtime.playback.nativeAudio;
  const [watchStatus] = useWatchStatus();
  const waiting = waitingSummary(watchStatus.group);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const revealControls = useCallback((): void => {
    setControlsVisible(true);
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    const hideWhenIdle = (): void => {
      const controlsInUse = document.querySelector(
        ".media-player-header:hover, .media-player-console:hover, .media-player-header:focus-within, .media-player-console:focus-within, .media-player-header:has([data-popup-open])",
      );
      if (controlsInUse !== null) hideTimer.current = setTimeout(hideWhenIdle, 1_000);
      else setControlsVisible(false);
    };
    hideTimer.current = setTimeout(hideWhenIdle, 3_000);
  }, []);

  useEffect(() => {
    const onMove = (): void => revealControls();
    window.addEventListener("mousemove", onMove);
    const unsubscribeState = runtime.playback.onState(setPlayer);
    const unsubscribeFullscreen = runtime.playback.onFullscreenChange(setFullscreen);
    void runtime.playback
      .state()
      .then(setPlayer)
      .catch(() => undefined);
    void runtime.playback
      .fullscreenState()
      .then(setFullscreen)
      .catch(() => undefined);
    return () => {
      window.removeEventListener("mousemove", onMove);
      unsubscribeState();
      unsubscribeFullscreen();
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    };
  }, [revealControls, runtime]);

  useEffect(() => {
    if (display === null) return;
    if (display.loading) setPlayer(null);
    revealControls();
  }, [display, revealControls]);

  if (display === null) return <div className="player-overlay" />;

  return (
    <div className="player-overlay">
      <MediaPlayer
        headerActions={<WatchGroups placement="player" />}
        title={display.title}
        subtitle={display.context}
        paused={player?.paused ?? true}
        loading={display.loading}
        error={display.error}
        position={player?.positionSeconds ?? 0}
        duration={player?.durationSeconds ?? display.duration}
        bufferedRanges={player?.bufferedRanges ?? []}
        volume={player?.volume ?? 100}
        muted={player?.muted ?? false}
        streams={capabilities.trackSelection ? (player?.streams ?? []) : []}
        trackSelection={capabilities.trackSelection}
        selectedAudioStreamId={player?.selectedAudioStreamId ?? null}
        selectedSubtitleStreamId={player?.selectedSubtitleStreamId ?? null}
        audioOutput={player?.audioOutput ?? "stereo"}
        onAudioOutput={
          nativeAudio === null || !capabilities.nativeAudioOutput
            ? undefined
            : async (output) => {
                if (player === null) throw new Error("Playback is not active");
                setPlayer(await nativeAudio.output(player.sessionId, output));
              }
        }
        onCopyAudioDiagnostics={
          nativeAudio === null || !capabilities.audioDiagnostics
            ? undefined
            : async () => {
                if (player === null) throw new Error("Playback is not active");
                await nativeAudio.copyDiagnostics(player.sessionId);
              }
        }
        buffering={player?.buffering === true || waiting !== undefined}
        {...(waiting === undefined ? {} : { bufferingMessage: waiting })}
        awaitingInteraction={player?.awaitingInteraction === true}
        onStartPlayback={() => void runtime.playback.allowPlayback().catch(() => undefined)}
        surfaceRef={surfaceRef}
        controlsVisible={controlsVisible || display.loading || display.error !== null}
        fullscreen={fullscreen}
        onBack={() => {
          void runtime.playback
            .stop()
            .catch(() => undefined)
            .then(() => {
              setPlayer(null);
              onAction("back");
            });
        }}
        onRetry={() => onAction("retry")}
        onFullscreen={
          capabilities.fullscreen
            ? () => void runtime.playback.fullscreen(!fullscreen).then(setFullscreen)
            : undefined
        }
        onPause={() => {
          if (player !== null)
            void runtime.playback.pause(player.sessionId, !player.paused).then(setPlayer).catch(() => undefined);
        }}
        onSeek={(positionSeconds) => {
          if (player !== null)
            void runtime.playback
              .seek(player.sessionId, positionSeconds)
              .then(setPlayer)
              .catch(() => undefined);
        }}
        onVolume={(volume, muted) => {
          if (player !== null)
            void runtime.playback
              .volume(player.sessionId, volume, muted)
              .then(setPlayer)
              .catch(() => undefined);
        }}
        onSelectAudio={(streamId) => {
          if (player !== null)
            void runtime.playback
              .selectAudio(player.sessionId, streamId)
              .then(setPlayer)
              .catch(() => undefined);
        }}
        onSelectSubtitle={(streamId) => {
          if (player !== null)
            void runtime.playback
              .selectSubtitle(player.sessionId, streamId)
              .then(setPlayer)
              .catch(() => undefined);
        }}
      />
    </div>
  );
};
