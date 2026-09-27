import { useCallback, useEffect } from "react";

interface PlayerShortcutsOptions {
  readonly enabled: boolean;
  readonly position: number;
  readonly duration: number | null;
  readonly onPause: () => void;
  readonly onSeek: (positionSeconds: number) => void;
}

export const usePlayerShortcuts = ({
  enabled,
  position,
  duration,
  onPause,
  onSeek,
}: PlayerShortcutsOptions): ((seconds: number) => void) => {
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
        (event.target instanceof Element &&
          event.target.closest(
            'input, select, textarea, [contenteditable], [role="slider"], [role="combobox"]',
          ) !== null)
      )
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
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [duration, enabled, onPause, seekBy]);

  return seekBy;
};
