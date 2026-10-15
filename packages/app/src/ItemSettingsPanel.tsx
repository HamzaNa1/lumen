import { Check } from "lucide-react";
import type { ReactNode } from "react";
import type { MetadataRefresh } from "./useMetadataRefresh";

const RefreshStatus = ({ refresh }: { readonly refresh: MetadataRefresh }): React.ReactElement =>
  refresh === "failed" ? (
    <p className="item-settings-status is-failed" role="alert">
      Saved, but the refresh could not finish. Check the Job log for details.
    </p>
  ) : (
    <p className="item-settings-status" role="status">
      {refresh === "running" ? "Saved. Refreshing details from TMDb…" : null}
      {refresh === "succeeded" ? "Details refreshed." : null}
    </p>
  );

/**
 * One tab of the movie or show settings dialog. Its content scrolls, while its action and the
 * progress of the last change stay in view at the bottom.
 */
export const ItemSettingsPanel = ({
  label,
  hidden,
  refresh,
  action,
  children,
}: {
  readonly label: string;
  readonly hidden: boolean;
  readonly refresh: MetadataRefresh;
  readonly action: ReactNode;
  readonly children: ReactNode;
}): React.ReactElement => (
  <section className="item-settings-panel" aria-label={label} hidden={hidden}>
    <div className="item-settings-body">{children}</div>
    <footer className="item-settings-footer">
      <RefreshStatus refresh={refresh} />
      <div className="item-settings-actions">{action}</div>
    </footer>
  </section>
);

/** One choice in a settings list, marked once it is the one that would be saved. */
export const SettingsChoice = ({
  selected,
  disabled,
  onSelect,
  media,
  children,
}: {
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
  readonly media?: ReactNode;
  readonly children: ReactNode;
}): React.ReactElement => (
  <li>
    <button
      type="button"
      className="settings-choice"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
    >
      {media}
      <span className="settings-choice-text">{children}</span>
      <Check className="settings-choice-check" aria-hidden="true" size={16} />
    </button>
  </li>
);

export const CurrentBadge = (): React.ReactElement => (
  <span className="settings-choice-badge">Current</span>
);
