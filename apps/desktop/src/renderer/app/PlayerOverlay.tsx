import type { IpcPlayerDisplay, IpcPlayerState } from "@lumen/contracts";
import { MediaPlayer } from "@lumen/ui";
import { useCallback, useEffect, useRef, useState } from "react";

const bridge = window.lumen;

export const PlayerOverlay = (): React.ReactElement => {
  const [player, setPlayer] = useState<IpcPlayerState | null>(null);
  const [display, setDisplay] = useState<IpcPlayerDisplay | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const revealControls = useCallback((): void => {
    setControlsVisible(true);
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    const hideWhenIdle = (): void => {
      const controlsInUse = document.querySelector(
        ".media-player-header:hover, .media-player-console:hover, .media-player-header:focus-within, .media-player-console:focus-within",
      );
      if (controlsInUse !== null) hideTimer.current = setTimeout(hideWhenIdle, 1_000);
      else setControlsVisible(false);
    };
    hideTimer.current = setTimeout(hideWhenIdle, 3_000);
  }, []);

  useEffect(() => {
    const onMove = (): void => revealControls();
    window.addEventListener("mousemove", onMove);
    const unsubscribeState = bridge.player.onState(setPlayer);
    const unsubscribeDisplay = bridge.player.onDisplay((next) => {
      setDisplay(next);
      if (next.loading) setPlayer(null);
      revealControls();
    });
    const unsubscribeFullscreen = bridge.player.onFullscreenChange(setFullscreen);
    void bridge.player
      .state()
      .then(setPlayer)
      .catch(() => undefined);
    void bridge.player
      .displayState()
      .then((initial) => {
        setDisplay(initial);
        if (initial !== null) revealControls();
      })
      .catch(() => undefined);
    void bridge.player
      .fullscreenState()
      .then(setFullscreen)
      .catch(() => undefined);
    return () => {
      window.removeEventListener("mousemove", onMove);
      unsubscribeState();
      unsubscribeDisplay();
      unsubscribeFullscreen();
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    };
  }, [revealControls]);

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

  if (display === null) return <div className="player-overlay" />;

  return (
    <div className="player-overlay">
      <MediaPlayer
        title={display.title}
        subtitle={display.context}
        paused={player?.paused ?? true}
        loading={display.loading}
        error={display.error}
        position={player?.positionSeconds ?? 0}
        duration={player?.durationSeconds ?? display.duration}
        volume={player?.volume ?? 100}
        muted={player?.muted ?? false}
        streams={player?.streams ?? []}
        selectedAudioStreamId={player?.selectedAudioStreamId ?? null}
        selectedSubtitleStreamId={player?.selectedSubtitleStreamId ?? null}
        surfaceRef={surfaceRef}
        controlsVisible={controlsVisible || display.loading || display.error !== null}
        fullscreen={fullscreen}
        onBack={() => {
          void bridge.player
            .stop()
            .catch(() => undefined)
            .then(() => {
              setPlayer(null);
              return bridge.player.overlayAction("back");
            });
        }}
        onRetry={() => void bridge.player.overlayAction("retry")}
        onFullscreen={() => void bridge.player.fullscreen(!fullscreen).then(setFullscreen)}
        onPause={() => {
          if (player !== null)
            void bridge.player.pause(player.sessionId, !player.paused).then(setPlayer);
        }}
        onSeek={(positionSeconds) => {
          if (player !== null)
            void bridge.player.seek(player.sessionId, positionSeconds).then(setPlayer);
        }}
        onVolume={(volume, muted) => {
          if (player !== null)
            void bridge.player.volume(player.sessionId, volume, muted).then(setPlayer);
        }}
        onSelectAudio={(streamId) => {
          if (player !== null)
            void bridge.player.selectAudio(player.sessionId, streamId).then(setPlayer);
        }}
        onSelectSubtitle={(streamId) => {
          if (player !== null)
            void bridge.player.selectSubtitle(player.sessionId, streamId).then(setPlayer);
        }}
      />
    </div>
  );
};
