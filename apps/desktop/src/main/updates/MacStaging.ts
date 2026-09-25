import type { EventEmitter } from "node:events";

export const waitForMacStaging = (
  native: EventEmitter,
  timeoutMs = 300_000,
): { readonly promise: Promise<void>; readonly dispose: () => void } => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // The metadata check may fail before anyone awaits staging.
  void promise.catch(() => undefined);
  const onDownloaded = (): void => resolve();
  const onError = (error: unknown): void => reject(error);
  native.once("update-downloaded", onDownloaded);
  native.once("error", onError);
  const timer = setTimeout(() => reject(Object.assign(new Error("macOS update staging timed out"), { code: "STAGING_TIMEOUT" })), timeoutMs);
  timer.unref?.();
  return {
    promise,
    dispose: () => {
      native.removeListener("update-downloaded", onDownloaded);
      native.removeListener("error", onError);
      clearTimeout(timer);
    },
  };
};
