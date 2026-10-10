import type { PlayerAction, PlayerDisplay, PlayerState } from "@lumen/contracts";
import { MediaPlayer } from "@lumen/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRuntime } from "./Runtime";
import { useFullscreen } from "./useFullscreen";
import { useWatchStatus, waitingSummary, WatchGroups } from "./WatchGroups";
import "./player.css";

/** How far into an episode Previous still leads to the episode before it instead of restarting. */
const previousEpisodeWindowSeconds = 10;

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
  const [trackActionError, setTrackActionError] = useState<string | null>(null);
  const trackRequest = useRef(0);
  const currentSession = useRef<string | null>(null);
  currentSession.current = player?.sessionId ?? null;
  const [fullscreen, toggleFullscreen] = useFullscreen();
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const revealControls = useCallback((): void => {
    setControlsVisible(true);
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    const hideWhenIdle = (): void => {
      // Focus left behind by a click is not use: only the pointer, keyboard focus or an open menu is.
      const controlsInUse = document.querySelector(
        ":is(.media-player-header, .media-player-console):is(:hover, :has(:focus-visible), :has([data-popup-open]))",
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
    void runtime.playback
      .state()
      .then(setPlayer)
      .catch(() => undefined);
    return () => {
      window.removeEventListener("mousemove", onMove);
      unsubscribeState();
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    };
  }, [revealControls, runtime]);

  useEffect(() => {
    if (display === null) return;
    if (display.loading) {
      setPlayer(null);
      setTrackActionError(null);
    }
    revealControls();
  }, [display, revealControls]);

  const trackAction = (action: (sessionId: string) => Promise<PlayerState>): void => {
    if (player === null) return;
    const sessionId = player.sessionId;
    const request = ++trackRequest.current;
    setTrackActionError(null);
    void action(sessionId).then(
      (state) => {
        if (currentSession.current === sessionId && trackRequest.current === request)
          setPlayer(state);
      },
      (cause: unknown) => {
        if (currentSession.current === sessionId && trackRequest.current === request)
          setTrackActionError(cause instanceof Error ? cause.message : "Could not change track");
      },
    );
  };

  const seek = (positionSeconds: number): void => {
    if (player !== null)
      void runtime.playback
        .seek(player.sessionId, positionSeconds)
        .then(setPlayer)
        .catch(() => undefined);
  };

  if (display === null) return <div className="player-overlay" />;

  return (
    <div className="player-overlay">
      <MediaPlayer
        trackMemoryError={player?.trackMemoryError ?? null}
        trackActionError={trackActionError}
        onRetryTrackMemory={() => trackAction((id) => runtime.playback.retryTrackMemory(id))}
        onResetTrack={(kind) => trackAction((id) => runtime.playback.resetTrack(id, kind))}
        subtitleSelection={capabilities.nativeAudioOutput}
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
          (runtime.playback.copyDiagnostics === undefined && nativeAudio === null) ||
          !capabilities.audioDiagnostics
            ? undefined
            : async () => {
                if (runtime.playback.copyDiagnostics !== undefined)
                  await runtime.playback.copyDiagnostics();
                else if (player !== null) await nativeAudio?.copyDiagnostics(player.sessionId);
              }
        }
        buffering={player?.buffering === true || waiting !== undefined}
        {...(waiting === undefined ? {} : { bufferingMessage: waiting })}
        awaitingInteraction={player?.awaitingInteraction === true}
        onStartPlayback={() => void runtime.playback.allowPlayback().catch(() => undefined)}
        surfaceRef={surfaceRef}
        controlsVisible={
          controlsVisible ||
          display.loading ||
          display.error !== null ||
          player?.trackMemoryError != null ||
          trackActionError !== null
        }
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
        onFullscreen={toggleFullscreen}
        onPause={() => {
          if (player !== null)
            void runtime.playback
              .pause(player.sessionId, !player.paused)
              .then(setPlayer)
              .catch(() => undefined);
        }}
        onSeek={seek}
        onPrevious={() => {
          if (
            display.hasPreviousEpisode &&
            (player?.positionSeconds ?? 0) < previousEpisodeWindowSeconds
          )
            onAction("previous-episode");
          else seek(0);
        }}
        onNext={display.nextEpisode === null ? undefined : () => onAction("next-episode")}
        nextTitle={display.nextEpisode ?? undefined}
        onVolume={(volume, muted) => {
          if (player !== null)
            void runtime.playback
              .volume(player.sessionId, volume, muted)
              .then(setPlayer)
              .catch(() => undefined);
        }}
        onSelectAudio={(streamId) =>
          trackAction((id) => runtime.playback.selectAudio(id, streamId))
        }
        onSelectSubtitle={(streamId) =>
          trackAction((id) => runtime.playback.selectSubtitle(id, streamId))
        }
      />
    </div>
  );
};
