import type { PlaybackInfo } from "@lumen/contracts";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { playbackInfoSections } from "./PlayerFormatting";
import { type PlaybackInfoContent, pollPlaybackInfo } from "./playbackInfoPolling";

/** How often the panel asks the player again while it is open. */
const refreshIntervalMs = 1_000;

export const PlaybackInfoView = ({
  content,
  onClose,
}: {
  readonly content: PlaybackInfoContent;
  readonly onClose: () => void;
}): React.ReactElement => (
  <aside className="media-player-info" aria-label="Playback info">
    <header className="media-player-info-header">
      <strong>Playback info</strong>
      <Button variant="icon" size="sm" onClick={onClose} aria-label="Close playback info">
        <X aria-hidden="true" size={15} />
      </Button>
    </header>
    {content.kind === "ready" ? (
      playbackInfoSections(content.info).map((section) => (
        <section key={section.title}>
          <h2>{section.title}</h2>
          <dl>
            {section.rows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))
    ) : (
      <p role="status">
        {content.kind === "loading"
          ? "Loading…"
          : content.kind === "idle"
            ? "Nothing is playing."
            : "The player could not report on playback."}
      </p>
    )}
  </aside>
);

/**
 * What the player reports about the playback in progress, refreshed while the panel is open.
 * `load` is omitted while nothing is playing.
 */
export const PlaybackInfoPanel = ({
  load,
  onClose,
}: {
  readonly load: (() => Promise<PlaybackInfo>) | undefined;
  readonly onClose: () => void;
}): React.ReactElement => {
  const [content, setContent] = useState<PlaybackInfoContent>({ kind: "loading" });
  const latestLoad = useRef(load);
  latestLoad.current = load;
  useEffect(() => pollPlaybackInfo(() => latestLoad.current, setContent, refreshIntervalMs), []);
  return <PlaybackInfoView content={content} onClose={onClose} />;
};
