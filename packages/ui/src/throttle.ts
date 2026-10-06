export interface Throttled<Args extends ReadonlyArray<unknown>> {
  (...args: Args): void;
  /** Drops the call still waiting for its turn. */
  readonly cancel: () => void;
}

/**
 * Runs `callback` at most once per `intervalMs`. The first call runs at once; of the calls
 * arriving inside the interval only the latest survives, and it runs when the interval ends.
 */
export const throttle = <Args extends ReadonlyArray<unknown>>(
  callback: (...args: Args) => void,
  intervalMs: number,
): Throttled<Args> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Args | null = null;

  const run = (args: Args): void => {
    timer = setTimeout(() => {
      timer = null;
      if (pending === null) return;
      const next = pending;
      pending = null;
      run(next);
    }, intervalMs);
    callback(...args);
  };

  const throttled = (...args: Args): void => {
    if (timer === null) run(args);
    else pending = args;
  };
  throttled.cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return throttled;
};
