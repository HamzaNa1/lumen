import type { IpcAccount, IpcItem, IpcPlayerState, IpcWatchGroupState } from "@lumen/contracts";
import { Button, Shell } from "@lumen/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet, useMatches, useNavigate, useRouter } from "@tanstack/react-router";
import { CircleAlert, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectPage } from "./ConnectPage";
import { errorMessage } from "./format";
import { LumenMark } from "./LumenMark";
import { Sidebar } from "./Sidebar";
import {
  bridge,
  itemPage,
  refreshWatchProgress,
  WorkspaceContext,
  type WorkspaceValue,
} from "./Workspace";

const useAccounts = () =>
  useQuery({ queryKey: ["accounts"], queryFn: () => bridge.accounts.list() });

export const App = (): React.ReactElement => {
  const accountsQuery = useAccounts();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  // Follow the rendered matches rather than the pending location, so the shell and the player
  // page swap in the same commit and the player never renders inside the shell.
  const onPlayerRoute = useMatches({
    select: (matches) => matches.some((match) => match.routeId === "/player"),
  });
  const [group, setGroup] = useState<IpcWatchGroupState | null>(null);
  const groupRef = useRef<IpcWatchGroupState | null>(null);
  const pendingStart = useRef<IpcItem | null>(null);
  const [playingItem, setPlayingItem] = useState<IpcItem | null>(null);
  const [player, setPlayer] = useState<IpcPlayerState | null>(null);
  const [playbackLoading, setPlaybackLoading] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [connectionsView, setConnectionsView] = useState<"starting" | "saved" | "add" | null>(
    "starting",
  );
  const [startupError, setStartupError] = useState<string | null>(null);
  const startupAttempted = useRef(false);
  const [signInAccount, setSignInAccount] = useState<IpcAccount | null>(null);
  const startingItemId = useRef<string | null>(null);
  // Where to go when the viewer leaves the player.
  const returnTo = useRef("/");
  const activePlayer = useRef<IpcPlayerState | null>(null);
  const wasOnPlayerRoute = useRef(onPlayerRoute);
  const onPlayerRouteRef = useRef(onPlayerRoute);
  onPlayerRouteRef.current = onPlayerRoute;
  const updatePlayer = useCallback((state: IpcPlayerState | null): void => {
    activePlayer.current = state;
    setPlayer(state);
  }, []);

  useEffect(() => {
    const receivePlayer = (state: IpcPlayerState | null): void => {
      updatePlayer(state);
    };
    const unsubscribe = bridge.player.onState(receivePlayer);
    void bridge.player
      .state()
      .then(receivePlayer)
      .catch(() => undefined);
    return unsubscribe;
  }, [updatePlayer]);
  useEffect(() => {
    let disposed = false;
    let lastPlaybackId: string | null = null;
    const receive = (state: IpcWatchGroupState | null): void => {
      if (disposed) return;
      groupRef.current = state;
      setGroup(state);
      const playback = state?.snapshot?.playback;
      if (
        playback?.type === "playback" &&
        playback.state.media !== null &&
        ["playing", "paused"].includes(playback.state.mode)
      ) {
        const playbackId = playback.state.playbackId;
        if (lastPlaybackId === playbackId) return;
        lastPlaybackId = playbackId;
        pendingStart.current = null;
        returnTo.current = "/watch-groups";
        void navigate({ to: "/player" });
        const media = playback.state.media;
        void bridge.library
          .itemDetails(media.itemId)
          .then((details) => {
            if (disposed || lastPlaybackId !== playbackId) return;
            setPlayingItem({
              ...details.item,
              durationMs: media.durationMs,
              resumePositionSeconds: null,
            });
          })
          .catch(() => undefined);
      } else if (state !== null && playback !== undefined) {
        lastPlaybackId = null;
        pendingStart.current = null;
        setPlayingItem(null);
        if (onPlayerRouteRef.current) void navigate({ to: "/watch-groups", replace: true });
      }
    };
    const unsubscribe = bridge.watchGroups.onState(receive);
    void bridge.watchGroups
      .state()
      .then(receive)
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [navigate]);
  const beginPlayback = useCallback(
    async (item: IpcItem): Promise<void> => {
      if (startingItemId.current === item.id) return;
      startingItemId.current = item.id;
      setPlaybackLoading(true);
      setPlaybackError(null);
      updatePlayer(null);
      try {
        await bridge.player.start(item.id, item.resumePositionSeconds ?? undefined);
        if (!onPlayerRouteRef.current) {
          await bridge.player.cleanup();
          updatePlayer(null);
          return;
        }
        const state = await bridge.player.state();
        if (!onPlayerRouteRef.current) {
          await bridge.player.cleanup();
          updatePlayer(null);
          return;
        }
        updatePlayer(state);
      } catch (cause) {
        if (!onPlayerRouteRef.current) return;
        setPlaybackError(errorMessage(cause, "Playback could not start"));
      } finally {
        startingItemId.current = null;
        if (onPlayerRouteRef.current) setPlaybackLoading(false);
      }
    },
    [updatePlayer],
  );
  const surfaceReady = useCallback((): void => {
    const item = pendingStart.current;
    pendingStart.current = null;
    if (item !== null) void beginPlayback(item);
  }, [beginPlayback]);
  const reportPlaybackError = useCallback((cause: unknown): void => {
    setPlaybackError(errorMessage(cause, "The in-app player surface could not be prepared"));
  }, []);
  const openItem = (item: IpcItem): void => {
    void navigate(itemPage(item));
  };
  const queuePlayback = (item: IpcItem): void => {
    if (item.kind === "show" || item.kind === "season") {
      openItem(item);
      return;
    }
    setPlaybackError(null);
    pendingStart.current = item;
    setPlayingItem(item);
    if (!onPlayerRouteRef.current) returnTo.current = router.state.location.href;
    void navigate({ to: "/player" });
  };
  const accounts = accountsQuery.data?.accounts ?? [];
  const active =
    accounts.find((account) => account.connectionId === accountsQuery.data?.activeConnectionId) ??
    null;
  useEffect(() => {
    if (!accountsQuery.isSuccess || connectionsView !== "starting" || startupAttempted.current)
      return;
    startupAttempted.current = true;
    if (active === null) {
      setConnectionsView("saved");
      return;
    }
    void bridge.accounts
      .activate(active.connectionId)
      .then((result) => {
        queryClient.setQueryData(["accounts"], result);
        setConnectionsView(null);
      })
      .catch((cause) => {
        setStartupError(errorMessage(cause, "Could not open server"));
        setConnectionsView("saved");
      });
  }, [accountsQuery.isSuccess, active, connectionsView, queryClient]);
  const playerUnavailable = player === null;
  useEffect(() => {
    const leavingPlayer = wasOnPlayerRoute.current && !onPlayerRoute;
    wasOnPlayerRoute.current = onPlayerRoute;
    if (!leavingPlayer) return;
    updatePlayer(null);
    setPlayingItem(null);
    setPlaybackLoading(false);
    setPlaybackError(null);
    pendingStart.current = null;
    const currentGroup = groupRef.current;
    const remoteTerminal =
      currentGroup !== null &&
      (currentGroup.snapshot?.playback.type === "playback-access-denied" ||
        (currentGroup.snapshot?.playback.type === "playback" &&
          ["stopped", "ended"].includes(currentGroup.snapshot.playback.state.mode)));
    if (remoteTerminal) return;
    // The page playback started from can mount while the session is still stopping.
    // Refresh progress and next up once the stop request has finished.
    void bridge.player
      .cleanup()
      .catch(() => undefined)
      .then(() => {
        if (active !== null)
          return refreshWatchProgress(queryClient, [
            active.connectionId,
            active.serverId,
            active.userId,
          ]);
      });
  }, [active, onPlayerRoute, queryClient, updatePlayer]);
  useEffect(() => {
    if (!onPlayerRoute) return;
    void bridge.player.display({
      title: playingItem?.title ?? "Now playing",
      context:
        group === null
          ? `${active?.serverLabel ?? "Lumen"} · Original quality`
          : `${group.snapshot?.name ?? "Watch group"} · ${group.status === "ready" ? "Watching together" : group.status}`,
      duration: playingItem?.durationMs == null ? null : Math.floor(playingItem.durationMs / 1_000),
      loading:
        playbackLoading ||
        (group !== null && ["connecting", "synchronizing"].includes(group.status)),
      error: group?.error ?? (playerUnavailable ? playbackError : null),
    });
  }, [
    active,
    group,
    onPlayerRoute,
    playingItem,
    playerUnavailable,
    playbackLoading,
    playbackError,
  ]);
  useEffect(
    () =>
      bridge.player.onOverlayAction((action) => {
        // Leaving the player route stops playback and clears its state.
        if (action === "back" || action === "stop")
          void router.navigate({ href: returnTo.current, replace: true });
        else if (groupRef.current !== null) void bridge.watchGroups.retry();
        else if (playingItem !== null) void beginPlayback(playingItem);
      }),
    [beginPlayback, playingItem, router],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        void navigate({ to: "/search" }).then(() =>
          document.querySelector<HTMLInputElement>("#search-input")?.focus(),
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  if (accountsQuery.isLoading)
    return (
      <div className="app-loading" role="status" aria-label="Loading Lumen">
        <LoaderCircle className="spinner" aria-hidden="true" size={22} />
      </div>
    );
  if (accountsQuery.isError)
    return (
      <ConnectPage
        initialError="Saved servers could not be loaded. Connect to a server to continue."
        onChanged={() => void queryClient.invalidateQueries({ queryKey: ["accounts"] })}
      />
    );
  if (connectionsView === "starting")
    return (
      <main className="connect-page" role="status" aria-label="Connecting to server">
        <div className="connect-column">
          <div className="connect-brand">
            <LumenMark />
            <span>Lumen</span>
          </div>
          <section className="connect-card">
            <header className="connect-heading">
              <h1>Connecting to {active?.serverLabel ?? "server"}…</h1>
              <p>Opening your last server.</p>
            </header>
            <LoaderCircle className="spinner" aria-hidden="true" size={22} />
          </section>
        </div>
      </main>
    );
  if (accounts.length === 0 || active === null)
    return (
      <ConnectPage
        accounts={accounts}
        initialError={startupError ?? undefined}
        onChanged={() => {
          setStartupError(null);
          setConnectionsView(null);
          void queryClient.invalidateQueries({ queryKey: ["accounts"] });
        }}
      />
    );

  if (connectionsView !== null)
    return (
      <ConnectPage
        accounts={accounts}
        activeConnectionId={startupError === null ? active.connectionId : undefined}
        initialError={startupError ?? undefined}
        initialShowAddServer={connectionsView === "add"}
        initialSignInAccount={signInAccount}
        onClose={
          startupError === null
            ? () => {
                setSignInAccount(null);
                setConnectionsView(null);
              }
            : undefined
        }
        onChanged={() => {
          setStartupError(null);
          setSignInAccount(null);
          setConnectionsView(null);
          void queryClient.invalidateQueries({ queryKey: ["accounts"] });
        }}
      />
    );

  const scope = [active.connectionId, active.serverId, active.userId] as const;
  const workspace = {
    group,
    surfaceReady,
    account: active,
    scope,
    openItem,
    playItem: queuePlayback,
    openConnections: (view) => {
      setSignInAccount(null);
      setConnectionsView(view);
    },
    playingItem,
    player,
    playbackLoading,
    playbackError,
    beginPlayback,
    reportPlaybackError,
  } satisfies WorkspaceValue;

  return (
    <WorkspaceContext.Provider value={workspace}>
      {onPlayerRoute ? (
        <Outlet />
      ) : (
        <Shell
          sidebar={
            <Sidebar
              account={active}
              accounts={accounts}
              scope={scope}
              onActivate={(id) => {
                void bridge.accounts
                  .activate(id)
                  .then(() => queryClient.invalidateQueries())
                  .catch((cause) => {
                    if (errorMessage(cause, "").includes("Sign-in required")) {
                      setSignInAccount(accounts.find((entry) => entry.connectionId === id) ?? null);
                      setConnectionsView("saved");
                    } else setPlaybackError(errorMessage(cause, "Could not open server"));
                  });
              }}
              onRemove={(id) => {
                void bridge.accounts
                  .remove(id)
                  .then(() => queryClient.invalidateQueries())
                  .catch(() => undefined);
              }}
              onAddServer={() => {
                setSignInAccount(null);
                setConnectionsView("add");
              }}
            />
          }
        >
          <Outlet />
          {playbackError === null ? null : (
            <div className="toast" role="alert">
              <CircleAlert aria-hidden="true" size={17} />
              <span>{playbackError}</span>
              <Button
                variant="icon"
                size="sm"
                aria-label="Dismiss"
                onClick={() => setPlaybackError(null)}
              >
                <X aria-hidden="true" size={15} />
              </Button>
            </div>
          )}
        </Shell>
      )}
    </WorkspaceContext.Provider>
  );
};
