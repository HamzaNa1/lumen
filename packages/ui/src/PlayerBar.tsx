import type { IpcPlayableStream } from "@lumen/contracts";
import { Button } from "./Button";

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

export const PlayerBar = ({ title, server, paused, onPause, onStop, position, duration, streams, selectedAudioStreamId, selectedSubtitleStreamId, onSelectAudio, onSelectSubtitle }: PlayerBarProps): React.ReactElement => {
  const audioStreams = streams.filter((stream) => stream.kind === "audio");
  const subtitleStreams = streams.filter((stream) => stream.kind === "subtitle");
  return (
    <div className="player-inner">
      <div className="player-copy"><strong>{title}</strong><span>{server}</span></div>
      <div className="player-controls">
        <Button onClick={onPause}>{paused ? "Play" : "Pause"}</Button>
        <Button onClick={onStop}>Stop</Button>
        {audioStreams.length > 0 ? <label className="player-picker"><span className="sr-only">Audio</span><select aria-label="Audio" value={selectedAudioStreamId ?? ""} onChange={(event) => onSelectAudio(event.target.value)}>{audioStreams.map((stream, index) => <option key={stream.id} value={stream.id}>{streamLabel(stream, index, audioStreams.length)}</option>)}</select></label> : null}
        {subtitleStreams.length > 0 ? <label className="player-picker"><span className="sr-only">Subtitles</span><select aria-label="Subtitles" value={selectedSubtitleStreamId ?? ""} onChange={(event) => onSelectSubtitle(event.target.value === "" ? null : event.target.value)}><option value="">Off</option>{subtitleStreams.map((stream, index) => <option key={stream.id} value={stream.id}>{streamLabel(stream, index, subtitleStreams.length)}</option>)}</select></label> : null}
      </div>
      <label className="player-progress"><span className="sr-only">Playback position</span><input type="range" min="0" max={duration ?? 0} value={Math.min(position, duration ?? position)} readOnly /><span>{formatTime(position)} / {duration === null ? "--:--" : formatTime(duration)}</span></label>
    </div>
  );
};

const streamLabel = (stream: IpcPlayableStream, index: number, count: number): string => {
  const name = stream.title ?? stream.language?.toUpperCase() ?? (stream.kind === "audio" ? "Audio" : "Subtitles");
  const language = stream.title !== null && stream.language !== null ? ` · ${stream.language.toUpperCase()}` : "";
  const codec = stream.codec === null ? "" : ` · ${stream.codec.toUpperCase()}`;
  const position = count > 1 ? ` · ${index + 1}` : "";
  return `${name}${language}${codec}${position}`;
};

const formatTime = (seconds: number): string => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
};
