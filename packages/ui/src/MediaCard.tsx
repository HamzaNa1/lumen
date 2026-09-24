import { Play, Plus } from "lucide-react";
import { Button } from "./Button";
import { useState } from "react";

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
}): React.ReactElement => {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  return <article className="media-card">
    <Button className="poster-button" variant="ghost" onClick={onOpen} aria-label={`Open ${title}`}>
      {imageUrl === undefined || imageUrl === null || failedImage === imageUrl ? (
        <span className="poster-fallback">
          <span>{title.slice(0, 1)}</span>
          <span className="poster-shine" />
        </span>
      ) : (
        <img className="poster" src={imageUrl} alt="" loading="lazy" onError={() => setFailedImage(imageUrl)} />
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
  </article>;
};
