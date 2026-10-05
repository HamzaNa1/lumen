import type { LumenRuntime, PlayerSurface } from "@lumen/client/runtime";
import type { DesktopBridge } from "../shared/bridge";

/**
 * Tells the main process where the video belongs. MPV draws into a native window placed over
 * this element, so its bounds are sent whenever they change.
 */
const mountNativeSurface = (
  bridge: DesktopBridge,
  element: HTMLElement,
  onError: (cause: unknown) => void,
): PlayerSurface => {
  const syncSurface = async (): Promise<void> => {
    const bounds = element.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) return;
    await bridge.player.surface({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  };
  const ready = syncSurface();
  const observer = new ResizeObserver(() => void syncSurface().catch(onError));
  observer.observe(element);
  return {
    ready,
    release: () => {
      observer.disconnect();
      void bridge.player.surface(null).catch(() => undefined);
    },
  };
};

/** The shared application's platform on desktop: everything goes through the main process. */
export const createDesktopRuntime = (bridge: DesktopBridge): LumenRuntime => ({
  capabilities: {
    serverSwitching: true,
    nativeAudioOutput: true,
    audioDiagnostics: true,
    trackSelection: true,
    fullscreen: true,
    player: { name: "MPV", description: "Video plays in the built-in MPV player." },
    signInStorage: "device",
  },
  accounts: {
    ...bridge.accounts,
    // Only this window changes the saved accounts, and it refreshes them itself.
    onChange: () => () => undefined,
    fixedOrigin: null,
  },
  catalog: {
    home: bridge.library.home,
    libraries: bridge.library.list,
    items: bridge.library.items,
    itemDetails: bridge.library.itemDetails,
    itemChildren: bridge.library.itemChildren,
    nextUp: bridge.library.nextUp,
    setWatched: bridge.library.setWatched,
    search: bridge.library.search,
    episodeOrder: bridge.library.episodeOrder,
    setEpisodeOrder: bridge.library.setEpisodeOrder,
  },
  admin: bridge.admin,
  artwork: { url: bridge.library.artwork },
  playback: {
    start: async (itemId, startAtSeconds, title) => {
      await bridge.player.start(itemId, startAtSeconds, title);
    },
    pause: bridge.player.pause,
    seek: bridge.player.seek,
    volume: bridge.player.volume,
    selectAudio: bridge.player.selectAudio,
    selectSubtitle: bridge.player.selectSubtitle,
    // MPV starts playback without waiting for the viewer, so there is never anything to allow.
    allowPlayback: async () => undefined,
    stop: async () => {
      await bridge.player.stop();
    },
    state: bridge.player.state,
    onState: bridge.player.onState,
    // The main process does not report failures after playback has started.
    onFailure: () => () => undefined,
    mountSurface: (element, onError) => mountNativeSurface(bridge, element, onError),
    fullscreen: bridge.player.fullscreen,
    fullscreenState: bridge.player.fullscreenState,
    onFullscreenChange: bridge.player.onFullscreenChange,
    presentation: {
      kind: "external",
      display: bridge.player.display,
      onAction: bridge.player.onOverlayAction,
    },
    nativeAudio: {
      output: bridge.player.audioOutput,
      copyDiagnostics: bridge.player.copyAudioDiagnostics,
    },
  },
  watch: bridge.watch,
});
