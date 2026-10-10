import { Slider } from "@base-ui/react/slider";
import type { AudioOutput, BufferedRange, PlayableStream } from "@lumen/contracts";
import {
  ArrowLeft,
  LoaderCircle,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Settings2,
  SkipBack,
  SkipForward,
  TriangleAlert,
  Volume2,
  VolumeX,
} from "lucide-react";
import { type ReactNode, type Ref, useEffect, useState } from "react";
import { Button } from "./Button";
import { SelectField } from "./Controls";
import { formatEndsAt, formatPlayerTime, streamLabels } from "./PlayerFormatting";
import { useNow } from "./useNow";
import { usePlayerShortcuts } from "./usePlayerShortcuts";
import { useThrottledCallback } from "./useThrottledCallback";

/** How often a drag of the volume slider reaches the player. */
const volumeDragIntervalMs = 50;
/** How long before the end the viewer is told that what follows is about to play. */
const upNextNoticeSeconds = 30;

interface MediaPlayerProps {
  readonly headerActions?: ReactNode;
  readonly trackMemoryError?: string | null;
  readonly trackActionError?: string | null;
  readonly onResetTrack?: (kind: "audio" | "subtitle") => void;
  readonly onRetryTrackMemory?: () => void;
  readonly title: string;
  readonly subtitle?: string;
  readonly paused: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly position: number;
  readonly duration: number | null;
  readonly bufferedRanges: ReadonlyArray<BufferedRange>;
  readonly volume: number;
  readonly muted: boolean;
  readonly streams: ReadonlyArray<PlayableStream>;
  readonly selectedAudioStreamId: string | null;
  readonly selectedSubtitleStreamId: string | null;
  readonly audioOutput: AudioOutput;
  /** Omitted where the player does not control the audio device. */
  readonly onAudioOutput?: (output: AudioOutput) => Promise<void>;
  /** Exports retained diagnostics even when playback has failed. */
  readonly onCopyAudioDiagnostics?: () => Promise<void>;
  /** False where the player cannot switch tracks at all, whatever the file contains. */
  readonly trackSelection?: boolean;
  readonly subtitleSelection?: boolean;
  /** Playback stalled waiting for data. */
  readonly buffering?: boolean;
  /** Says what playback is waiting on, when that is something other than its own data. */
  readonly bufferingMessage?: string;
  /** Playback is held until the viewer asks for it; `onStartPlayback` is that request. */
  readonly awaitingInteraction?: boolean;
  readonly onStartPlayback?: () => void;
  readonly surfaceRef: Ref<HTMLDivElement>;
  readonly controlsVisible: boolean;
  readonly fullscreen: boolean;
  readonly onBack: () => void;
  /** Omitted where fullscreen is unavailable. */
  readonly onFullscreen?: (() => void) | undefined;
  readonly onRetry: () => void;
  /** Goes back to the start of what is playing, or to whatever comes before it. */
  readonly onPrevious: () => void;
  /**
   * What follows, omitted where nothing does. It plays by itself at the end, which the viewer is
   * told as that nears.
   */
  readonly next?:
    | { readonly title: string; readonly imageUrl: string | null; readonly onStart: () => void }
    | undefined;
  readonly onPause: () => void;
  readonly onSeek: (positionSeconds: number) => void;
  readonly onVolume: (volume: number, muted: boolean) => void;
  readonly onSelectAudio: (streamId: string) => void;
  readonly onSelectSubtitle: (streamId: string | null) => void;
}

