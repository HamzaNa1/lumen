import type { PlayerAction } from "@lumen/client/runtime";
import type {
  AccountSummary,
  CatalogItem,
  PlayerDisplay,
  PlayerState,
  WatchStatus,
} from "@lumen/contracts";
import { Button, Shell } from "@lumen/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet, useMatches, useNavigate, useRouter } from "@tanstack/react-router";
import { CircleAlert, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConnectPage } from "./ConnectPage";
import { episodeContext, errorMessage } from "./format";
import { LumenMark } from "./LumenMark";
import { useRuntime } from "./Runtime";
import { Sidebar } from "./Sidebar";
import {
  ACCOUNTS_KEY,
  itemDetailsQuery,
  itemPage,
  refreshWatchProgress,
  WorkspaceContext,
  type WorkspaceValue,
} from "./Workspace";


export const App = (): React.ReactElement => {
  const runtime = useRuntime();
  const presentation = runtime.playback.presentation;
  const accountsQuery = useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: () => runtime.accounts.list(),
  });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  // Follow the rendered matches rather than the pending location, so the shell and the player
  // page swap in the same commit and the player never renders inside the shell.
  const onPlayerRoute = useMatches({
    select: (matches) => matches.some((match) => match.routeId === "/player"),
  });
  const [playingItem, setPlayingItem] = useState<CatalogItem | null>(null);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [playbackLoading, setPlaybackLoading] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [connectionsView, setConnectionsView] = useState<"starting" | "saved" | "add" | null>("starting");
  const [startupError, setStartupError] = useState<string | null>(null);
  const startupAttempted = useRef(false);
  const [signInAccount, setSignInAccount] = useState<AccountSummary | null>(null);
  const startingItemId = useRef<string | null>(null);
  // Where to go when the viewer leaves the player.
  const returnTo = useRef("/");
  const leavingWatch = useRef(false);
  const watchRef = useRef<WatchStatus | null>(null);
  const [watchStatus, setWatchStatus] = useState<WatchStatus | null>(null);
  const activePlayer = useRef<PlayerState | null>(null);
  const wasOnPlayerRoute = useRef(onPlayerRoute);
  const onPlayerRouteRef = useRef(onPlayerRoute);
  onPlayerRouteRef.current = onPlayerRoute;
  const updatePlayer = useCallback((state: PlayerState | null): void => {
    activePlayer.current = state;
    setPlayer(state);
  }, []);

  useEffect(() => runtime.watch.onState((status) => {
    const previous = watchRef.current;
    watchRef.current = status;
    setWatchStatus(status);
    if (status.group?.playback == null || status.group.id !== previous?.group?.id || status.group.revision !== previous?.group?.revision) leavingWatch.current = false;
    if (status.group?.playback != null && status.connection === "connected" && !leavingWatch.current) {
      setPlayingItem(null);
      if (status.error !== null) {
        setPlaybackError(status.error);
        setPlaybackLoading(false);
      } else if (activePlayer.current?.itemId !== status.group.playback.itemId) setPlaybackLoading(true);
      if (activePlayer.current?.itemId !== status.group.playback.itemId) updatePlayer(null);
      if (!onPlayerRouteRef.current) {
        returnTo.current = router.state.location.href;
        void router.navigate({ to: "/player" });
      }
    }
    if (status.group !== null && status.group.playback === null && status.group.revision > 0 && onPlayerRouteRef.current) {
      void router.navigate({ href: returnTo.current, replace: true });
    }
  }), [router, updatePlayer, runtime]);

  useEffect(
    () =>
      runtime.accounts.onChange(() => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })),
    [queryClient, runtime],
  );

  useEffect(
    () =>
      runtime.playback.onFailure((message) => {
        if (!onPlayerRouteRef.current) return;
        setPlaybackLoading(false);
        setPlaybackError(message);
      }),
    [runtime],
  );

  useEffect(() => {
    const receivePlayer = (state: PlayerState | null): void => {
      const sharedPlayback = watchRef.current?.group?.playback;
      if (sharedPlayback != null && state !== null && state.itemId !== sharedPlayback.itemId) return;
      if (state !== null && watchRef.current?.group?.playback?.itemId === state.itemId) {
        setPlayingItem(null);
        setPlaybackLoading(false);
        setPlaybackError(null);
        updatePlayer(state);
      } else if (state !== null && !onPlayerRouteRef.current) {
        void runtime.playback.stop().catch(() => undefined);
        updatePlayer(null);
      } else updatePlayer(state);
    };
    const unsubscribe = runtime.playback.onState(receivePlayer);
    void runtime.playback
      .state()
      .then(receivePlayer)
      .catch(() => undefined);
    return unsubscribe;
  }, [updatePlayer, runtime]);
  const beginPlayback = useCallback(
    async (item: CatalogItem): Promise<void> => {
      if (startingItemId.current === item.id || activePlayer.current?.itemId === item.id) return;
      startingItemId.current = item.id;
      setPlaybackLoading(true);
      setPlaybackError(null);
      updatePlayer(null);
      try {
        await runtime.playback.start(item.id, item.resumePositionSeconds ?? undefined, item.title);
        if (watchRef.current?.group !== null && watchRef.current?.group !== undefined) return;
        if (!onPlayerRouteRef.current) {
          await runtime.playback.stop();
          updatePlayer(null);
          return;
        }
        const state = await runtime.playback.state();
        if (!onPlayerRouteRef.current) {
          await runtime.playback.stop();
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
    [updatePlayer, runtime],
  );
  const reportPlaybackError = useCallback((cause: unknown): void => {
    setPlaybackError(errorMessage(cause, "The in-app player surface could not be prepared"));
  }, []);
  const openItem = (item: CatalogItem): void => {
    void navigate(itemPage(item));
  };
  const queuePlayback = (item: CatalogItem): void => {
    if (item.kind === "show" || item.kind === "season") {
      openItem(item);
      return;
    }
    setPlaybackError(null);
    setPlayingItem(item);
    if (!onPlayerRouteRef.current) returnTo.current = router.state.location.href;
    void navigate({ to: "/player" });
  };
  const accounts = accountsQuery.data?.accounts ?? [];
  const active =
    accounts.find((account) => account.connectionId === accountsQuery.data?.activeConnectionId) ??
    null;
  useEffect(() => {
    if (!accountsQuery.isSuccess || connectionsView !== "starting" || startupAttempted.current) return;
    startupAttempted.current = true;
    if (active === null) {
      setConnectionsView("saved");
      return;
    }
    void runtime.accounts
      .activate(active.connectionId)
      .then((result) => {
        queryClient.setQueryData(ACCOUNTS_KEY, result);
        setConnectionsView(null);
      })
      .catch((cause) => {
        setStartupError(errorMessage(cause, "Could not open server"));
        setConnectionsView("saved");
      });
  }, [accountsQuery.isSuccess, active, connectionsView, queryClient, runtime]);
  // Everything cached or playing belongs to one account on one server. When that changes, none
  // of it may carry over: stop playback, drop requests still in flight, and forget the data.
  const scope = useMemo(
    () =>
      active === null ? null : ([active.connectionId, active.serverId, active.userId] as const),
    [active],
  );
  const previousScope = useRef(scope);
  useEffect(() => {
    const previous = previousScope.current;
    previousScope.current = scope;
    if (previous === null || previous.every((value, index) => value === scope?.[index])) return;
    void queryClient.cancelQueries({ queryKey: previous });
    queryClient.removeQueries({ queryKey: previous });
    queryClient.getMutationCache().clear();
    updatePlayer(null);
    setPlayingItem(null);
    setPlaybackLoading(false);
    setPlaybackError(null);
    void runtime.playback.stop().catch(() => undefined);
    if (onPlayerRouteRef.current) void router.navigate({ to: "/", replace: true });
  }, [queryClient, router, runtime, scope, updatePlayer]);
  const playerUnavailable = player === null;
  useEffect(() => {
    const leavingPlayer = wasOnPlayerRoute.current && !onPlayerRoute;
    wasOnPlayerRoute.current = onPlayerRoute;
    if (!leavingPlayer) return;
    leavingWatch.current = true;
    updatePlayer(null);
    setPlayingItem(null);
    setPlaybackLoading(false);
    setPlaybackError(null);
    // The page playback started from can mount while the session is still stopping.
    // Refresh progress and next up once the stop request has finished.
    void runtime.playback
      .stop()
      .catch(() => undefined)
      .then(() => {
        if (active !== null)
          return refreshWatchProgress(queryClient, [
            active.connectionId,
            active.serverId,
            active.userId,
          ]);
      });
  }, [active, onPlayerRoute, queryClient, updatePlayer, runtime]);
  const watchPlayback = watchStatus?.group?.playback;
  const watchTitle = watchPlayback?.title;
  // Every way into the player names the item, but only some know the show it belongs to.
  const playingDetails = useQuery(
    itemDetailsQuery(runtime, scope ?? [], scope === null ? null : (playingItem?.id ?? watchPlayback?.itemId)),
  );
  const playingContext =
    playingDetails.data?.item.kind === "episode" ? episodeContext(playingDetails.data.item) : "";
  const playerDisplay = useMemo<PlayerDisplay>(
    () => ({
      title: playingItem?.title ?? watchTitle ?? "Now playing",
      context: playingContext,
      duration: playingItem?.durationMs == null ? null : Math.floor(playingItem.durationMs / 1_000),
      loading: playbackLoading,
      error: playerUnavailable ? playbackError : null,
    }),
    [playingContext, playingItem, playerUnavailable, playbackLoading, playbackError, watchTitle],
  );
  useEffect(() => {
    if (onPlayerRoute && presentation.kind === "external") void presentation.display(playerDisplay);
  }, [onPlayerRoute, playerDisplay, presentation]);
  const onPlayerAction = useCallback(
    (action: PlayerAction): void => {
      // Leaving the player route stops playback and clears its state.
      if (action === "back" || action === "stop") {
        leavingWatch.current = true;
        void router.navigate({ href: returnTo.current, replace: true });
      } else if (playingItem !== null) void beginPlayback(playingItem);
      else if (watchRef.current?.group?.playback != null) {
        setPlaybackLoading(true);
        setPlaybackError(null);
        void runtime.watch.retry().catch(reportPlaybackError);
      }
    },
    [beginPlayback, playingItem, reportPlaybackError, router, runtime],
  );
  useEffect(
    () => (presentation.kind === "external" ? presentation.onAction(onPlayerAction) : undefined),
    [onPlayerAction, presentation],
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
        onChanged={() => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })}
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
              <h1>Connecting to {active?.serverName ?? "server"}…</h1>
              <p>Opening your last server.</p>
            </header>
            <LoaderCircle className="spinner" aria-hidden="true" size={22} />
          </section>
        </div>
      </main>
    );
  if (accounts.length === 0 || active === null || scope === null)
    return (
      <ConnectPage
        accounts={accounts}
        initialError={startupError ?? undefined}
        onChanged={() => {
          setStartupError(null);
          setConnectionsView(null);
          void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
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
        onClose={startupError === null ? () => {
          setSignInAccount(null);
          setConnectionsView(null);
        } : undefined}
        onChanged={() => {
          setStartupError(null);
          setSignInAccount(null);
          setConnectionsView(null);
          void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
        }}
      />
    );

  const workspace = {
    account: active,
    scope,
    openItem,
    playItem: queuePlayback,
    openConnections: (view) => {
      setSignInAccount(null);
      setConnectionsView(view);
    },
    watchPlayback: watchStatus?.group?.playback ?? null,
    playingItem,
    player,
    playbackLoading,
    playbackError,
    playerDisplay,
    onPlayerAction,
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
                void runtime.accounts
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
                void runtime.accounts
                  .remove(id)
                  .then(() => queryClient.invalidateQueries())
                  .catch((cause) => setPlaybackError(errorMessage(cause, "Could not sign out")));
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
