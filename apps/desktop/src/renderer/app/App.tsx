import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IpcAccount, IpcItem, IpcPlayerSession, IpcPlayerState } from "@lumen/contracts";
import { AccountSwitcher, Button, MediaCard, PlayerBar, Shell, StatusState } from "@lumen/ui";
import { useEffect, useMemo, useState } from "react";

const bridge = window.lumen;
type View = "home" | "library" | "search" | "settings" | "admin";

const deviceId = (): string => {
  const key = "lumen-device-id";
  const existing = window.localStorage.getItem(key);
  if (existing !== null) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem(key, created);
  return created;
};

const useAccounts = () => useQuery({ queryKey: ["accounts"], queryFn: () => bridge.accounts.list() });

export const App = (): React.ReactElement => {
  const accountsQuery = useAccounts();
  const [view, setView] = useState<View>("home");
  const [selectedItem, setSelectedItem] = useState<IpcItem | null>(null);
  const [player, setPlayer] = useState<IpcPlayerState | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => bridge.player.onState(setPlayer), []);
  const accounts = accountsQuery.data?.accounts ?? [];
  const active = accounts.find((account) => account.connectionId === accountsQuery.data?.activeConnectionId) ?? null;
  const scope = active === null ? null : [active.connectionId, active.serverId, active.userId] as const;

  if (accountsQuery.isLoading) return <StatusState title="Starting Lumen" message="Loading secure server connections." />;
  if (accountsQuery.isError) return <ConnectPage initialError="The connection registry could not be loaded." />;
  if (accounts.length === 0 || active === null) return <ConnectPage accounts={accounts} onChanged={() => void queryClient.invalidateQueries({ queryKey: ["accounts"] })} />;

  return (
    <Shell
      sidebar={<Sidebar view={view} setView={setView} accounts={accounts} activeId={active.connectionId} onActivate={(id) => { void bridge.accounts.activate(id).then(() => queryClient.invalidateQueries()); }} />}
      player={player === null ? undefined : <PlayerBar title={selectedItem?.title ?? "Now playing"} server={`${active.serverLabel} · ${active.username}`} paused={player.paused} onPause={() => void bridge.player.pause(player.sessionId, !player.paused).then(setPlayer)} onStop={() => void bridge.player.stop().then(() => setPlayer(null))} position={player.positionSeconds} duration={player.durationSeconds} />}
    >
      {view === "home" ? <Home account={active} onOpen={setSelectedItem} onPlay={startPlayback} /> : null}
      {view === "library" ? <Library account={active} scope={scope ?? []} onOpen={setSelectedItem} onPlay={startPlayback} /> : null}
      {view === "search" ? <Search account={active} onOpen={setSelectedItem} onPlay={startPlayback} /> : null}
      {view === "settings" ? <Settings /> : null}
      {view === "admin" ? <Admin account={active} /> : null}
      {selectedItem === null ? null : <ItemDetails item={selectedItem} onClose={() => setSelectedItem(null)} onPlay={startPlayback} />}
    </Shell>
  );

  async function startPlayback(item: IpcItem): Promise<void> {
    const result = await bridge.player.start(item.id, deviceId()) as IpcPlayerSession;
    setSelectedItem(item);
    setPlayer(await bridge.player.state());
    if (result.sessionId !== undefined) setView("home");
  }
};

const Sidebar = ({ view, setView, accounts, activeId, onActivate }: { readonly view: View; readonly setView: (view: View) => void; readonly accounts: ReadonlyArray<IpcAccount>; readonly activeId: string; readonly onActivate: (id: string) => void }): React.ReactElement => (
  <>
    <div className="brand">LUMEN</div>
    <nav className="nav" aria-label="Primary navigation">
      {([["home", "Home"], ["library", "Library"], ["search", "Search"], ["settings", "Settings"], ["admin", "Administration"]] as const).map(([id, label]) => <button key={id} type="button" aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>{label}</button>)}
    </nav>
    <AccountSwitcher accounts={accounts} activeId={activeId} onActivate={onActivate} onRemove={(id) => void window.lumen.accounts.remove(id)} />
  </>
);

const ConnectPage = ({ accounts = [], initialError, onChanged }: { readonly accounts?: ReadonlyArray<IpcAccount>; readonly initialError?: string; readonly onChanged?: () => void }): React.ReactElement => {
  const [origin, setOrigin] = useState("http://127.0.0.1:3210");
  const [serverLabel, setServerLabel] = useState("Home server");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError ?? null);
  const connect = useMutation({
    mutationFn: () => bridge.accounts.connect({ origin, serverLabel, username, password }),
    onSuccess: () => { setPassword(""); onChanged?.(); },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Connection failed"),
  });
  return <main className="login-panel"><div className="brand">LUMEN</div><p className="muted">Your media, your servers, direct playback.</p>{accounts.length > 0 ? <AccountSwitcher accounts={accounts} activeId={null} onActivate={(id) => void bridge.accounts.activate(id)} onRemove={(id) => void bridge.accounts.remove(id)} /> : null}<div className="field"><label htmlFor="server">Server address</label><input id="server" value={origin} onChange={(event) => setOrigin(event.target.value)} /></div><div className="field"><label htmlFor="server-label">Server name</label><input id="server-label" value={serverLabel} onChange={(event) => setServerLabel(event.target.value)} /></div><div className="field"><label htmlFor="username">Username</label><input id="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></div><div className="field"><label htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></div>{error === null ? null : <p className="error-message" role="alert">{error}</p>}<Button variant="primary" disabled={connect.isPending} onClick={() => connect.mutate()}>{connect.isPending ? "Connecting…" : "Connect securely"}</Button></main>;
};

