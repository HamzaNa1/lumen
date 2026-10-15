import type { PlaybackInfo } from "@lumen/contracts";

export type PlaybackInfoContent =
  | { readonly kind: "loading" }
  /** Nothing is playing to report on. */
  | { readonly kind: "idle" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly info: PlaybackInfo };

/**
 * Asks for playback info now, then again `intervalMs` after each answer, so a slow player is
 * never asked twice at once. `currentLoad` is read afresh each time and is undefined while nothing
 * is playing. Returns a function that stops asking; no answer is passed on after it is called.
 */
export const pollPlaybackInfo = (
  currentLoad: () => (() => Promise<PlaybackInfo>) | undefined,
  onContent: (content: PlaybackInfoContent) => void,
  intervalMs: number,
): (() => void) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async (): Promise<void> => {
    const load = currentLoad();
    const content: PlaybackInfoContent =
      load === undefined
        ? { kind: "idle" }
        : await load().then(
            (info) => ({ kind: "ready", info }) as const,
            () => ({ kind: "failed" }) as const,
          );
    if (stopped) return;
    onContent(content);
    timer = setTimeout(() => void refresh(), intervalMs);
  };
  void refresh();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};
