import { useEffect, useMemo, useRef } from "react";
import { type ClickGesture, clickGesture } from "./clickGesture";

/** A click gesture that always reaches the latest callbacks rendered and stops on unmount. */
export const useClickGesture = (
  onSingle: () => void,
  onDouble: () => void,
  delayMs: number,
): ClickGesture => {
  const latest = useRef({ onSingle, onDouble });
  useEffect(() => {
    latest.current = { onSingle, onDouble };
  }, [onSingle, onDouble]);

  const gesture = useMemo(
    () =>
      clickGesture({
        onSingle: () => latest.current.onSingle(),
        onDouble: () => latest.current.onDouble(),
        delayMs,
      }),
    [delayMs],
  );
  useEffect(() => gesture.cancel, [gesture]);

  return gesture;
};
