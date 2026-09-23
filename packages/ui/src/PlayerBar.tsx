import { Button } from "./Button";

export const PlayerBar = ({ title, server, paused, onPause, onStop, position, duration }: { readonly title: string; readonly server: string; readonly paused: boolean; readonly onPause: () => void; readonly onStop: () => void; readonly position: number; readonly duration: number | null }): React.ReactElement => (
  <div className="player-inner">
    <div className="player-copy"><strong>{title}</strong><span>{server}</span></div>
    <div className="player-controls"><Button onClick={onPause}>{paused ? "Play" : "Pause"}</Button><Button onClick={onStop}>Stop</Button></div>
    <label className="player-progress"><span className="sr-only">Playback position</span><input type="range" min="0" max={duration ?? 0} value={Math.min(position, duration ?? position)} readOnly /><span>{formatTime(position)} / {duration === null ? "--:--" : formatTime(duration)}</span></label>
  </div>
);

const formatTime = (seconds: number): string => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
};
