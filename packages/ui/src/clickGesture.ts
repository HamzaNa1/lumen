export interface ClickGesture {
  /** Reports one click. */
  (): void;
  /** Drops the click still waiting to learn whether a second one follows. */
  readonly cancel: () => void;
}

/**
 * Tells a single click from a double one. A click waits `delayMs` for a second: if one arrives
 * it is a double click and `onSingle` never runs, otherwise `onSingle` runs when the wait ends.
 */
export const clickGesture = ({
  onSingle,
  onDouble,
  delayMs,
}: {
  readonly onSingle: () => void;
  readonly onDouble: () => void;
  readonly delayMs: number;
}): ClickGesture => {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const gesture = (): void => {
    if (timer !== null) {
      cancel();
      onDouble();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      onSingle();
    }, delayMs);
  };
  gesture.cancel = cancel;
  return gesture;
};
