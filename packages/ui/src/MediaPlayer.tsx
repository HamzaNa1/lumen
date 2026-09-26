import { Slider } from "@base-ui/react/slider";
import type { IpcAudioOutput, IpcPlayableStream } from "@lumen/contracts";
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
  TriangleAlert,
  Volume2,
  VolumeX,
} from "lucide-react";
import { type Ref, useState } from "react";
import { Button } from "./Button";
import { SelectField } from "./Controls";
import { formatPlayerTime, streamLabels } from "./PlayerFormatting";

interface MediaPlayerProps {
  readonly title: string;
  readonly subtitle?: string;
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
  readonly audioOutput: IpcAudioOutput;
  readonly onAudioOutput: (output: IpcAudioOutput) => Promise<void>;
  readonly onCopyAudioDiagnostics: () => Promise<void>;
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
  subtitle,
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
  audioOutput,
  onAudioOutput,
  onCopyAudioDiagnostics,
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
  const [audioActionStatus, setAudioActionStatus] = useState<string | null>(null);
  const audioStreams = streams.filter((stream) => stream.kind === "audio");
  const subtitleStreams = streams.filter((stream) => stream.kind === "subtitle");
  const audioLabels = streamLabels(audioStreams);
  const subtitleLabels = streamLabels(subtitleStreams);
  const seekValue = Math.min(seekPreview ?? position, duration ?? Math.max(position, 1));
  const volumeValue = volumePreview ?? volume;
  const remaining = duration === null ? null : Math.max(0, duration - seekValue);
  // Nothing is playing yet (or anymore), so the transport controls have nothing to act on.
  const inactive = loading || error !== null;

  return (
    <section
      className={`media-player${controlsVisible || settingsOpen ? " controls-visible" : ""}`}
      aria-label="Media player"
      data-status={error !== null ? "error" : loading ? "loading" : "ready"}
    >
      <header className="media-player-header">
        <Button variant="icon" onClick={onBack} aria-label="Back">
          <ArrowLeft aria-hidden="true" size={21} />
        </Button>
        <div className="media-player-title">
          <h1>{title}</h1>
          {subtitle === undefined || subtitle === "" ? null : <p>{subtitle}</p>}
        </div>
      </header>

      <div className="media-player-frame">
        <div className="media-player-surface" ref={surfaceRef}>
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
            ) : null}
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
              disabled={inactive || duration === null || duration <= 0}
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
                className="media-player-skip"
                variant="icon"
                disabled={inactive || duration === null}
                onClick={() => onSeek(Math.max(0, position - 10))}
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
                onClick={() => onSeek(Math.min(duration ?? position + 10, position + 10))}
                aria-label="Forward 10 seconds"
              >
                <RotateCw aria-hidden="true" size={21} strokeWidth={1.75} />
                <span className="media-player-skip-label" aria-hidden="true">
                  10
                </span>
              </Button>
            </div>
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
                    <strong>Audio and subtitles</strong>
                    <SelectField
                      label="Audio output"
                      disabled={inactive}
                      value={audioOutput}
                      options={[
                        { value: "stereo", label: "Stereo (speakers / headphones)" },
                        { value: "auto-safe", label: "Automatic (system layout)" },
                      ]}
                      onValueChange={(value) => {
                        if (value !== "stereo" && value !== "auto-safe") return;
                        setAudioActionStatus(null);
                        void onAudioOutput(value).catch(() =>
                          setAudioActionStatus("Could not change audio output."),
                        );
                      }}
                    />
                    {audioStreams.length > 0 ? (
                      <SelectField
                        label="Audio track"
                        value={selectedAudioStreamId}
                        options={audioStreams.map((stream, index) => ({
                          value: stream.id,
                          label: audioLabels[index] ?? "",
                        }))}
                        onValueChange={onSelectAudio}
                      />
                    ) : null}
                    {subtitleStreams.length > 0 ? (
                      <SelectField
                        label="Subtitles"
                        value={selectedSubtitleStreamId ?? "off"}
                        options={[
                          { value: "off", label: "Off" },
                          ...subtitleStreams.map((stream, index) => ({
                            value: stream.id,
                            label: subtitleLabels[index] ?? "",
                          })),
                        ]}
                        onValueChange={(value) => onSelectSubtitle(value === "off" ? null : value)}
                      />
                    ) : null}
                    {audioStreams.length === 0 && subtitleStreams.length === 0 ? (
                      <p>This file has no alternate audio or subtitle tracks.</p>
                    ) : null}
                    <Button
                      disabled={inactive}
                      onClick={() => {
                        setAudioActionStatus(null);
                        void onCopyAudioDiagnostics().then(
                          () => setAudioActionStatus("Audio diagnostics copied."),
                          () => setAudioActionStatus("Could not copy audio diagnostics."),
                        );
                      }}
                    >
                      Copy audio diagnostics
                    </Button>
                    {audioActionStatus === null ? null : <p role="status">{audioActionStatus}</p>}
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
