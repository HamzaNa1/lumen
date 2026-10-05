import type { PlayerSession } from "@lumen/contracts";
import type { MediaElementLike } from "../HtmlMediaPlayer";

export type DeliveryFailureKind = "transport" | "authorization" | "decode" | "quota";
export class DeliveryFailure extends Error {
  constructor(
    readonly kind: DeliveryFailureKind,
    message: string,
  ) {
    super(message);
  }
}

export interface MediaSourceAdapter {
  readonly kind: "direct" | "managed";
  load(session: PlayerSession, startAtSeconds: number, signal: AbortSignal): Promise<void>;
  seek(position: number): void;
  estimatedEncodedBytes?(): number;
  dispose(): void;
}

export const waitForMediaMetadata = (
  element: MediaElementLike,
  signal: AbortSignal,
  timeoutMs: number,
  start: () => void,
  mediaError: () => Error,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      element.removeEventListener("loadedmetadata", loaded);
      element.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const loaded = (): void => {
      cleanup();
      resolve();
    };
    const failed = (): void => {
      cleanup();
      reject(mediaError());
    };
    const aborted = (): void => {
      cleanup();
      reject(new DOMException("Playback cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for media to load"));
    }, timeoutMs);
    element.addEventListener("loadedmetadata", loaded);
    element.addEventListener("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    try {
      start();
    } catch (cause) {
      cleanup();
      reject(cause);
    }
  });

export class DirectSource implements MediaSourceAdapter {
  readonly kind = "direct";
  constructor(
    private readonly element: MediaElementLike,
    private readonly origin: string,
    private readonly timeoutMs: number,
    private readonly mediaError: () => Error,
  ) {}
  load(session: PlayerSession, _startAtSeconds: number, signal: AbortSignal): Promise<void> {
    const url = new URL(session.streamUrl, this.origin);
    if (url.origin !== new URL(this.origin).origin)
      throw new Error("The media URL must belong to this server");
    url.searchParams.set("grant", session.grantToken);
    return waitForMediaMetadata(
      this.element,
      signal,
      this.timeoutMs,
      () => {
        this.element.src = url.toString();
        this.element.load();
      },
      this.mediaError,
    );
  }
  seek(position: number): void {
    this.element.currentTime = position;
  }
  dispose(): void {}
}
