import type { PlaybackInfo } from "@lumen/contracts";
import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { playbackInfoSections, playbackInfoText } from "./PlayerFormatting";
import { type PlaybackInfoContent, pollPlaybackInfo } from "./playbackInfoPolling";

/** How often the panel asks the player again while it is open. */
const refreshIntervalMs = 1_000;
/** How long the copy button says it copied. */
const copiedForMs = 1_500;

const CopyButton = ({ text }: { readonly text: string }): React.ReactElement => {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  const copy = async () => {
    clearTimeout(reset.current);
    try {
      await navigator.clipboard.writeText(text);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
    reset.current = setTimeout(() => setCopied("idle"), copiedForMs);
  };
  return (
    <Button
      variant="icon"
      size="sm"
      onClick={() => void copy()}
      aria-label={
        copied === "copied"
          ? "Copied playback info"
          : copied === "failed"
            ? "Could not copy playback info"
            : "Copy playback info"
      }
    >
      {copied === "copied" ? (
        <Check aria-hidden="true" size={15} />
      ) : (
        <Copy aria-hidden="true" size={15} />
      )}
    </Button>
  );
};

export const PlaybackInfoView = ({
  content,
  bufferedAhead,
  appVersion,
  onClose,
}: {
  readonly content: PlaybackInfoContent;
  readonly bufferedAhead: string;
  readonly appVersion?: string | null | undefined;
  readonly onClose: () => void;
}): React.ReactElement => {
  const sections =
    content.kind === "ready" ? playbackInfoSections(content.info, bufferedAhead, appVersion) : null;
  return (
    <aside className="media-player-info" aria-label="Playback info">
      <header className="media-player-info-header">
        <strong>Playback info</strong>
        <div className="media-player-info-actions">
          {sections === null ? null : <CopyButton text={playbackInfoText(sections)} />}
          <Button variant="icon" size="sm" onClick={onClose} aria-label="Close playback info">
            <X aria-hidden="true" size={15} />
          </Button>
        </div>
      </header>
      {sections !== null ? (
        sections.map((section) => (
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
};

/**
 * What the player reports about the playback in progress, refreshed while the panel is open.
 * `load` is omitted while nothing is playing. `bufferedAhead` follows the player's own state, so
 * a seek changes it in the same frame as the timeline instead of at the next refresh.
 */
export const PlaybackInfoPanel = ({
  load,
  bufferedAhead,
  appVersion,
  onClose,
}: {
  readonly load: (() => Promise<PlaybackInfo>) | undefined;
  readonly bufferedAhead: string;
  readonly appVersion?: string | null | undefined;
  readonly onClose: () => void;
}): React.ReactElement => {
  const [content, setContent] = useState<PlaybackInfoContent>({ kind: "loading" });
  const latestLoad = useRef(load);
  latestLoad.current = load;
  useEffect(() => pollPlaybackInfo(() => latestLoad.current, setContent, refreshIntervalMs), []);
  return (
    <PlaybackInfoView
      content={content}
      bufferedAhead={bufferedAhead}
      appVersion={appVersion}
      onClose={onClose}
    />
  );
};
