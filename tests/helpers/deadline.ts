/** Bounds external work without leaving a rejection handler or timer callback attached. */
export const withDeadline = async <T>(
  work: Promise<T>,
  timeoutMs: number,
  message = "Operation timed out",
): Promise<T> => {
  const signal = AbortSignal.timeout(timeoutMs);
  let rejectTimeout: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    rejectTimeout = () => reject(new Error(message));
    signal.addEventListener("abort", rejectTimeout, { once: true });
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    signal.removeEventListener("abort", rejectTimeout);
  }
};
