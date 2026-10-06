import { useEffect, useMemo, useRef } from "react";
import { type Throttled, throttle } from "./throttle";

/** A throttled `callback` that always reaches the latest one rendered and stops on unmount. */
export const useThrottledCallback = <Args extends ReadonlyArray<unknown>>(
  callback: (...args: Args) => void,
  intervalMs: number,
): Throttled<Args> => {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  }, [callback]);

  const throttled = useMemo(
    () => throttle((...args: Args) => latest.current(...args), intervalMs),
    [intervalMs],
  );
  useEffect(() => throttled.cancel, [throttled]);

  return throttled;
};
