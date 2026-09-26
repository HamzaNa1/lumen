import { Film, Music, Play, Tv } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "./Button";

/** Stable hue for a title, so artwork stand-ins keep their colour between renders. */
export const posterHue = (value: string): number => {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 360;
  return hash;
};

const kindIcon = (kind: string | undefined) =>
  kind === "show" || kind === "season" || kind === "episode"
    ? Tv
    : kind === "track" || kind === "album" || kind === "artist"
      ? Music
      : Film;

/** Artwork stand-in: a muted tint derived from the title, with the title set on it. */
export const PosterFallback = ({
  title,
  kind,
  className,
}: {
  readonly title: string;
  readonly kind?: string;
  readonly className?: string;
}): React.ReactElement => {
  const Icon = kindIcon(kind);
  return (
    <span
      className={`poster-fallback${className === undefined ? "" : ` ${className}`}`}
      style={{ "--poster-hue": posterHue(title) } as React.CSSProperties}
    >
      <Icon aria-hidden="true" size={18} strokeWidth={1.75} />
      <span className="poster-fallback-title">{title}</span>
    </span>
  );
};

export const MediaCard = ({
  title,
  subtitle,
  imageUrl,
  kind,
  landscape = false,
  progress,
  onPlay,
  onOpen,
  action,
}: {
  readonly action?: ReactNode;
  readonly title: string;
  readonly subtitle?: string | null;
  readonly imageUrl?: string | null;
  readonly kind?: string;
  /** 16:9 artwork, such as an episode still, instead of a 2:3 poster. */
  readonly landscape?: boolean;
  /** Watched fraction between 0 and 1. */
  readonly progress?: number | null;
  readonly onPlay: () => void;
  readonly onOpen: () => void;
}): React.ReactElement => {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const showImage = imageUrl !== undefined && imageUrl !== null && failedImage !== imageUrl;
  return (
    <article className={`media-card${landscape ? " is-landscape" : ""}`}>
      <button className="media-card-open" type="button" onClick={onOpen}>
        <span className="media-card-art">
          {showImage ? (
            <img
              className="poster"
              src={imageUrl}
              alt=""
              loading="lazy"
              draggable={false}
              onError={() => setFailedImage(imageUrl)}
            />
          ) : (
            <PosterFallback title={title} kind={kind} />
          )}
          {progress === undefined || progress === null ? null : (
            <span className="media-card-progress" aria-hidden="true">
              <span style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }} />
            </span>
          )}
        </span>
        <span className="media-card-title">{title}</span>
        {subtitle === undefined || subtitle === null ? null : (
          <span className="media-card-subtitle">{subtitle}</span>
        )}
      </button>
      {action == null ? null : <div className="media-card-action">{action}</div>}
      <Button
        className="media-card-play"
        variant="icon"
        onClick={onPlay}
        aria-label={`Play ${title}`}
      >
        <Play aria-hidden="true" size={18} fill="currentColor" strokeWidth={0} />
      </Button>
    </article>
  );
};
