import { Play, Plus } from "lucide-react";
import { Button } from "./Button";

export const MediaCard = ({
  title,
  subtitle,
  imageUrl,
  onPlay,
  onOpen,
}: {
  readonly title: string;
  readonly subtitle?: string | null;
  readonly imageUrl?: string | null;
  readonly onPlay: () => void;
  readonly onOpen: () => void;
}): React.ReactElement => (
  <article className="media-card">
    <Button className="poster-button" variant="ghost" onClick={onOpen} aria-label={`Open ${title}`}>
      {imageUrl === undefined || imageUrl === null ? (
        <span className="poster-fallback">
          <span>{title.slice(0, 1)}</span>
          <span className="poster-shine" />
        </span>
      ) : (
        <img className="poster" src={imageUrl} alt="" loading="lazy" />
      )}
      <span className="poster-overlay">
        <Plus aria-hidden="true" size={18} />
        Details
      </span>
    </Button>
    <div className="media-card-info">
      <Button className="title-button" variant="ghost" onClick={onOpen}>
        {title}
      </Button>
      {subtitle === undefined || subtitle === null ? null : (
        <span className="muted">{subtitle}</span>
      )}
      <Button className="card-play" variant="icon" onClick={onPlay} aria-label={`Play ${title}`}>
        <Play aria-hidden="true" size={17} fill="currentColor" />
      </Button>
    </div>
  </article>
);