const Home = ({ account, onOpen, onPlay }: { readonly account: IpcAccount; readonly onOpen: (item: IpcItem) => void; readonly onPlay: (item: IpcItem) => void }): React.ReactElement => <><div className="content-header"><div><p className="muted">Connected to {account.serverLabel}</p><h1>Continue watching</h1></div></div><Library account={account} scope={[account.connectionId, account.serverId, account.userId]} onOpen={onOpen} onPlay={onPlay} /></>;

const Library = ({ account, scope, onOpen, onPlay }: { readonly account: IpcAccount; readonly scope: readonly unknown[]; readonly onOpen: (item: IpcItem) => void; readonly onPlay: (item: IpcItem) => void }): React.ReactElement => {
  const libraries = useQuery({ queryKey: [...scope, "libraries"], queryFn: () => bridge.library.list() });
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const activeLibrary = libraryId ?? libraries.data?.[0]?.id ?? null;
  const items = useQuery({ queryKey: [...scope, "items", activeLibrary], queryFn: async () => activeLibrary === null ? { items: [], nextCursor: null } : bridge.library.items(activeLibrary), enabled: activeLibrary !== null });
  if (libraries.isLoading || items.isLoading) return <StatusState title="Loading library" message="Reading your authorized catalog." />;
  if (libraries.isError || items.isError) return <StatusState title="Library unavailable" message="Check the server connection or permissions." />;
  return <><div className="content-header"><div><p className="muted">{account.serverLabel} · {account.username}</p><h1>Library</h1></div><select aria-label="Library" value={activeLibrary ?? ""} onChange={(event) => setLibraryId(event.target.value)}>{libraries.data?.map((library) => <option key={library.id} value={library.id}>{library.name}</option>)}</select></div>{items.data?.items.length === 0 ? <div className="empty-state">This library is empty. Add a server folder and start a scan from Administration.</div> : <div className="media-grid">{items.data?.items.map((item) => <MediaCard key={item.id} title={item.title} subtitle={item.year === null ? item.kind : `${item.year} · ${item.kind}`} onOpen={() => onOpen(item)} onPlay={() => onPlay(item)} />)}</div>}</>;
};

const Search = ({ account, onOpen, onPlay }: { readonly account: IpcAccount; readonly onOpen: (item: IpcItem) => void; readonly onPlay: (item: IpcItem) => void }): React.ReactElement => {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const results = useQuery({ queryKey: [account.connectionId, account.serverId, account.userId, "search", submitted], queryFn: () => bridge.library.search(submitted), enabled: submitted !== "" });
  const items = useMemo(() => extractItems(results.data), [results.data]);
  return <><div className="content-header"><div><p className="muted">Authorized search</p><h1>Search</h1></div><form onSubmit={(event) => { event.preventDefault(); setSubmitted(query.trim()); }}><label className="sr-only" htmlFor="search">Search your libraries</label><input id="search" className="search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search movies, shows, music" /></form></div>{submitted === "" ? <div className="empty-state">Search titles, artists, albums, and tracks.</div> : results.isFetching ? <StatusState title="Searching" message="Looking through your authorized catalog." /> : items.length === 0 ? <div className="empty-state">No authorized results for “{submitted}”.</div> : <div className="media-grid">{items.map((item) => <MediaCard key={item.id} title={item.title} subtitle={item.kind} onOpen={() => onOpen(item)} onPlay={() => onPlay(item)} />)}</div>}</>;
};

const extractItems = (value: unknown): ReadonlyArray<IpcItem> => {
  if (typeof value !== "object" || value === null || !("items" in value) || !Array.isArray(value.items)) return [];
  return value.items.filter((item): item is IpcItem => typeof item === "object" && item !== null && typeof item.id === "string" && typeof item.title === "string" && typeof item.libraryId === "string" && typeof item.kind === "string");
};

const ItemDetails = ({ item, onClose, onPlay }: { readonly item: IpcItem; readonly onClose: () => void; readonly onPlay: (item: IpcItem) => void }): React.ReactElement => <section className="login-panel" aria-label="Media details"><button className="button button-ghost" type="button" onClick={onClose}>Close</button><p className="muted">Original · Direct Play</p><h1>{item.title}</h1><p>{item.year === null ? "" : item.year} · {item.kind}</p>{item.resumePositionSeconds === null ? null : <p>Resume at {Math.floor(item.resumePositionSeconds / 60)}:{String(item.resumePositionSeconds % 60).padStart(2, "0")}</p>}<Button variant="primary" onClick={() => onPlay(item)}>{item.resumePositionSeconds === null || item.resumePositionSeconds === 0 ? "Play" : "Resume"}</Button></section>;

const Settings = (): React.ReactElement => <><div className="content-header"><h1>Settings</h1></div><div className="status-state"><h2>Playback preferences</h2><p>MPV handles decoding, subtitles, scaling, and audio output locally. The server never transcodes media.</p></div></>;

const Admin = ({ account }: { readonly account: IpcAccount }): React.ReactElement => <><div className="content-header"><p className="muted">{account.username}</p><h1>Administration</h1></div><div className="status-state"><h2>Server controls</h2><p>Use the server CLI to bootstrap administrators. Library roots, scans, users, grants, sessions, and diagnostics are available through the authenticated API.</p></div></>;
