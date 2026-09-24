import { Slider } from "@base-ui/react/slider";
import type { IpcPlayableStream } from "@lumen/contracts";
import {
  ArrowLeft,
  FastForward,
  Maximize,
  Minimize,
  MonitorPlay,
  Pause,
  Play,
  Rewind,
  Settings2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { type Ref, useState } from "react";
import { Button } from "./Button";
import { SelectField } from "./Controls";
import { formatPlayerTime, streamLabel } from "./PlayerFormatting";

interface MediaPlayerProps {
  readonly title: string;
  readonly paused: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly position: number;
  readonly duration: number | null;
  readonly volume: number;
  readonly muted: boolean;
  readonly streams: ReadonlyArray<IpcPlayableStream>;
  readonly selectedAudioStreamId: string | null;
  readonly selectedSubtitleStreamId: string | null;
  readonly surfaceRef: Ref<HTMLDivElement>;
  readonly controlsVisible: boolean;
  readonly fullscreen: boolean;
  readonly onBack: () => void;
  readonly onFullscreen: () => void;
  readonly onRetry: () => void;
  readonly onPause: () => void;
  readonly onSeek: (positionSeconds: number) => void;
  readonly onVolume: (volume: number, muted: boolean) => void;
  readonly onSelectAudio: (streamId: string) => void;
  readonly onSelectSubtitle: (streamId: string | null) => void;
}

export const MediaPlayer = ({
  title,
  paused,
  loading,
  error,
  position,
  duration,
  volume,
  muted,
  streams,
  selectedAudioStreamId,
  selectedSubtitleStreamId,
  surfaceRef,
  controlsVisible,
  fullscreen,
  onBack,
  onFullscreen,
  onRetry,
  onPause,
  onSeek,
  onVolume,
  onSelectAudio,
  onSelectSubtitle,
}: MediaPlayerProps): React.ReactElement => {
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [volumePreview, setVolumePreview] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const audioStreams = streams.filter((stream) => stream.kind === "audio");
  const subtitleStreams = streams.filter((stream) => stream.kind === "subtitle");
  const seekValue = Math.min(seekPreview ?? position, duration ?? Math.max(position, 1));
  const volumeValue = volumePreview ?? volume;
  const remaining = duration === null ? null : Math.max(0, duration - seekValue);

  return (
    <section
      className={`media-player${controlsVisible || settingsOpen ? " controls-visible" : ""}`}
      aria-label="Media player"
      data-status={error !== null ? "error" : loading ? "loading" : "ready"}
    >
      <header className="media-player-header">
        <Button variant="icon" onClick={onBack} aria-label="Back to library">
          <ArrowLeft aria-hidden="true" size={21} />
        </Button>
        <div className="media-player-title">
          <h1>{title}</h1>
        </div>
      </header>

      <div className="media-player-frame">
        <div className="media-player-surface" ref={surfaceRef}>
          <div className="media-player-placeholder">
            <span className="media-player-mark">
              <MonitorPlay aria-hidden="true" size={28} />
            </span>
            <strong>{error ?? (loading ? "Preparing your movie…" : "MPV playback surface")}</strong>
            <span>
              {error === null
                ? loading
                  ? "Opening the original file"
                  : "Original quality · no transcoding"
                : "Check that embedded MPV is installed, then try again."}
            </span>
            {error === null ? null : (
              <Button variant="primary" onClick={onRetry}>
                Try again
              </Button>
            )}
          </div>
        </div>

        <div className="media-player-console">
          <div className="media-player-progress">
            <span className="media-player-time">{formatPlayerTime(seekValue)}</span>
            <Slider.Root
              className="media-player-timeline"
              min={0}
              max={duration ?? Math.max(position, 1)}
              value={seekValue}
              disabled={loading || duration === null || duration <= 0}
              onValueChange={setSeekPreview}
              onValueCommitted={(value) => {
                setSeekPreview(null);
                onSeek(value);
              }}
            >
              <Slider.Label className="sr-only">Playback position</Slider.Label>
              <Slider.Control className="media-slider-control">
                <Slider.Track className="media-slider-track">
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
              <Button
                variant="icon"
                disabled={loading || duration === null}
                onClick={() => onSeek(Math.max(0, position - 10))}
                aria-label="Rewind 10 seconds"
              >
                <Rewind aria-hidden="true" size={19} fill="currentColor" />
              </Button>
              <Button
                className="media-player-play"
                variant="icon"
                disabled={loading}
                onClick={onPause}
                aria-label={paused ? "Resume playback" : "Pause playback"}
              >
                {paused ? (
                  <Play aria-hidden="true" size={22} fill="currentColor" />
                ) : (
                  <Pause aria-hidden="true" size={22} fill="currentColor" />
                )}
              </Button>
              <Button
                variant="icon"
                disabled={loading || duration === null}
                onClick={() => onSeek(Math.min(duration ?? position + 10, position + 10))}
                aria-label="Forward 10 seconds"
              >
                <FastForward aria-hidden="true" size={19} fill="currentColor" />
              </Button>
            </div>
            <div className="media-player-actions">
              <div className="media-player-volume">
                <Button
                  variant="icon"
                  disabled={loading}
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
                  disabled={loading}
                  onValueChange={setVolumePreview}
                  onValueCommitted={(value) => {
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
                    <strong>Playback settings</strong>
                    {audioStreams.length > 0 ? (
                      <SelectField
                        label="Audio track"
                        value={selectedAudioStreamId}
                        options={audioStreams.map((stream, index) => ({
                          value: stream.id,
                          label: streamLabel(stream, index, audioStreams.length),
                        }))}
                        onValueChange={onSelectAudio}
                      />
                    ) : null}
                    {subtitleStreams.length > 0 ? (
                      <SelectField
                        label="Subtitles"
                        value={selectedSubtitleStreamId ?? "off"}
                        options={[
                          { value: "off", label: "Subtitles off" },
                          ...subtitleStreams.map((stream, index) => ({
                            value: stream.id,
                            label: streamLabel(stream, index, subtitleStreams.length),
                          })),
                        ]}
                        onValueChange={(value) => onSelectSubtitle(value === "off" ? null : value)}
                      />
                    ) : null}
                    {audioStreams.length === 0 && subtitleStreams.length === 0 ? (
                      <p>No alternate tracks available</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
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
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
