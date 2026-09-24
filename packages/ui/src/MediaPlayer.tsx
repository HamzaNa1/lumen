import type { IpcPlayableStream } from "@lumen/contracts";
import { Slider } from "@base-ui/react/slider";
import {
  ArrowLeft,
  Captions,
  ListMusic,
  MonitorPlay,
  Pause,
  Play,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useState, type Ref } from "react";
import { Button } from "./Button";
import { SelectField } from "./Controls";
import { formatPlayerTime, streamLabel } from "./PlayerFormatting";

interface MediaPlayerProps {
  readonly title: string;
  readonly context: string;
  readonly paused: boolean;
  readonly loading: boolean;
  readonly position: number;
  readonly duration: number | null;
  readonly volume: number;
  readonly muted: boolean;
  readonly streams: ReadonlyArray<IpcPlayableStream>;
  readonly selectedAudioStreamId: string | null;
  readonly selectedSubtitleStreamId: string | null;
  readonly surfaceRef: Ref<HTMLDivElement>;
  readonly onBack: () => void;
  readonly onPause: () => void;
  readonly onStop: () => void;
  readonly onSeek: (positionSeconds: number) => void;
  readonly onVolume: (volume: number, muted: boolean) => void;
  readonly onSelectAudio: (streamId: string) => void;
  readonly onSelectSubtitle: (streamId: string | null) => void;
}

export const MediaPlayer = ({
  title,
  context,
  paused,
  loading,
  position,
  duration,
  volume,
  muted,
  streams,
  selectedAudioStreamId,
  selectedSubtitleStreamId,
  surfaceRef,
  onBack,
  onPause,
  onStop,
  onSeek,
  onVolume,
  onSelectAudio,
  onSelectSubtitle,
}: MediaPlayerProps): React.ReactElement => {
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [volumePreview, setVolumePreview] = useState<number | null>(null);
  const audioStreams = streams.filter((stream) => stream.kind === "audio");
  const subtitleStreams = streams.filter((stream) => stream.kind === "subtitle");
  const seekValue = Math.min(seekPreview ?? position, duration ?? Math.max(position, 1));
  const volumeValue = volumePreview ?? volume;

  return (
    <section className="media-player" aria-label="Media player">
      <header className="media-player-header">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden="true" size={18} />
          Back to library
        </Button>
        <div className="media-player-title">
          <span className="eyebrow">Now playing</span>
          <h1>{title}</h1>
          <p>{context}</p>
        </div>
        <span className="quality-badge">MPV · Direct Play</span>
      </header>

      <div className="media-player-frame">
        <div className="media-player-surface" ref={surfaceRef}>
          <div className="media-player-placeholder">
            <span className="media-player-mark">
              <MonitorPlay aria-hidden="true" size={28} />
            </span>
            <strong>{loading ? "Preparing your movie…" : "MPV playback surface"}</strong>
            <span>
              {loading ? "Opening the original file" : "Original quality · no transcoding"}
            </span>
          </div>
        </div>

        <div className="media-player-console">
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

          <div className="media-player-toolbar">
            <span className="media-player-time">
              {formatPlayerTime(seekValue)} <i>/</i>{" "}
              {duration === null ? "--:--" : formatPlayerTime(duration)}
            </span>
            <div className="media-player-transport">
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
              <Button variant="icon" disabled={loading} onClick={onStop} aria-label="Stop playback">
                <Square aria-hidden="true" size={14} fill="currentColor" />
              </Button>
            </div>
            <div className="media-player-volume">
              <Button
                variant="icon"
                disabled={loading}
                onClick={() => onVolume(volume, !muted)}
                aria-label={muted ? "Unmute" : "Mute"}
              >
                {muted || volumeValue === 0 ? (
                  <VolumeX aria-hidden="true" size={18} />
                ) : (
                  <Volume2 aria-hidden="true" size={18} />
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
          </div>

          {audioStreams.length === 0 && subtitleStreams.length === 0 ? null : (
            <div className="media-player-streams">
              {audioStreams.length === 0 ? null : (
                <div className="media-player-picker">
                  <ListMusic aria-hidden="true" size={16} />
                  <SelectField
                    hideLabel
                    label="Audio track"
                    value={selectedAudioStreamId}
                    options={audioStreams.map((stream, index) => ({
                      value: stream.id,
                      label: streamLabel(stream, index, audioStreams.length),
                    }))}
                    onValueChange={onSelectAudio}
                  />
                </div>
              )}
              {subtitleStreams.length === 0 ? null : (
                <div className="media-player-picker">
                  <Captions aria-hidden="true" size={17} />
                  <SelectField
                    hideLabel
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
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