export const MediaPlayer = ({
  headerActions,
  trackMemoryError,
  trackActionError,
  onResetTrack,
  onRetryTrackMemory,
  title,
  subtitle,
  paused,
  loading,
  error,
  position,
  duration,
  bufferedRanges,
  volume,
  muted,
  streams,
  selectedAudioStreamId,
  selectedSubtitleStreamId,
  audioOutput,
  onAudioOutput,
  onCopyAudioDiagnostics,
  trackSelection = true,
  subtitleSelection = true,
  buffering = false,
  bufferingMessage,
  awaitingInteraction = false,
  onStartPlayback,
  surfaceRef,
  controlsVisible,
  fullscreen,
  onBack,
  onFullscreen,
  onRetry,
  onPrevious,
  next,
  onPause,
  onSeek,
  onVolume,
  onSelectAudio,
  onSelectSubtitle,
}: MediaPlayerProps): React.ReactElement => {
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  // How far along the timeline the pointer rests, from 0 at its start to 1 at its end.
  const [timelineHover, setTimelineHover] = useState<number | null>(null);
  const [volumePreview, setVolumePreview] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioActionStatus, setAudioActionStatus] = useState<string | null>(null);
  const [changingAudioOutput, setChangingAudioOutput] = useState(false);
  const audioStreams = streams.filter((stream) => stream.kind === "audio");
  const subtitleStreams = streams.filter((stream) => stream.kind === "subtitle");
  const audioLabels = streamLabels(audioStreams);
  const subtitleLabels = streamLabels(subtitleStreams);
  const timelineEnd = duration ?? Math.max(position, 1);
  const seekValue = Math.min(seekPreview ?? position, timelineEnd);
  const volumeValue = volumePreview ?? volume;
  const onVolumeDrag = useThrottledCallback(onVolume, volumeDragIntervalMs);
  const remaining = duration === null ? null : Math.max(0, duration - seekValue);
  // A paused player still finishes later with every second that passes.
  const now = useNow(1_000);
  // Nothing is playing yet (or anymore), so the transport controls have nothing to act on.
  const inactive = loading || error !== null;
  const seekable = !inactive && duration !== null && duration > 0;
  const upNextIn =
    inactive || next === undefined || duration === null || duration - position > upNextNoticeSeconds
      ? null
      : Math.max(1, Math.ceil(duration - position));
  const status =
    error !== null
      ? "error"
      : loading
        ? "loading"
        : awaitingInteraction
          ? "blocked"
          : buffering
            ? "buffering"
            : "ready";
  const seekBy = usePlayerShortcuts({
    enabled: !inactive,
    position,
    duration,
    fullscreen,
    onFullscreen,
    onPause,
    onSeek,
  });

  useEffect(() => {
    // The settings panel is part of the controls, so it goes away with them.
    if (!controlsVisible) setSettingsOpen(false);
  }, [controlsVisible]);

  return (
    <section
      className={`media-player${controlsVisible ? " controls-visible" : ""}`}
      aria-label="Media player"
      data-status={status}
    >
      <header className="media-player-header">
        <Button variant="icon" onClick={onBack} aria-label="Back">
          <ArrowLeft aria-hidden="true" size={21} />
        </Button>
        <div className="media-player-title">
          <h1>{title}</h1>
          {subtitle === undefined || subtitle === "" ? null : <p>{subtitle}</p>}
        </div>
        {headerActions}
      </header>

      <div className="media-player-frame">
        <div className="media-player-surface" ref={surfaceRef}>
          {/* Pointer-only: the console's play button and the Space shortcut cover the keyboard. */}
          <div
            className="media-player-video-hit-target"
            aria-hidden="true"
            onClick={() => {
              if (settingsOpen) setSettingsOpen(false);
              else if (!inactive) onPause();
            }}
          />
          <div className="media-player-placeholder">
            {error !== null ? (
              <>
                <TriangleAlert aria-hidden="true" size={24} />
                <strong>Playback failed</strong>
                <span>{error}</span>
                <Button variant="primary" onClick={onRetry}>
                  Try again
                </Button>
              </>
            ) : loading ? (
              <>
                <LoaderCircle className="spinner" aria-hidden="true" size={26} />
                <span>Starting playback…</span>
              </>
            ) : awaitingInteraction ? (
              <>
                <strong>Ready to play</strong>
                <span>Your browser needs a click before it can start playback.</span>
                <Button variant="primary" onClick={onStartPlayback}>
                  <Play aria-hidden="true" size={16} fill="currentColor" strokeWidth={0} />
                  Play
                </Button>
              </>
            ) : buffering ? (
              bufferingMessage === undefined ? (
                <LoaderCircle className="spinner" aria-label="Buffering" size={26} />
              ) : (
                <>
                  <LoaderCircle className="spinner" aria-hidden="true" size={26} />
                  <span role="status">{bufferingMessage}</span>
                </>
              )
            ) : null}
          </div>
        </div>

        {next === undefined || upNextIn === null ? null : (
          <aside className="media-player-up-next" aria-label="Up next">
            {next.imageUrl === null ? null : <img src={next.imageUrl} alt="" />}
            <p>
              <span>
                Next episode in {upNextIn} {upNextIn === 1 ? "second" : "seconds"}
              </span>
              <strong>{next.title}</strong>
            </p>
            <Button variant="primary" size="sm" onClick={next.onStart}>
              Start now
            </Button>
          </aside>
        )}

        <div className="media-player-console">
          <div className="media-player-progress">
            <span className="media-player-time">{formatPlayerTime(seekValue)}</span>
            <Slider.Root
              className="media-player-timeline"
              min={0}
              max={timelineEnd}
              value={seekValue}
              disabled={!seekable}
              onValueChange={setSeekPreview}
              onValueCommitted={(value) => {
                setSeekPreview(null);
                onSeek(value);
              }}
            >
              <Slider.Label className="sr-only">Playback position</Slider.Label>
              <Slider.Control
                className="media-slider-control"
                onPointerMove={(event) => {
                  const { left, width } = event.currentTarget.getBoundingClientRect();
                  setTimelineHover(width > 0 ? Math.min(1, Math.max(0, (event.clientX - left) / width)) : null);
                }}
                onPointerLeave={() => setTimelineHover(null)}
              >
                {seekable && timelineHover !== null ? (
                  <span
                    className="media-player-timeline-hover"
                    style={{ left: `${timelineHover * 100}%` }}
                    aria-hidden="true"
                  >
                    {formatPlayerTime(timelineHover * timelineEnd)}
                  </span>
                ) : null}
                <Slider.Track className="media-slider-track">
                  {duration === null || duration <= 0
                    ? null
                    : bufferedRanges.map(({ startSeconds, endSeconds }) => {
                        const start = Math.min(duration, Math.max(0, startSeconds));
                        const end = Math.min(duration, Math.max(0, endSeconds));
                        return end > start ? (
                          <span
                            key={`${startSeconds}-${endSeconds}`}
                            className="media-slider-buffered"
                            style={{
                              left: `${(start / duration) * 100}%`,
                              width: `${((end - start) / duration) * 100}%`,
                            }}
                            aria-hidden="true"
                          />
                        ) : null;
                      })}
                  <Slider.Indicator className="media-slider-indicator" />
                  <Slider.Thumb className="media-slider-thumb" />
                </Slider.Track>
              </Slider.Control>
            </Slider.Root>
            <span className="media-player-time media-player-remaining">
              {remaining === null ? "--:--" : `-${formatPlayerTime(remaining)}`}
            </span>
          </div>

          <div className="media-player-toolbar">
            <div className="media-player-transport">
              <Button variant="icon" disabled={inactive} onClick={onPrevious} aria-label="Previous">
                <SkipBack aria-hidden="true" size={19} fill="currentColor" />
              </Button>
              <Button
                className="media-player-skip"
                variant="icon"
                disabled={inactive || duration === null}
                onClick={() => seekBy(-10)}
                aria-label="Back 10 seconds"
              >
                <RotateCcw aria-hidden="true" size={21} strokeWidth={1.75} />
                <span className="media-player-skip-label" aria-hidden="true">
                  10
                </span>
              </Button>
              <Button
                className="media-player-play"
                variant="icon"
                disabled={inactive}
                onClick={onPause}
                aria-label={paused ? "Resume playback" : "Pause playback"}
              >
                {paused ? (
                  <Play aria-hidden="true" size={22} fill="currentColor" strokeWidth={0} />
                ) : (
                  <Pause aria-hidden="true" size={22} fill="currentColor" strokeWidth={0} />
                )}
              </Button>
              <Button
                className="media-player-skip"
                variant="icon"
                disabled={inactive || duration === null}
                onClick={() => seekBy(10)}
                aria-label="Forward 10 seconds"
              >
                <RotateCw aria-hidden="true" size={21} strokeWidth={1.75} />
                <span className="media-player-skip-label" aria-hidden="true">
                  10
                </span>
              </Button>
              {next === undefined ? null : (
                <Button
                  variant="icon"
                  disabled={inactive}
                  onClick={next.onStart}
                  aria-label="Next episode"
                >
                  <SkipForward aria-hidden="true" size={19} fill="currentColor" />
                </Button>
              )}
            </div>
            {inactive || remaining === null ? null : (
              <span className="media-player-ends-at">{formatEndsAt(remaining, now)}</span>
            )}
            <div className="media-player-actions">
              <div className="media-player-volume">
                <Button
                  variant="icon"
                  disabled={inactive}
                  onClick={() => onVolume(volume, !muted)}
                  aria-label={muted ? "Unmute" : "Mute"}
                >
                  {muted || volumeValue === 0 ? (
                    <VolumeX aria-hidden="true" size={19} />
                  ) : (
                    <Volume2 aria-hidden="true" size={19} />
                  )}
                </Button>
                <Slider.Root
                  className="volume-slider"
                  min={0}
                  max={100}
                  value={volumeValue}
                  disabled={inactive}
                  onValueChange={(value) => {
                    setVolumePreview(value);
                    onVolumeDrag(value, value === 0);
                  }}
                  onValueCommitted={(value) => {
                    onVolumeDrag.cancel();
                    setVolumePreview(null);
                    onVolume(value, value === 0);
                  }}
                >
                  <Slider.Label className="sr-only">Volume</Slider.Label>
                  <Slider.Control className="media-slider-control">
                    <Slider.Track className="media-slider-track">
                      <Slider.Indicator className="media-slider-indicator" />
                      <Slider.Thumb className="media-slider-thumb" />
                    </Slider.Track>
                  </Slider.Control>
                </Slider.Root>
              </div>
              <div className="media-player-settings">
                <Button
                  variant="icon"
                  aria-label="Playback settings"
                  aria-expanded={settingsOpen}
                  aria-controls="media-player-settings-panel"
                  onClick={() => setSettingsOpen((open) => !open)}
                >
                  <Settings2 aria-hidden="true" size={19} />
                </Button>
                {settingsOpen ? (
                  <div className="media-player-settings-panel" id="media-player-settings-panel">
                    <strong>Audio and subtitles</strong>
                    {onAudioOutput === undefined ? null : (
                      <SelectField
                        label="Audio output"
                        modal={false}
                        disabled={inactive || changingAudioOutput}
                        value={audioOutput}
                        options={[
                          { value: "stereo", label: "Stereo (speakers / headphones)" },
                          { value: "auto-safe", label: "Automatic (system layout)" },
                        ]}
                        onValueChange={(value) => {
                          if (value !== "stereo" && value !== "auto-safe") return;
                          setAudioActionStatus(null);
                          setChangingAudioOutput(true);
                          void onAudioOutput(value)
                            .catch(() => setAudioActionStatus("Could not change audio output."))
                            .finally(() => setChangingAudioOutput(false));
                        }}
                      />
                    )}
                    {audioStreams.length > 0 ? (
                      <SelectField
                        label="Audio track"
                        modal={false}
                        value={selectedAudioStreamId}
                        disabled={inactive}
                        options={[
                          ...(onResetTrack === undefined
                            ? []
                            : [{ value: "settings", label: "Use my settings" }]),
                          ...audioStreams.map((stream, index) => ({
                            value: stream.id,
                            label: audioLabels[index] ?? "",
                          })),
                        ]}
                        onValueChange={(value) =>
                          value === "settings" ? onResetTrack?.("audio") : onSelectAudio(value)
                        }
                      />
                    ) : null}
                    {subtitleStreams.length > 0 ||
                    (onResetTrack !== undefined && subtitleSelection) ? (
                      <SelectField
                        label="Subtitles"
                        modal={false}
                        value={selectedSubtitleStreamId ?? "off"}
                        disabled={inactive}
                        options={[
                          ...(onResetTrack === undefined
                            ? []
                            : [{ value: "settings", label: "Use my settings" }]),
                          { value: "off", label: "Off" },
                          ...subtitleStreams.map((stream, index) => ({
                            value: stream.id,
                            label: subtitleLabels[index] ?? "",
                          })),
                        ]}
                        onValueChange={(value) =>
                          value === "settings"
                            ? onResetTrack?.("subtitle")
                            : onSelectSubtitle(value === "off" ? null : value)
                        }
                      />
                    ) : null}
                    {!subtitleSelection ? (
                      <p>This browser can’t select embedded subtitles.</p>
                    ) : null}
                    {audioStreams.length === 0 && subtitleStreams.length === 0 ? (
                      <p>
                        {trackSelection
                          ? "This file has no alternate audio or subtitle tracks."
                          : "This player can’t switch audio or subtitle tracks."}
                      </p>
                    ) : null}
                    {onResetTrack === undefined ||
                    (audioStreams.length > 0 && subtitleSelection) ? null : (
                      <>
                        {audioStreams.length === 0 ? (
                          <Button disabled={inactive} onClick={() => onResetTrack("audio")}>
                            Audio: Use my settings
                          </Button>
                        ) : null}
                        {!subtitleSelection ? (
                          <Button disabled={inactive} onClick={() => onResetTrack("subtitle")}>
                            Subtitles: Use my settings
                          </Button>
                        ) : null}
                      </>
                    )}
                    {onCopyAudioDiagnostics === undefined ? null : (
                      <Button
                        onClick={() => {
                          setAudioActionStatus(null);
                          void onCopyAudioDiagnostics().then(
                            () => setAudioActionStatus("Playback diagnostics exported."),
                            () => setAudioActionStatus("Could not export playback diagnostics."),
                          );
                        }}
                      >
                        Export playback diagnostics
                      </Button>
                    )}
                    {trackActionError == null ? null : <p role="alert">{trackActionError}</p>}
                    {trackMemoryError == null ? null : (
                      <p role="alert">
                        {trackMemoryError}
                        <Button onClick={onRetryTrackMemory}>Retry saving choice</Button>
                      </p>
                    )}
                    {audioActionStatus === null ? null : <p role="status">{audioActionStatus}</p>}
                  </div>
                ) : null}
              </div>
              {onFullscreen === undefined ? null : (
                <Button
                  variant="icon"
                  onClick={onFullscreen}
                  aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                >
                  {fullscreen ? (
                    <Minimize aria-hidden="true" size={18} />
                  ) : (
                    <Maximize aria-hidden="true" size={18} />
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
