import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IpcAccount, IpcItem, IpcLibrary, IpcPlayerSession, IpcPlayerState, IpcServerDiscovery, User } from "@lumen/contracts";
import { AccountSwitcher, Button, MediaCard, PlayerBar, Shell, StatusState } from "@lumen/ui";
import { useEffect, useMemo, useState } from "react";

const bridge = window.lumen;
type View = "home" | "library" | "search" | "settings" | "admin";

const useAccounts = () => useQuery({ queryKey: ["accounts"], queryFn: () => bridge.accounts.list() });

export const App = (): React.ReactElement => {
  const accountsQuery = useAccounts();
  const [view, setView] = useState<View>("home");
  const [selectedItem, setSelectedItem] = useState<IpcItem | null>(null);
  const [player, setPlayer] = useState<IpcPlayerState | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => bridge.player.onState(setPlayer), []);
  const accounts = accountsQuery.data?.accounts ?? [];
  const active = accounts.find((account) => account.connectionId === accountsQuery.data?.activeConnectionId) ?? null;
  const scope = active === null ? null : [active.connectionId, active.serverId, active.userId] as const;

  if (accountsQuery.isLoading) return <StatusState title="Starting Lumen" message="Loading secure server connections." />;
  if (accountsQuery.isError) return <ConnectPage initialError="The connection registry could not be loaded." onChanged={() => void queryClient.invalidateQueries({ queryKey: ["accounts"] })} />;
  if (accounts.length === 0 || active === null) return <ConnectPage accounts={accounts} onChanged={() => void queryClient.invalidateQueries({ queryKey: ["accounts"] })} />;

  return (
    <Shell
      sidebar={<Sidebar view={view} setView={setView} accounts={accounts} activeId={active.connectionId} isAdmin={active.role === "admin"} onActivate={(id) => { void bridge.accounts.activate(id).then(() => queryClient.invalidateQueries()).catch(() => undefined); }} onRemove={(id) => { void bridge.accounts.remove(id).then(() => queryClient.invalidateQueries()).catch(() => undefined); }} />}
      player={player === null ? undefined : <PlayerBar title={selectedItem?.title ?? "Now playing"} server={`${active.serverLabel} · ${active.username}`} paused={player.paused} onPause={() => void bridge.player.pause(player.sessionId, !player.paused).then(setPlayer)} onStop={() => void bridge.player.stop().then(() => setPlayer(null))} position={player.positionSeconds} duration={player.durationSeconds} streams={player.streams} selectedAudioStreamId={player.selectedAudioStreamId} selectedSubtitleStreamId={player.selectedSubtitleStreamId} onSelectAudio={(streamId) => void bridge.player.selectAudio(player.sessionId, streamId).then(setPlayer)} onSelectSubtitle={(streamId) => void bridge.player.selectSubtitle(player.sessionId, streamId).then(setPlayer)} />}
    >
      {playbackError === null ? null : <p className="error-message" role="alert">{playbackError}</p>}
      {view === "home" ? <Home account={active} onOpen={setSelectedItem} onPlay={startPlayback} /> : null}
      {view === "library" ? <Library account={active} scope={scope ?? []} onOpen={setSelectedItem} onPlay={startPlayback} /> : null}
      {view === "search" ? <Search account={active} onOpen={setSelectedItem} onPlay={startPlayback} /> : null}
      {view === "settings" ? <Settings /> : null}
      {view === "admin" && active.role === "admin" ? <Admin account={active} scope={scope ?? []} /> : null}
      {selectedItem === null ? null : <ItemDetails item={selectedItem} onClose={() => setSelectedItem(null)} onPlay={startPlayback} />}
    </Shell>
  );

  async function startPlayback(item: IpcItem): Promise<void> {
    setPlaybackError(null);
    try {
      const result = await bridge.player.start(item.id) as IpcPlayerSession;
      setSelectedItem(item);
      setPlayer(await bridge.player.state());
      if (result.sessionId !== undefined) setView("home");
    } catch (cause) {
      setPlaybackError(cause instanceof Error && cause.message.trim() !== "" ? cause.message : "Playback could not start");
    }
  }
};

