import { ArrowDown, RotateCw } from "lucide-react";

/**
 * A new version, as a small circle. It stays muted until the viewer or the app starts getting it,
 * then its border fills with the download, and once the update is ready it offers a restart.
 */
export const UpdateButton = ({
  state,
  progress,
  label,
  onClick,
}: {
  readonly state: "available" | "active" | "ready";
  /** How much of the border is filled, from 0 to 1. */
  readonly progress: number;
  readonly label: string;
  readonly onClick: () => void;
}): React.ReactElement => (
  <button
    type="button"
    className="update-button"
    data-state={state}
    aria-label={label}
    title={label}
    onClick={onClick}
  >
    <svg className="update-button-ring" viewBox="0 0 28 28" aria-hidden="true">
      <circle className="update-button-track" cx="14" cy="14" r="13" />
      <circle
        className="update-button-progress"
        cx="14"
        cy="14"
        r="13"
        pathLength={1}
        strokeDasharray="1 1"
        strokeDashoffset={1 - progress}
      />
    </svg>
    {state === "ready" ? (
      <RotateCw aria-hidden="true" size={14} strokeWidth={2.2} />
    ) : (
      <ArrowDown aria-hidden="true" size={14} strokeWidth={2.2} />
    )}
  </button>
);
