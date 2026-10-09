import { exportPlaybackDiagnostics } from "./ExportDiagnostics";
import {
  cookieCredentials,
  ServerApi,
  viewerPlayback,
  WatchPlaybackController,
  type WatchPlayer,
  type WatchServer,
} from "@lumen/client";
import type { LumenRuntime, PlayerSurface } from "@lumen/client/runtime";
import type { PlayerState, WatchStatus } from "@lumen/contracts";
import { BrowserAccounts } from "./BrowserAccounts";
import { HtmlMediaPlayer } from "./HtmlMediaPlayer";
import { storedVolumeSettings } from "./volumeSettings";

export interface BrowserRuntime extends LumenRuntime {
  readonly api: ServerApi;
  /** Releases the page-level listeners and connections this runtime holds. */
  readonly dispose: () => void;
}

const subscribers = <T>() => {
  const callbacks = new Set<(value: T) => void>();
  return {
    emit: (value: T): void => {
      for (const callback of callbacks) callback(value);
    },
    subscribe: (callback: (value: T) => void): (() => void) => {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
  };
};

/**
 * The shared application's platform in a browser. It talks to the server that served the page,
 * signs in with that server's cookie session, and plays media in a video element.
 */
export const createBrowserRuntime = (origin: string = window.location.origin): BrowserRuntime => {
  const playerStates = subscribers<PlayerState | null>();
  const playerFailures = subscribers<string>();
  const watchStates = subscribers<WatchStatus>();
  const fullscreenChanges = subscribers<boolean>();

  // Assigned below; the API needs to report a rejected session before the accounts exist.
  let accounts: BrowserAccounts | null = null;
  const api = new ServerApi({
    origin,
    credentials: cookieCredentials(),
    onUnauthorized: () => accounts?.sessionRejected(),
  });

  const video = document.createElement("video");
  video.playsInline = true;
  video.preload = "auto";
  // Belt and braces with the page's policy: the media URL carries a grant and is never a referrer.
  video.setAttribute("referrerpolicy", "no-referrer");
  // The shared controls are the only controls.
  video.controls = false;
  video.disablePictureInPicture = true;

  // Assigned below; the player is what the watch controller drives, so it has to exist first.
  let watchController: WatchPlaybackController | null = null;
  const player = new HtmlMediaPlayer({
    element: video,
    api,
    onState: playerStates.emit,
    volumeSettings: storedVolumeSettings,
    onFailure: (cause) => {
      // The group must learn that this viewer's player failed, or leaving the player afterwards
      // would be taken as a request to stop playback for everyone.
      watchController?.playerFailed(cause);
      playerFailures.emit(cause.message);
    },
  });

  const watchServer: WatchServer = {
    serverOrigin: api.serverOrigin,
    get supportsWatchGroups() {
      return api.supportsWatchGroups;
    },
    watchAuthentication: () => ({ session: "cookie" }),
  };
  const watchPlayer: WatchPlayer<WatchServer> = {
    start: ({ itemId, startAtSeconds, paused }) => player.start({ itemId, startAtSeconds, paused }),
    stop: () => player.stop(),
    getState: () => player.getState(),
    sample: (sessionId) => player.sample(sessionId),
    recordSynchronization: (fields) => player.recordSynchronization(fields),
    seek: (sessionId, positionSeconds) => player.seek(sessionId, positionSeconds),
    pause: (sessionId, paused) => player.pause(sessionId, paused),
    speed: (sessionId, speed) => player.speed(sessionId, speed),
    buffer: (sessionId) => player.buffer(sessionId),
  };
  const watch = new WatchPlaybackController(watchPlayer, watchStates.emit);
  watchController = watch;

  accounts = new BrowserAccounts(api, async () => {
    watch.disconnect();
    await player.stop();
  });
  const browserAccounts = accounts;

  /** Makes sure the watch-group connection belongs to the signed-in account. */
  const connectWatch = async (): Promise<void> => {
    const { activeConnectionId } = await browserAccounts.list();
    if (activeConnectionId === null) throw new Error("Sign-in required");
    watch.connect(watchServer, activeConnectionId);
  };

  let fullscreenTarget: HTMLElement | null = null;
  const onFullscreenChange = (): void =>
    fullscreenChanges.emit(document.fullscreenElement !== null);
  // Timers stop while a page is hidden or the device sleeps, and the network may have gone away.
  // Before carrying on, find out what the server still knows about this session and playback.
  const resume = (): void => {
    void browserAccounts
      .revalidate()
      .then(() => player.reconcile())
      .then(() => watch.resume())
      .catch(() => undefined);
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") resume();
    else player.checkpoint();
  };
  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) resume();
  };
  const onPageHide = (): void => player.leave();
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("online", resume);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("pagehide", onPageHide);

  const mountSurface = (element: HTMLElement): PlayerSurface => {
    element.append(video);
    fullscreenTarget = element.parentElement ?? element;
    watch.setSurfaceReady(true);
    return {
      ready: Promise.resolve(),
      release: () => {
        watch.setSurfaceReady(false);
        if (video.parentElement === element) video.remove();
        if (fullscreenTarget === (element.parentElement ?? element)) fullscreenTarget = null;
      },
    };
  };

  const commands = viewerPlayback(watch, {
    start: (itemId, startAtSeconds) => player.start({ itemId, startAtSeconds }),
    pause: (sessionId, paused) => player.pause(sessionId, paused),
    seek: (sessionId, positionSeconds) => player.seek(sessionId, positionSeconds),
    getActiveState: (sessionId) => player.getActiveState(sessionId),
  });

  return {
    api,
    trackSettings: {
      read: () => api.trackPreferences(),
      update: (input) => api.updateTrackPreferences(input),
    },
    capabilities: {
      serverSwitching: false,
      nativeAudioOutput: false,
      audioDiagnostics: true,
      // Only some browsers let a page switch a file's audio tracks, and none expose the subtitles
      // embedded in it. The player lists the tracks that really can be switched.
      trackSelection: "audioTracks" in HTMLMediaElement.prototype,
      fullscreen: document.fullscreenEnabled,
    },
    accounts: browserAccounts,
    catalog: {
      home: () => api.home(),
      libraries: () => api.libraries(),
      items: (libraryId, cursor) => api.items(libraryId, cursor),
      itemDetails: (itemId) => api.itemDetails(itemId),
      itemChildren: (itemId, cursor) => api.itemChildren(itemId, cursor),
      nextUp: (itemId) => api.nextUp(itemId),
      setWatched: (itemId, completed) => api.setWatched(itemId, completed),
      search: (query, libraryId) => api.search(query, libraryId),
      episodeOrder: (itemId) => api.episodeOrder(itemId),
      setEpisodeOrder: (itemId, selection) => api.setEpisodeOrder(itemId, selection),
    },
    admin: {
      listUsers: () => api.users(),
      createUser: (input) => api.createUser(input),
      updateUser: ({ userId, ...input }) => api.updateUser(userId, input),
      listLibraries: () => api.adminLibraries(),
      renameServer: async (name) => browserAccounts.serverRenamed(await api.renameServer(name)),
      metadataSettings: () => api.metadataSettings(),
      updateMetadataSettings: ({ tmdbApiKey }) => api.updateMetadataSettings(tmdbApiKey),
      createLibrary: (input) => api.createLibrary(input),
      updateLibrary: ({ libraryId, ...input }) => api.updateLibrary(libraryId, input),
      deleteLibrary: (libraryId) => api.deleteLibrary(libraryId),
      listRoots: (libraryId) => api.libraryRoots(libraryId),
      addRoot: (input) => api.addLibraryRoot(input),
      deleteRoot: (rootId) => api.deleteLibraryRoot(rootId),
      startScan: ({ libraryId, mode }) => api.startScan(libraryId, mode),
      scanStatus: (runId) => api.scanStatus(runId),
      jobLog: () => api.jobLog(),
    },
    // The image element sends the session cookie itself, so artwork loads straight from the server.
    artwork: { url: async (artworkId) => api.artworkPath(artworkId) },
    playback: {
      start: async (itemId, startAtSeconds, title) => {
        await commands.start(itemId, startAtSeconds, title);
      },
      pause: commands.pause,
      seek: commands.seek,
      volume: (sessionId, volume, muted) => player.volume(sessionId, volume, muted),
      resetTrack: (sessionId, kind) => player.resetTrack(sessionId, kind),
      retryTrackMemory: (sessionId) => player.retryTrackMemory(sessionId),
      selectAudio: (sessionId, streamId) => player.selectAudioStream(sessionId, streamId),
      selectSubtitle: async () => {
        throw new Error("This browser cannot show this file’s subtitles");
      },
      allowPlayback: async () => {
        await player.allowPlayback();
        // In a group, playback moved on while this viewer was waiting to click.
        watch.retry();
      },
      stop: () => watch.stop(),
      state: async () => player.getState(),
      onState: playerStates.subscribe,
      onFailure: playerFailures.subscribe,
      mountSurface,
      fullscreen: async (enabled) => {
        if (enabled && document.fullscreenElement === null)
          await fullscreenTarget?.requestFullscreen();
        else if (!enabled && document.fullscreenElement !== null) await document.exitFullscreen();
        return document.fullscreenElement !== null;
      },
      fullscreenState: async () => document.fullscreenElement !== null,
      onFullscreenChange: fullscreenChanges.subscribe,
      presentation: { kind: "inline" },
      nativeAudio: null,
      copyDiagnostics: async () => {
        await exportPlaybackDiagnostics(player.playbackDiagnostics());
      },
    },
    watch: {
      state: async () => {
        await connectWatch();
        return watch.status;
      },
      action: async (action) => {
        await connectWatch();
        await watch.action(action);
        return watch.status;
      },
      retry: async () => watch.retry(),
      onState: watchStates.subscribe,
    },
    dispose: () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", resume);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", onPageHide);
      watch.close();
      void player.stop();
      browserAccounts.dispose();
      api.cancelPending();
    },
  };
};