const Sidebar = ({ view, setView, accounts, activeId, isAdmin, onActivate, onRemove }: { readonly view: View; readonly setView: (view: View) => void; readonly accounts: ReadonlyArray<IpcAccount>; readonly activeId: string; readonly isAdmin: boolean; readonly onActivate: (id: string) => void; readonly onRemove: (id: string) => void }): React.ReactElement => (
  <>
    <div className="brand">LUMEN</div>
    <nav className="nav" aria-label="Primary navigation">
      {([["home", "Home"], ["library", "Library"], ["search", "Search"], ["settings", "Settings"], ...(isAdmin ? [["admin", "Administration"]] as const : [])]).map(([id, label]) => <button key={id} type="button" aria-current={view === id ? "page" : undefined} onClick={() => setView(id as View)}>{label}</button>)}
    </nav>
    <AccountSwitcher accounts={accounts} activeId={activeId} onActivate={onActivate} onRemove={onRemove} />
  </>
);

const ConnectPage = ({ accounts = [], initialError, onChanged }: { readonly accounts?: ReadonlyArray<IpcAccount>; readonly initialError?: string; readonly onChanged?: () => void }): React.ReactElement => {
  const [origin, setOrigin] = useState("http://127.0.0.1:3210");
  const [serverLabel, setServerLabel] = useState("Home server");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState<IpcServerDiscovery | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const discoverServer = useMutation({
    mutationFn: () => bridge.accounts.discoverServer(origin),
    onSuccess: (result) => {
      setServer(result);
      setError(null);
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Could not connect to server"),
  });
  const connect = useMutation({
    mutationFn: () => {
      if (server === null) throw new Error("Connect to a server first");
      return bridge.accounts.connect({ origin: server.origin, serverLabel, username, displayName: server.setupRequired ? displayName || username : undefined, password });
    },
    onSuccess: () => { setPassword(""); onChanged?.(); },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Could not sign in"),
  });
  const changeServer = (): void => {
    setServer(null);
    setUsername("");
    setDisplayName("");
    setPassword("");
    setError(null);
  };
  const activateAccount = (connectionId: string): void => {
    void bridge.accounts.activate(connectionId).then(() => onChanged?.()).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not activate account"));
  };
  const removeAccount = (connectionId: string): void => {
    void bridge.accounts.remove(connectionId).then(() => onChanged?.()).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not remove account"));
  };
  return <main className="login-panel"><div className="brand">LUMEN</div><p className="muted">Your media, your servers, direct playback.</p>{accounts.length > 0 ? <AccountSwitcher accounts={accounts} activeId={null} onActivate={activateAccount} onRemove={removeAccount} /> : null}{server === null ? <><p className="muted">Step 1 of 2 · Connect to your server</p><div className="field"><label htmlFor="server">Server address</label><input id="server" value={origin} onChange={(event) => { setOrigin(event.target.value); setError(null); }} /></div><div className="field"><label htmlFor="server-label">Server name</label><input id="server-label" value={serverLabel} onChange={(event) => setServerLabel(event.target.value)} /></div><Button variant="primary" disabled={discoverServer.isPending || origin.trim() === "" || serverLabel.trim() === ""} onClick={() => discoverServer.mutate()}>{discoverServer.isPending ? "Connecting…" : "Connect to server"}</Button></> : <><p className="muted">Step 2 of 2 · {server.setupRequired ? "Create the first account" : "Sign in"}</p><div className="field"><p className="muted">Connected server</p><p className="muted">{server.identity.displayName} · {server.origin}</p></div><div className="field"><label htmlFor="username">Username</label><input id="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></div>{server.setupRequired ? <div className="field"><label htmlFor="display-name">Display name</label><input id="display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></div> : null}<div className="field"><label htmlFor="password">Password</label><input id="password" type="password" autoComplete={server.setupRequired ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} /></div>{server.setupRequired ? <p className="muted">This server has no users. The first account becomes its administrator.</p> : null}<Button variant="ghost" onClick={changeServer}>Change server</Button><Button variant="primary" disabled={connect.isPending || username.trim() === "" || password === ""} onClick={() => connect.mutate()}>{connect.isPending ? "Connecting…" : server.setupRequired ? "Create administrator" : "Sign in"}</Button></>}{error === null ? null : <p className="error-message" role="alert">{error}</p>}</main>;
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

const Admin = ({ account, scope }: { readonly account: IpcAccount; readonly scope: readonly unknown[] }): React.ReactElement => {
  const users = useQuery({ queryKey: [...scope, "admin", "users"], queryFn: () => bridge.admin.listUsers() });
  const libraries = useQuery({ queryKey: [...scope, "admin", "libraries"], queryFn: () => bridge.admin.listLibraries() });
  return <><div className="content-header"><p className="muted">{account.username}</p><h1>Administration</h1></div>{users.isLoading || libraries.isLoading ? <StatusState title="Loading administration" message="Reading server settings." /> : null}{users.isError || libraries.isError ? <StatusState title="Administration unavailable" message="Only an administrator can edit users and libraries." /> : null}{users.data !== undefined && libraries.data !== undefined ? <div className="admin-grid"><AdminUsers users={users.data} scope={scope} /><AdminLibraries libraries={libraries.data} scope={scope} /></div> : null}</>;
};

const AdminUsers = ({ users, scope }: { readonly users: ReadonlyArray<User>; readonly scope: readonly unknown[] }): React.ReactElement => {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin" | "guest">("user");
  const create = useMutation({
    mutationFn: () => bridge.admin.createUser({ username, displayName, password, role }),
    onSuccess: async () => { setUsername(""); setDisplayName(""); setPassword(""); await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "users"] }); },
  });
  return <section className="admin-panel"><div className="content-header"><div><h2>Users</h2><p className="muted">Create accounts and change roles or access.</p></div></div>{create.isError ? <p className="error-message" role="alert">{create.error instanceof Error ? create.error.message : "Could not create user"}</p> : null}<form className="admin-form" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><div className="field"><label htmlFor="new-username">Username</label><input id="new-username" value={username} onChange={(event) => setUsername(event.target.value)} /></div><div className="field"><label htmlFor="new-display-name">Display name</label><input id="new-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></div><div className="field"><label htmlFor="new-password">Password</label><input id="new-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></div><div className="field"><label htmlFor="new-role">Role</label><select id="new-role" value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="user">User</option><option value="guest">Guest</option><option value="admin">Administrator</option></select></div><Button variant="primary" type="submit" disabled={create.isPending}>{create.isPending ? "Creating…" : "Create user"}</Button></form><div className="admin-list">{users.map((user) => <UserRow key={user.id} user={user} scope={scope} />)}</div></section>;
};

