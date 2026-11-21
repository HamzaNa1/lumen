import { useCallback, useEffect, useRef } from "react";
import {
  createWheelVolumeStepper,
  stepVolume,
  toggleMute,
  VOLUME_STEP,
  type VolumeTarget,
} from "./playerVolume";

const textInputSelector =
  'input:not([type="range"]), select, textarea, [contenteditable], [role="combobox"]';
const controlInputSelector =
  'input[type="range"], [role="slider"], [role="menu"], [role="listbox"]';
const wheelScrollableSelector =
  'input:not([type="range"]), select, textarea, [contenteditable], [role="dialog"], [role="menu"], [role="listbox"], [data-popup-open], .media-player-settings-panel, .media-player-info, .show-drawer, .show-drawer-scrim, .popover-popup, .select-popup, .dialog-popup';

interface PlayerShortcutsOptions {
  readonly enabled: boolean;
  readonly position: number;
  readonly duration: number | null;
  readonly volume: number;
  readonly muted: boolean;
  readonly fullscreen: boolean;
  /** Toggles fullscreen. Undefined where fullscreen is unavailable. */
  readonly onFullscreen: (() => void) | undefined;
  readonly onPause: () => void;
  readonly onSeek: (positionSeconds: number) => void;
  readonly onVolume: (volume: number, muted: boolean) => void;
}

export const usePlayerShortcuts = ({
  enabled,
  position,
  duration,
  volume,
  muted,
  fullscreen,
  onFullscreen,
  onPause,
  onSeek,
  onVolume,
}: PlayerShortcutsOptions): ((seconds: number) => void) => {
  // Tracks rapid consecutive arrow/wheel steps before the player state re-renders.
  const syncedVolume = useRef<VolumeTarget>({ volume, muted });
  const latestVolume = useRef<VolumeTarget>({ volume, muted });
  if (syncedVolume.current.volume !== volume || syncedVolume.current.muted !== muted) {
    syncedVolume.current = { volume, muted };
    latestVolume.current = { volume, muted };
  }

  const applyVolume = useCallback(
    (next: VolumeTarget): void => {
      latestVolume.current = next;
      onVolume(next.volume, next.muted);
    },
    [onVolume],
  );

  const seekBy = useCallback(
    (seconds: number): void => {
      if (!enabled || duration === null) return;
      onSeek(Math.max(0, Math.min(duration, position + seconds)));
    },
    [duration, enabled, onSeek, position],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.target instanceof Element && event.target.closest(textInputSelector) !== null)
      )
        return;

      if (event.key.toLowerCase() === "m" && enabled) {
        event.preventDefault();
        if (!event.repeat)
          applyVolume(toggleMute(latestVolume.current.volume, latestVolume.current.muted));
        return;
      }

      if (event.target instanceof Element && event.target.closest(controlInputSelector) !== null)
        return;

      if (event.key === " " && enabled) {
        if (
          event.target instanceof Element &&
          event.target.closest('a, button, [role="button"]') !== null
        )
          return;
        event.preventDefault();
        if (!event.repeat) onPause();
      } else if (event.key === "ArrowLeft" && enabled && duration !== null) {
        event.preventDefault();
        seekBy(-10);
      } else if (event.key === "ArrowRight" && enabled && duration !== null) {
        event.preventDefault();
        seekBy(10);
      } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && enabled) {
        if (
          event.target instanceof Element &&
          event.target.closest('.show-drawer, [role="dialog"]') !== null
        )
          return;
        event.preventDefault();
        applyVolume(
          stepVolume(
            latestVolume.current.volume,
            event.key === "ArrowUp" ? VOLUME_STEP : -VOLUME_STEP,
          ),
        );
      } else if (event.key.toLowerCase() === "f" && onFullscreen !== undefined) {
        event.preventDefault();
        if (!event.repeat) onFullscreen();
      } else if (
        event.key === "Escape" &&
        fullscreen &&
        onFullscreen !== undefined &&
        // An open popup takes Escape to close itself.
        document.querySelector("[data-popup-open]") === null
      ) {
        event.preventDefault();
        onFullscreen();
      }
    };

    const stepWheel = createWheelVolumeStepper();
    const onWheel = (event: WheelEvent): void => {
      if (
        !enabled ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.target instanceof Element && event.target.closest(wheelScrollableSelector) !== null)
      )
        return;
      if (event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      const direction = stepWheel(event);
      if (direction !== 0)
        applyVolume(stepVolume(latestVolume.current.volume, direction * VOLUME_STEP));
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onWheel);
    };
  }, [applyVolume, duration, enabled, fullscreen, onFullscreen, onPause, seekBy]);

  return seekBy;
};
