export const MediaCard = ({ title, subtitle, imageUrl, onPlay, onOpen }: { readonly title: string; readonly subtitle?: string | null; readonly imageUrl?: string | null; readonly onPlay: () => void; readonly onOpen: () => void }): React.ReactElement => (
  <article className="media-card">
    <button className="poster-button" type="button" onClick={onOpen} aria-label={`Open ${title}`}>
      {imageUrl === undefined || imageUrl === null ? <span className="poster-fallback">{title.slice(0, 1)}</span> : <img className="poster" src={imageUrl} alt="" loading="lazy" />}
    </button>
    <div className="media-card-info">
      <button className="title-button" type="button" onClick={onOpen}>{title}</button>
      {subtitle === undefined || subtitle === null ? null : <span className="muted">{subtitle}</span>}
      <button className="card-play" type="button" onClick={onPlay} aria-label={`Play ${title}`}>Play</button>
    </div>
  </article>
);
