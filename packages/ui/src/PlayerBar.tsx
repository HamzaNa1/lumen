import type { IpcPlayableStream } from "@lumen/contracts";
import { Slider } from "@base-ui/react/slider";
import { Captions, ListMusic, Pause, Play, Square } from "lucide-react";
import { Button } from "./Button";
import { SelectField } from "./Controls";
import { formatPlayerTime, streamLabel } from "./PlayerFormatting";

interface PlayerBarProps {
  readonly title: string;
  readonly server: string;
  readonly paused: boolean;
  readonly onPause: () => void;
  readonly onStop: () => void;
  readonly position: number;
  readonly duration: number | null;
  readonly streams: ReadonlyArray<IpcPlayableStream>;
  readonly selectedAudioStreamId: string | null;
  readonly selectedSubtitleStreamId: string | null;
  readonly onSelectAudio: (streamId: string) => void;
  readonly onSelectSubtitle: (streamId: string | null) => void;
}

export const PlayerBar = ({
  title,
  server,
  paused,
  onPause,
  onStop,
  position,
  duration,
  streams,
  selectedAudioStreamId,
  selectedSubtitleStreamId,
  onSelectAudio,
  onSelectSubtitle,
}: PlayerBarProps): React.ReactElement => {
  const audioStreams = streams.filter((stream) => stream.kind === "audio");
  const subtitleStreams = streams.filter((stream) => stream.kind === "subtitle");
  return (
    <div className="player-inner">
      <div className="player-copy">
        <strong>{title}</strong>
        <span>{server}</span>
      </div>
      <div className="player-controls">
        <Button
          variant="icon"
          onClick={onPause}
          aria-label={paused ? "Resume playback" : "Pause playback"}
        >
          {paused ? (
            <Play aria-hidden="true" size={18} fill="currentColor" />
          ) : (
            <Pause aria-hidden="true" size={18} fill="currentColor" />
          )}
        </Button>
        <Button variant="icon" onClick={onStop} aria-label="Stop playback">
          <Square aria-hidden="true" size={15} fill="currentColor" />
        </Button>
        {audioStreams.length > 0 ? (
          <div className="player-picker">
            <ListMusic aria-hidden="true" size={16} />
            <SelectField
              hideLabel
              label="Audio"
              value={selectedAudioStreamId}
              options={audioStreams.map((stream, index) => ({
                value: stream.id,
                label: streamLabel(stream, index, audioStreams.length),
              }))}
              onValueChange={onSelectAudio}
            />
          </div>
        ) : null}
        {subtitleStreams.length > 0 ? (
          <div className="player-picker">
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
        ) : null}
      </div>
      <Slider.Root
        className="player-progress"
        min={0}
        max={duration ?? Math.max(position, 1)}
        value={Math.min(position, duration ?? position)}
        disabled
      >
        <Slider.Label className="sr-only">Playback position</Slider.Label>
        <Slider.Control className="slider-control">
          <Slider.Track className="slider-track">
            <Slider.Indicator className="slider-indicator" />
            <Slider.Thumb className="slider-thumb" />
          </Slider.Track>
        </Slider.Control>
        <span>
          {formatPlayerTime(position)} / {duration === null ? "--:--" : formatPlayerTime(duration)}
        </span>
      </Slider.Root>
    </div>
  );
};