const UserRow = ({ user, scope }: { readonly user: User; readonly scope: readonly unknown[] }): React.ReactElement => {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [password, setPassword] = useState("");
  const [role, setRole] = useState(user.role);
  const [isActive, setIsActive] = useState(user.isActive);
  const update = useMutation({
    mutationFn: () => bridge.admin.updateUser({ userId: user.id, displayName, password: password === "" ? undefined : password, role, isActive }),
    onSuccess: async () => { setPassword(""); await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "users"] }); },
  });
  return <div className="admin-row"><div className="field"><label htmlFor={`user-name-${user.id}`}>Name</label><input id={`user-name-${user.id}`} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></div><div className="field"><label htmlFor={`user-role-${user.id}`}>Role</label><select id={`user-role-${user.id}`} value={role} onChange={(event) => setRole(event.target.value as User["role"])}><option value="user">User</option><option value="guest">Guest</option><option value="admin">Administrator</option></select></div><div className="field"><label htmlFor={`user-password-${user.id}`}>New password</label><input id={`user-password-${user.id}`} type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></div><label className="checkbox-field"><input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} /> Active</label><Button disabled={update.isPending} onClick={() => update.mutate()}>{update.isPending ? "Saving…" : "Save"}</Button></div>;
};

const AdminLibraries = ({ libraries, scope }: { readonly libraries: ReadonlyArray<IpcLibrary>; readonly scope: readonly unknown[] }): React.ReactElement => {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [kind, setKind] = useState<"movies" | "shows" | "music">("movies");
  const create = useMutation({
    mutationFn: () => bridge.admin.createLibrary({ id: crypto.randomUUID(), name, slug, kind }),
    onSuccess: async () => { setName(""); setSlug(""); await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "libraries"] }); },
  });
  return <section className="admin-panel"><div className="content-header"><div><h2>Libraries</h2><p className="muted">Edit library details and filesystem roots.</p></div></div><form className="admin-form" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><div className="field"><label htmlFor="new-library-name">Name</label><input id="new-library-name" value={name} onChange={(event) => setName(event.target.value)} /></div><div className="field"><label htmlFor="new-library-slug">Slug</label><input id="new-library-slug" value={slug} onChange={(event) => setSlug(event.target.value)} /></div><div className="field"><label htmlFor="new-library-kind">Type</label><select id="new-library-kind" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="movies">Movies</option><option value="shows">Shows</option><option value="music">Music</option></select></div><Button variant="primary" type="submit" disabled={create.isPending}>{create.isPending ? "Creating…" : "Create library"}</Button></form><div className="admin-list">{libraries.map((library) => <LibraryRow key={library.id} library={library} scope={scope} />)}</div></section>;
};

