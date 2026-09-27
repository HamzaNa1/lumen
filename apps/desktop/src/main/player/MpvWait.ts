import type { MpvIpc } from "./MpvIpc";
/** Subscribe before issuing a command: command acknowledgement is not media readiness. */
export const runUntilMpvEvent = async (
  ipc: MpvIpc,
  event: string,
  action: () => Promise<unknown>,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<void> => {
  signal?.throwIfAborted();
  let cleanup = () => {};
  const completed = new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const ready = () => finish();
    const ended = (value: unknown) => {
      const reason = (value as { reason?: unknown } | null)?.reason;
      if (reason === "error") finish(new Error("MPV could not play this media"));
    };
    const abort = () => finish(new Error("Playback was cancelled"));
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    cleanup = () => {
      clearTimeout(timer);
      ipc.off(event, ready);
      ipc.off("end-file", ended);
      signal?.removeEventListener("abort", abort);
    };
    ipc.on(event, ready);
    ipc.on("end-file", ended);
    signal?.addEventListener("abort", abort, { once: true });
  });
  // Observe both promises immediately, including early load errors and cancellation.
  try {
    await Promise.all([action(), completed]);
  } finally {
    cleanup();
  }
};
