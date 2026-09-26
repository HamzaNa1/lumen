import type { IpcAccount, IpcItem, IpcPlayerState } from "@lumen/contracts";
import { Button, Shell } from "@lumen/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet, useMatches, useNavigate, useRouter } from "@tanstack/react-router";
import { CircleAlert, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectPage } from "./ConnectPage";
import { errorMessage } from "./format";
import { ItemDetails } from "./ItemDetails";
import { Sidebar } from "./Sidebar";
import { bridge, WorkspaceContext, type WorkspaceValue } from "./Workspace";

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
  const [selectedItem, setSelectedItem] = useState<IpcItem | null>(null);
  const [playingItem, setPlayingItem] = useState<IpcItem | null>(null);
  const [player, setPlayer] = useState<IpcPlayerState | null>(null);
  const [playbackLoading, setPlaybackLoading] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [connectionsView, setConnectionsView] = useState<"saved" | "add" | null>("saved");
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
      if (state !== null && !onPlayerRouteRef.current) {
        void bridge.player.stop().catch(() => undefined);
        updatePlayer(null);
      } else updatePlayer(state);
    };
    const unsubscribe = bridge.player.onState(receivePlayer);
    void bridge.player
      .state()
      .then(receivePlayer)
      .catch(() => undefined);
    return unsubscribe;
  }, [updatePlayer]);
  const beginPlayback = useCallback(
    async (item: IpcItem): Promise<void> => {
      if (startingItemId.current === item.id || activePlayer.current?.itemId === item.id) return;
      startingItemId.current = item.id;
      setPlaybackLoading(true);
      setPlaybackError(null);
      updatePlayer(null);
      try {
        await bridge.player.start(item.id, item.resumePositionSeconds ?? undefined);
        if (!onPlayerRouteRef.current) {
          await bridge.player.stop();
          updatePlayer(null);
          return;
        }
        const state = await bridge.player.state();
        if (!onPlayerRouteRef.current) {
          await bridge.player.stop();
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
  const reportPlaybackError = useCallback((cause: unknown): void => {
    setPlaybackError(errorMessage(cause, "The in-app player surface could not be prepared"));
  }, []);
  const queuePlayback = (item: IpcItem): void => {
    if (item.kind === "show" || item.kind === "season") {
      setSelectedItem(item);
      return;
    }
    setPlaybackError(null);
    setPlayingItem(item);
    setSelectedItem(null);
    if (!onPlayerRouteRef.current) returnTo.current = router.state.location.href;
    void navigate({ to: "/player" });
  };
  const accounts = accountsQuery.data?.accounts ?? [];
  const active =
    accounts.find((account) => account.connectionId === accountsQuery.data?.activeConnectionId) ??
    null;
  const playerUnavailable = player === null;
  useEffect(() => {
    const leavingPlayer = wasOnPlayerRoute.current && !onPlayerRoute;
    wasOnPlayerRoute.current = onPlayerRoute;
    if (!leavingPlayer) return;
    updatePlayer(null);
    setPlayingItem(null);
    setPlaybackLoading(false);
    setPlaybackError(null);
    // Home can mount while the playback session is still stopping.
    // Refresh once the stop request has finished.
    void bridge.player
      .stop()
      .catch(() => undefined)
      .then(() => {
        if (active !== null)
          return queryClient.invalidateQueries({
            queryKey: [active.connectionId, active.serverId, active.userId, "home"],
          });
      });
  }, [active, onPlayerRoute, queryClient, updatePlayer]);
  useEffect(() => {
    if (!onPlayerRoute) return;
    void bridge.player.display({
      title: playingItem?.title ?? "Now playing",
      context: `${active?.serverLabel ?? "Lumen"} · Original quality`,
      duration: playingItem?.durationMs == null ? null : Math.floor(playingItem.durationMs / 1_000),
      loading: playbackLoading,
      error: playerUnavailable ? playbackError : null,
    });
  }, [active, onPlayerRoute, playingItem, playerUnavailable, playbackLoading, playbackError]);
  useEffect(
    () =>
      bridge.player.onOverlayAction((action) => {
        // Leaving the player route stops playback and clears its state.
        if (action === "back" || action === "stop")
          void router.navigate({ href: returnTo.current, replace: true });
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
  if (accounts.length === 0 || active === null)
    return (
      <ConnectPage
        accounts={accounts}
        onChanged={() => {
          setConnectionsView(null);
          void queryClient.invalidateQueries({ queryKey: ["accounts"] });
        }}
      />
    );

  if (connectionsView !== null)
    return (
      <ConnectPage
        accounts={accounts}
        activeConnectionId={active.connectionId}
        initialShowAddServer={connectionsView === "add"}
        initialSignInAccount={signInAccount}
        onClose={() => {
          setSignInAccount(null);
          setConnectionsView(null);
        }}
        onChanged={() => {
          setSignInAccount(null);
          setConnectionsView(null);
          void queryClient.invalidateQueries({ queryKey: ["accounts"] });
        }}
      />
    );

  const scope = [active.connectionId, active.serverId, active.userId] as const;
  const workspace = {
    account: active,
    scope,
    openItem: setSelectedItem,
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
          <ItemDetails
            item={selectedItem}
            onClose={() => setSelectedItem(null)}
            onPlay={queuePlayback}
          />
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