const LibraryRow = ({ library, scope }: { readonly library: IpcLibrary; readonly scope: readonly unknown[] }): React.ReactElement => {
  const queryClient = useQueryClient();
  const [name, setName] = useState(library.name);
  const [slug, setSlug] = useState(library.slug);
  const [kind, setKind] = useState(library.kind);
  const [isEnabled, setIsEnabled] = useState(library.isEnabled);
  const [rootPath, setRootPath] = useState("");
  const roots = useQuery({ queryKey: [...scope, "admin", "roots", library.id], queryFn: () => bridge.admin.listRoots(library.id) });
  const update = useMutation({
    mutationFn: () => bridge.admin.updateLibrary({ libraryId: library.id, name, slug, kind, isEnabled }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "libraries"] }); },
  });
  const addRoot = useMutation({
    mutationFn: () => bridge.admin.addRoot({ id: crypto.randomUUID(), libraryId: library.id, path: rootPath, priority: roots.data?.length ?? 0 }),
    onSuccess: async () => { setRootPath(""); await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "roots", library.id] }); },
  });
  const scan = useMutation({
    mutationFn: async () => {
      const { runId } = await bridge.admin.startScan({ libraryId: library.id, mode: "full" });
      while (true) {
        const run = await bridge.admin.scanStatus(runId);
        if (run.status === "succeeded") return;
        if (run.status === "failed" || run.status === "cancelled") throw new Error(run.errorMessage ?? "Library scan failed");
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: [...scope, "items", library.id] }); },
  });
  const remove = useMutation({ mutationFn: () => bridge.admin.deleteLibrary(library.id), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "libraries"] }); } });
  return <div className="library-admin-row"><div className="admin-row"><div className="field"><label htmlFor={`library-name-${library.id}`}>Name</label><input id={`library-name-${library.id}`} value={name} onChange={(event) => setName(event.target.value)} /></div><div className="field"><label htmlFor={`library-slug-${library.id}`}>Slug</label><input id={`library-slug-${library.id}`} value={slug} onChange={(event) => setSlug(event.target.value)} /></div><div className="field"><label htmlFor={`library-kind-${library.id}`}>Type</label><select id={`library-kind-${library.id}`} value={kind} onChange={(event) => setKind(event.target.value as IpcLibrary["kind"])}><option value="movies">Movies</option><option value="shows">Shows</option><option value="music">Music</option></select></div><label className="checkbox-field"><input type="checkbox" checked={isEnabled} onChange={(event) => setIsEnabled(event.target.checked)} /> Enabled</label><Button disabled={update.isPending || remove.isPending} onClick={() => update.mutate()}>{update.isPending ? "Saving…" : "Save"}</Button><Button variant="ghost" disabled={remove.isPending || scan.isPending} onClick={() => remove.mutate()}>Delete</Button><Button variant="ghost" disabled={scan.isPending || roots.isLoading || (roots.data?.length ?? 0) === 0} onClick={() => scan.mutate()}>{scan.isPending ? "Scanning…" : "Scan library"}</Button></div><div className="root-editor"><h3>Roots</h3>{scan.isError ? <p className="error-message" role="alert">{scan.error instanceof Error ? scan.error.message : "Could not scan library"}</p> : null}{roots.data?.length === 0 ? <p className="muted">No roots configured.</p> : roots.data?.map((value) => { const root = value as { id: string; path: string }; return <div className="root-row" key={root.id}><code>{root.path}</code><Button variant="ghost" onClick={() => void bridge.admin.deleteRoot(root.id).then(() => queryClient.invalidateQueries({ queryKey: [...scope, "admin", "roots", library.id] }))}>Remove</Button></div>; })}<form className="root-form" onSubmit={(event) => { event.preventDefault(); addRoot.mutate(); }}><label htmlFor={`root-${library.id}`}>Filesystem path</label><input id={`root-${library.id}`} value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="/media/movies" /><Button disabled={addRoot.isPending || rootPath.trim() === ""} type="submit">{addRoot.isPending ? "Adding…" : "Add root"}</Button></form></div></div>;
};
