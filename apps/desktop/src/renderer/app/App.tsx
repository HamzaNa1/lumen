import type {
  IpcAccount,
  IpcItem,
  IpcLibrary,
  IpcPlayerSession,
  IpcPlayerState,
  IpcServerDiscovery,
  User,
} from "@lumen/contracts";
import {
  AccountSwitcher,
  Button,
  CheckboxField,
  Form,
  MediaCard,
  Modal,
  PlayerBar,
  SelectField,
  Shell,
  StatusState,
  TextField,
} from "@lumen/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowRight,
  Film,
  Folder,
  Home,
  LibraryBig,
  MonitorPlay,
  Play,
  Plus,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Shield,
  Sparkles,
  Users,
} from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

const bridge = window.lumen;
const roleOptions = [
  { value: "user", label: "User" },
  { value: "guest", label: "Guest" },
  { value: "admin", label: "Administrator" },
] as const;
const libraryKindOptions = [
  { value: "movies", label: "Movies" },
  { value: "shows", label: "TV shows" },
  { value: "music", label: "Music" },
] as const;

interface WorkspaceValue {
  readonly account: IpcAccount;
  readonly scope: readonly unknown[];
  readonly openItem: (item: IpcItem) => void;
  readonly playItem: (item: IpcItem) => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);
const useWorkspace = (): WorkspaceValue => {
  const value = useContext(WorkspaceContext);
  if (value === null) throw new Error("Workspace is unavailable without an active account");
  return value;
};

const useAccounts = () =>
  useQuery({ queryKey: ["accounts"], queryFn: () => bridge.accounts.list() });

export const App = (): React.ReactElement => {
  const accountsQuery = useAccounts();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [selectedItem, setSelectedItem] = useState<IpcItem | null>(null);
  const [playingTitle, setPlayingTitle] = useState("Now playing");
  const [player, setPlayer] = useState<IpcPlayerState | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  useEffect(() => bridge.player.onState(setPlayer), []);
  const accounts = accountsQuery.data?.accounts ?? [];
  const active =
    accounts.find((account) => account.connectionId === accountsQuery.data?.activeConnectionId) ??
    null;

  if (accountsQuery.isLoading)
    return (
      <div className="centered-page">
        <StatusState loading title="Starting Lumen" message="Loading your secure connections." />
      </div>
    );
  if (accountsQuery.isError)
    return (
      <ConnectPage
        initialError="The connection registry could not be loaded."
        onChanged={() => void queryClient.invalidateQueries({ queryKey: ["accounts"] })}
      />
    );
  if (accounts.length === 0 || active === null)
    return (
      <ConnectPage
        accounts={accounts}
        onChanged={() => void queryClient.invalidateQueries({ queryKey: ["accounts"] })}
      />
    );

  const scope = [active.connectionId, active.serverId, active.userId] as const;
  const startPlayback = async (item: IpcItem): Promise<void> => {
    setPlaybackError(null);
    try {
      const result = (await bridge.player.start(item.id)) as IpcPlayerSession;
      setPlayingTitle(item.title);
      setSelectedItem(null);
      setPlayer(await bridge.player.state());
      if (result.sessionId !== undefined) void navigate({ to: "/" });
    } catch (cause) {
      setPlaybackError(
        cause instanceof Error && cause.message.trim() !== ""
          ? cause.message
          : "Playback could not start",
      );
    }
  };
  const workspace = {
    account: active,
    scope,
    openItem: setSelectedItem,
    playItem: (item: IpcItem) => void startPlayback(item),
  } satisfies WorkspaceValue;

  return (
    <WorkspaceContext.Provider value={workspace}>
      <Shell
        sidebar={
          <Sidebar
            account={active}
            accounts={accounts}
            onActivate={(id) => {
              void bridge.accounts
                .activate(id)
                .then(() => queryClient.invalidateQueries())
                .catch(() => undefined);
            }}
            onRemove={(id) => {
              void bridge.accounts
                .remove(id)
                .then(() => queryClient.invalidateQueries())
                .catch(() => undefined);
            }}
          />
        }
        player={
          player === null ? undefined : (
            <PlayerBar
              title={playingTitle}
              server={`${active.serverLabel} · ${active.username}`}
              paused={player.paused}
              onPause={() =>
                void bridge.player.pause(player.sessionId, !player.paused).then(setPlayer)
              }
              onStop={() => void bridge.player.stop().then(() => setPlayer(null))}
              position={player.positionSeconds}
              duration={player.durationSeconds}
              streams={player.streams}
              selectedAudioStreamId={player.selectedAudioStreamId}
              selectedSubtitleStreamId={player.selectedSubtitleStreamId}
              onSelectAudio={(streamId) =>
                void bridge.player.selectAudio(player.sessionId, streamId).then(setPlayer)
              }
              onSelectSubtitle={(streamId) =>
                void bridge.player.selectSubtitle(player.sessionId, streamId).then(setPlayer)
              }
            />
          )
        }
      >
        {playbackError === null ? null : (
          <div className="toast error-toast" role="alert">
            <AlertCircle aria-hidden="true" size={18} />
            <span>{playbackError}</span>
            <Button variant="ghost" onClick={() => setPlaybackError(null)}>
              Dismiss
            </Button>
          </div>
        )}
        <Outlet />
        <ItemDetails
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
          onPlay={(item) => void startPlayback(item)}
        />
      </Shell>
    </WorkspaceContext.Provider>
  );
};

const Sidebar = ({
  account,
  accounts,
  onActivate,
  onRemove,
}: {
  readonly account: IpcAccount;
  readonly accounts: ReadonlyArray<IpcAccount>;
  readonly onActivate: (id: string) => void;
  readonly onRemove: (id: string) => void;
}): React.ReactElement => {
  const links = [
    { to: "/" as const, label: "Home", icon: Home, exact: true },
    { to: "/library" as const, label: "Library", icon: LibraryBig },
    { to: "/search" as const, label: "Search", icon: SearchIcon },
    { to: "/settings" as const, label: "Settings", icon: SettingsIcon },
    ...(account.role === "admin"
      ? [{ to: "/admin" as const, label: "Administration", icon: Shield }]
      : []),
  ];
  return (
    <>
      <div className="brand">
        <span className="brand-mark">
          <Play aria-hidden="true" size={17} fill="currentColor" />
        </span>
        <span>Lumen</span>
      </div>
      <nav className="nav" aria-label="Primary navigation">
        <span className="nav-label">Browse</span>
        {links.map(({ to, label, icon: Icon, exact }) => (
          <Link key={to} to={to} activeOptions={{ exact }}>
            <Icon aria-hidden="true" size={18} />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
      <div className="sidebar-spacer" />
      <div className="profile-card">
        <span className="avatar">{account.username.slice(0, 1).toUpperCase()}</span>
        <div>
          <strong>{account.username}</strong>
          <span>{account.role}</span>
        </div>
      </div>
      <AccountSwitcher
        accounts={accounts}
        activeId={account.connectionId}
        onActivate={onActivate}
        onRemove={onRemove}
      />
    </>
  );
};

const ConnectPage = ({
  accounts = [],
  initialError,
  onChanged,
}: {
  readonly accounts?: ReadonlyArray<IpcAccount>;
  readonly initialError?: string;
  readonly onChanged?: () => void;
}): React.ReactElement => {
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
    onError: (cause) => setError(errorMessage(cause, "Could not connect to server")),
  });
  const connect = useMutation({
    mutationFn: () => {
      if (server === null) throw new Error("Connect to a server first");
      return bridge.accounts.connect({
        origin: server.origin,
        serverLabel,
        username,
        displayName: server.setupRequired ? displayName || username : undefined,
        password,
      });
    },
    onSuccess: () => {
      setPassword("");
      onChanged?.();
    },
    onError: (cause) => setError(errorMessage(cause, "Could not sign in")),
  });
  const changeServer = (): void => {
    setServer(null);
    setUsername("");
    setDisplayName("");
    setPassword("");
    setError(null);
  };
  const activateAccount = (connectionId: string): void => {
    void bridge.accounts
      .activate(connectionId)
      .then(() => onChanged?.())
      .catch((cause) => setError(errorMessage(cause, "Could not activate account")));
  };
  const removeAccount = (connectionId: string): void => {
    void bridge.accounts
      .remove(connectionId)
      .then(() => onChanged?.())
      .catch((cause) => setError(errorMessage(cause, "Could not remove account")));
  };

  return (
    <main className="connect-page">
      <section className="connect-hero">
        <div className="brand brand-large">
          <span className="brand-mark">
            <Play aria-hidden="true" size={20} fill="currentColor" />
          </span>
          <span>Lumen</span>
        </div>
        <div>
          <span className="eyebrow">
            <Sparkles aria-hidden="true" size={14} />
            Your personal cinema
          </span>
          <h1>
            Everything you love.
            <br />
            Right where it belongs.
          </h1>
          <p>
            Connect to your media server and enjoy your original files with uncompromised direct
            playback.
          </p>
        </div>
        <div className="feature-list">
          <span>
            <MonitorPlay aria-hidden="true" />
            Direct play, always
          </span>
          <span>
            <Shield aria-hidden="true" />
            Private by design
          </span>
          <span>
            <Folder aria-hidden="true" />
            Your library, organized
          </span>
        </div>
      </section>
      <section className="connect-card">
        <div className="step-indicator">
          <span className="active">1</span>
          <i />
          <span className={server === null ? "" : "active"}>2</span>
        </div>
        <div className="connect-heading">
          <span className="eyebrow">{server === null ? "Get started" : "Almost there"}</span>
          <h2>
            {server === null
              ? "Connect your server"
              : server.setupRequired
                ? "Create administrator"
                : "Welcome back"}
          </h2>
          <p>
            {server === null
              ? "Enter the address of a Lumen server on your network."
              : `Connected to ${server.identity.displayName}`}
          </p>
        </div>
        {accounts.length === 0 ? null : (
          <div className="saved-connections">
            <span className="section-kicker">Saved connections</span>
            <AccountSwitcher
              accounts={accounts}
              activeId={null}
              onActivate={activateAccount}
              onRemove={removeAccount}
            />
          </div>
        )}
        {server === null ? (
          <Form
            className="connect-form"
            onSubmit={(event) => {
              event.preventDefault();
              discoverServer.mutate();
            }}
          >
            <TextField
              label="Server address"
              value={origin}
              onValueChange={(value) => {
                setOrigin(value);
                setError(null);
              }}
              placeholder="http://192.168.1.10:3210"
            />
            <TextField
              label="Server name"
              value={serverLabel}
              onValueChange={setServerLabel}
              placeholder="Living room"
            />
            <Button
              className="button-wide"
              variant="primary"
              type="submit"
              disabled={
                discoverServer.isPending || origin.trim() === "" || serverLabel.trim() === ""
              }
            >
              {discoverServer.isPending ? (
                "Connecting…"
              ) : (
                <>
                  Continue <ArrowRight aria-hidden="true" size={17} />
                </>
              )}
            </Button>
          </Form>
        ) : (
          <Form
            className="connect-form"
            onSubmit={(event) => {
              event.preventDefault();
              connect.mutate();
            }}
          >
            <div className="server-pill">
              <span className="server-dot" />
              <span>{server.origin}</span>
            </div>
            <TextField
              label="Username"
              autoComplete="username"
              value={username}
              onValueChange={setUsername}
            />
            {server.setupRequired ? (
              <TextField
                label="Display name"
                value={displayName}
                onValueChange={setDisplayName}
                description="This is how your name appears in Lumen."
              />
            ) : null}
            <TextField
              label="Password"
              type="password"
              autoComplete={server.setupRequired ? "new-password" : "current-password"}
              value={password}
              onValueChange={setPassword}
            />
            <div className="form-actions">
              <Button variant="ghost" onClick={changeServer}>
                Back
              </Button>
              <Button
                variant="primary"
                type="submit"
                disabled={connect.isPending || username.trim() === "" || password === ""}
              >
                {connect.isPending
                  ? "Signing in…"
                  : server.setupRequired
                    ? "Create account"
                    : "Sign in"}
              </Button>
            </div>
          </Form>
        )}
        {error === null ? null : (
          <p className="error-message" role="alert">
            <AlertCircle aria-hidden="true" size={16} />
            {error}
          </p>
        )}
      </section>
    </main>
  );
};

export const HomePage = (): React.ReactElement => {
  const { account, scope, openItem, playItem } = useWorkspace();
  return (
    <div className="page">
      <header className="hero">
        <div>
          <span className="eyebrow">{account.serverLabel} · Direct play</span>
          <h1>
            Welcome back, <span>{account.username}</span>
          </h1>
          <p>Your collection is ready when you are.</p>
        </div>
        <div className="hero-art">
          <Film aria-hidden="true" size={54} />
          <span>Original quality</span>
        </div>
      </header>
      <LibraryCollection
        account={account}
        scope={scope}
        onOpen={openItem}
        onPlay={playItem}
        compact
      />
    </div>
  );
};

export const LibraryPage = (): React.ReactElement => {
  const { account, scope, openItem, playItem } = useWorkspace();
  return (
    <div className="page">
      <PageHeader
        eyebrow={`${account.serverLabel} · ${account.username}`}
        title="Your library"
        description="Browse every title available to this account."
      />
      <LibraryCollection account={account} scope={scope} onOpen={openItem} onPlay={playItem} />
    </div>
  );
};

const LibraryCollection = ({
  account,
  scope,
  onOpen,
  onPlay,
  compact = false,
}: {
  readonly account: IpcAccount;
  readonly scope: readonly unknown[];
  readonly onOpen: (item: IpcItem) => void;
  readonly onPlay: (item: IpcItem) => void;
  readonly compact?: boolean;
}): React.ReactElement => {
  const libraries = useQuery({
    queryKey: [...scope, "libraries"],
    queryFn: () => bridge.library.list(),
  });
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const activeLibrary = libraryId ?? libraries.data?.[0]?.id ?? null;
  const items = useQuery({
    queryKey: [...scope, "items", activeLibrary],
    queryFn: async () =>
      activeLibrary === null
        ? { items: [], nextCursor: null }
        : bridge.library.items(activeLibrary),
    enabled: activeLibrary !== null,
  });
  if (libraries.isLoading || items.isLoading)
    return (
      <StatusState loading title="Loading library" message="Reading your authorized catalog." />
    );
  if (libraries.isError || items.isError)
    return (
      <StatusState
        title="Library unavailable"
        message="Check the server connection or your permissions."
      />
    );
  const options = (libraries.data ?? []).map((library) => ({
    value: library.id,
    label: library.name,
  }));
  return (
    <section className="collection-section">
      <div className="section-header">
        <div>
          <span className="section-kicker">
            {compact ? "Pick up where you left off" : `${items.data?.items.length ?? 0} titles`}
          </span>
          <h2>{compact ? "Recently added" : "All titles"}</h2>
        </div>
        {options.length > 0 ? (
          <SelectField
            hideLabel
            label="Library"
            value={activeLibrary}
            options={options}
            onValueChange={setLibraryId}
          />
        ) : null}
      </div>
      {items.data?.items.length === 0 ? (
        <EmptyState
          icon={LibraryBig}
          title="This library is waiting for media"
          message={
            account.role === "admin"
              ? "Add a filesystem root and start a scan from Administration."
              : "Ask your administrator to add media or grant access."
          }
        />
      ) : (
        <div className="media-grid">
          {items.data?.items.map((item) => (
            <MediaCard
              key={item.id}
              title={item.title}
              subtitle={
                item.year === null ? titleCase(item.kind) : `${item.year} · ${titleCase(item.kind)}`
              }
              onOpen={() => onOpen(item)}
              onPlay={() => onPlay(item)}
            />
          ))}
        </div>
      )}
    </section>
  );
};

export const SearchPage = (): React.ReactElement => {
  const { account, openItem, playItem } = useWorkspace();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const results = useQuery({
    queryKey: [account.connectionId, account.serverId, account.userId, "search", submitted],
    queryFn: () => bridge.library.search(submitted),
    enabled: submitted !== "",
  });
  const items = useMemo(() => extractItems(results.data), [results.data]);
  return (
    <div className="page search-page">
      <PageHeader
        eyebrow="Across every library"
        title="Find something to watch"
        description="Search titles, artists, albums, and tracks."
      />
      <Form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <SearchIcon aria-hidden="true" size={20} />
        <TextField
          hideLabel
          label="Search your libraries"
          value={query}
          onValueChange={setQuery}
          placeholder="Search your collection…"
          autoFocus
        />
        <Button variant="primary" type="submit" disabled={query.trim() === ""}>
          Search
        </Button>
      </Form>
      {submitted === "" ? (
        <EmptyState
          icon={SearchIcon}
          title="What are you in the mood for?"
          message="Try a movie title, an artist, or an album."
        />
      ) : results.isFetching ? (
        <StatusState loading title="Searching" message="Looking through your authorized catalog." />
      ) : items.length === 0 ? (
        <EmptyState
          icon={SearchIcon}
          title={`No results for “${submitted}”`}
          message="Check the spelling or try a broader search."
        />
      ) : (
        <>
          <div className="results-count">
            {items.length} {items.length === 1 ? "result" : "results"}
          </div>
          <div className="media-grid">
            {items.map((item) => (
              <MediaCard
                key={item.id}
                title={item.title}
                subtitle={titleCase(item.kind)}
                onOpen={() => openItem(item)}
                onPlay={() => playItem(item)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export const SettingsPage = (): React.ReactElement => {
  const { account } = useWorkspace();
  return (
    <div className="page">
      <PageHeader
        eyebrow="Preferences"
        title="Settings"
        description="Your playback and connection details at a glance."
      />
      <div className="settings-grid">
        <InfoCard
          icon={MonitorPlay}
          title="Playback"
          rows={[
            ["Engine", "MPV"],
            ["Quality", "Original"],
            ["Transcoding", "Never"],
          ]}
        />
        <InfoCard
          icon={Shield}
          title="Connection"
          rows={[
            ["Server", account.serverLabel],
            ["Account", account.username],
            ["Role", titleCase(account.role)],
          ]}
        />
      </div>
    </div>
  );
};

export const AdminPage = (): React.ReactElement => {
  const { account, scope } = useWorkspace();
  const users = useQuery({
    queryKey: [...scope, "admin", "users"],
    queryFn: () => bridge.admin.listUsers(),
    enabled: account.role === "admin",
  });
  const libraries = useQuery({
    queryKey: [...scope, "admin", "libraries"],
    queryFn: () => bridge.admin.listLibraries(),
    enabled: account.role === "admin",
  });
  if (account.role !== "admin")
    return (
      <div className="page">
        <EmptyState
          icon={Shield}
          title="Administrator access required"
          message="This area is only available to server administrators."
        />
      </div>
    );
  return (
    <div className="page">
      <PageHeader
        eyebrow={`${account.serverLabel} · Server controls`}
        title="Administration"
        description="Manage who can connect and what appears in Lumen."
      />
      {users.isLoading || libraries.isLoading ? (
        <StatusState loading title="Loading administration" message="Reading server settings." />
      ) : null}
      {users.isError || libraries.isError ? (
        <StatusState
          title="Administration unavailable"
          message="The server settings could not be loaded."
        />
      ) : null}
      {users.data !== undefined && libraries.data !== undefined ? (
        <div className="admin-grid">
          <AdminUsers users={users.data} scope={scope} />
          <AdminLibraries libraries={libraries.data} scope={scope} />
        </div>
      ) : null}
    </div>
  );
};

const ItemDetails = ({
  item,
  onClose,
  onPlay,
}: {
  readonly item: IpcItem | null;
  readonly onClose: () => void;
  readonly onPlay: (item: IpcItem) => void;
}): React.ReactElement => (
  <Modal
    open={item !== null}
    onOpenChange={(open) => {
      if (!open) onClose();
    }}
    title={item?.title ?? "Media details"}
    description={
      item === null
        ? undefined
        : `${item.year === null ? "Release year unavailable" : item.year} · ${titleCase(item.kind)}`
    }
    className="details-dialog"
  >
    {item === null ? null : (
      <div className="details-content">
        <div className="details-poster">
          <Film aria-hidden="true" size={46} />
          <span>{item.title.slice(0, 1)}</span>
        </div>
        <div className="details-copy">
          <span className="quality-badge">Original quality · Direct Play</span>
          <p>
            {item.durationMs === null
              ? "Ready to play in MPV."
              : `${formatDuration(item.durationMs)} · Ready to play in MPV.`}
          </p>
          {item.resumePositionSeconds === null || item.resumePositionSeconds === 0 ? null : (
            <p className="resume-copy">You left off at {formatTime(item.resumePositionSeconds)}.</p>
          )}
          <Button className="button-wide" variant="primary" onClick={() => onPlay(item)}>
            <Play aria-hidden="true" size={17} fill="currentColor" />
            {item.resumePositionSeconds === null || item.resumePositionSeconds === 0
              ? "Play now"
              : "Resume playback"}
          </Button>
        </div>
      </div>
    )}
  </Modal>
);

const AdminUsers = ({
  users,
  scope,
}: {
  readonly users: ReadonlyArray<User>;
  readonly scope: readonly unknown[];
}): React.ReactElement => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin" | "guest">("user");
  const create = useMutation({
    mutationFn: () => bridge.admin.createUser({ username, displayName, password, role }),
    onSuccess: async () => {
      setUsername("");
      setDisplayName("");
      setPassword("");
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "users"] });
    },
  });
  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <span className="panel-icon">
          <Users aria-hidden="true" size={19} />
        </span>
        <div>
          <h2>People</h2>
          <p>
            {users.length} {users.length === 1 ? "account" : "accounts"} on this server
          </p>
        </div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          <Plus aria-hidden="true" size={16} />
          Add user
        </Button>
      </div>
      <div className="admin-list">
        {users.map((user) => (
          <UserRow key={user.id} user={user} scope={scope} />
        ))}
      </div>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Create a user"
        description="Add a new account and choose its level of access."
      >
        <Form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <TextField label="Username" value={username} onValueChange={setUsername} />
          <TextField label="Display name" value={displayName} onValueChange={setDisplayName} />
          <TextField
            label="Password"
            type="password"
            value={password}
            onValueChange={setPassword}
          />
          <SelectField label="Role" value={role} options={roleOptions} onValueChange={setRole} />
          {create.isError ? (
            <p className="error-message" role="alert">
              {errorMessage(create.error, "Could not create user")}
            </p>
          ) : null}
          <Button
            variant="primary"
            type="submit"
            disabled={create.isPending || username.trim() === "" || password === ""}
          >
            {create.isPending ? "Creating…" : "Create user"}
          </Button>
        </Form>
      </Modal>
    </section>
  );
};

const UserRow = ({
  user,
  scope,
}: {
  readonly user: User;
  readonly scope: readonly unknown[];
}): React.ReactElement => {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [password, setPassword] = useState("");
  const [role, setRole] = useState(user.role);
  const [isActive, setIsActive] = useState(user.isActive);
  const update = useMutation({
    mutationFn: () =>
      bridge.admin.updateUser({
        userId: user.id,
        displayName,
        password: password === "" ? undefined : password,
        role,
        isActive,
      }),
    onSuccess: async () => {
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "users"] });
    },
  });
  return (
    <Form
      className="admin-row"
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate();
      }}
    >
      <div className="row-identity">
        <span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
        <div>
          <strong>{user.displayName}</strong>
          <span>@{user.username}</span>
        </div>
      </div>
      <TextField label="Display name" value={displayName} onValueChange={setDisplayName} />
      <SelectField label="Role" value={role} options={roleOptions} onValueChange={setRole} />
      <TextField
        label="New password"
        type="password"
        value={password}
        onValueChange={setPassword}
        placeholder="Leave unchanged"
      />
      <CheckboxField label="Active" checked={isActive} onCheckedChange={setIsActive} />
      <Button type="submit" disabled={update.isPending}>
        {update.isPending ? "Saving…" : "Save changes"}
      </Button>
    </Form>
  );
};

const AdminLibraries = ({
  libraries,
  scope,
}: {
  readonly libraries: ReadonlyArray<IpcLibrary>;
  readonly scope: readonly unknown[];
}): React.ReactElement => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [kind, setKind] = useState<"movies" | "shows" | "music">("movies");
  const create = useMutation({
    mutationFn: () => bridge.admin.createLibrary({ id: crypto.randomUUID(), name, slug, kind }),
    onSuccess: async () => {
      setName("");
      setSlug("");
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "libraries"] });
    },
  });
  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <span className="panel-icon">
          <LibraryBig aria-hidden="true" size={19} />
        </span>
        <div>
          <h2>Libraries</h2>
          <p>
            {libraries.length} {libraries.length === 1 ? "collection" : "collections"} configured
          </p>
        </div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          <Plus aria-hidden="true" size={16} />
          New library
        </Button>
      </div>
      <div className="admin-list">
        {libraries.map((library) => (
          <LibraryRow key={library.id} library={library} scope={scope} />
        ))}
      </div>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Create a library"
        description="Set up a collection, then add one or more filesystem roots."
      >
        <Form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <TextField
            label="Name"
            value={name}
            onValueChange={(value) => {
              setName(value);
              if (slug === "" || slug === slugify(name)) setSlug(slugify(value));
            }}
          />
          <TextField
            label="Slug"
            value={slug}
            onValueChange={setSlug}
            description="Used as the library's stable identifier."
          />
          <SelectField
            label="Media type"
            value={kind}
            options={libraryKindOptions}
            onValueChange={setKind}
          />
          <Button
            variant="primary"
            type="submit"
            disabled={create.isPending || name.trim() === "" || slug.trim() === ""}
          >
            {create.isPending ? "Creating…" : "Create library"}
          </Button>
        </Form>
      </Modal>
    </section>
  );
};

const LibraryRow = ({
  library,
  scope,
}: {
  readonly library: IpcLibrary;
  readonly scope: readonly unknown[];
}): React.ReactElement => {
  const queryClient = useQueryClient();
  const [name, setName] = useState(library.name);
  const [slug, setSlug] = useState(library.slug);
  const [kind, setKind] = useState(library.kind);
  const [isEnabled, setIsEnabled] = useState(library.isEnabled);
  const [rootPath, setRootPath] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const roots = useQuery({
    queryKey: [...scope, "admin", "roots", library.id],
    queryFn: () => bridge.admin.listRoots(library.id),
  });
  const update = useMutation({
    mutationFn: () =>
      bridge.admin.updateLibrary({ libraryId: library.id, name, slug, kind, isEnabled }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "libraries"] });
    },
  });
  const addRoot = useMutation({
    mutationFn: () =>
      bridge.admin.addRoot({
        id: crypto.randomUUID(),
        libraryId: library.id,
        path: rootPath,
        priority: roots.data?.length ?? 0,
      }),
    onSuccess: async () => {
      setRootPath("");
      await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "roots", library.id] });
    },
  });
  const scan = useMutation({
    mutationFn: async () => {
      const { runId } = await bridge.admin.startScan({ libraryId: library.id, mode: "full" });
      while (true) {
        const run = await bridge.admin.scanStatus(runId);
        if (run.status === "succeeded") return;
        if (run.status === "failed" || run.status === "cancelled")
          throw new Error(run.errorMessage ?? "Library scan failed");
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [...scope, "items", library.id] });
    },
  });
  const remove = useMutation({
    mutationFn: () => bridge.admin.deleteLibrary(library.id),
    onSuccess: async () => {
      setConfirmDelete(false);
      await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "libraries"] });
    },
  });
  return (
    <article className="library-admin-row">
      <div className="library-row-header">
        <div>
          <span className="library-type">{titleCase(library.kind)}</span>
          <h3>{library.name}</h3>
        </div>
        <span className={`status-badge ${isEnabled ? "online" : ""}`}>
          <i />
          {isEnabled ? "Enabled" : "Disabled"}
        </span>
      </div>
      <Form
        className="admin-row library-fields"
        onSubmit={(event) => {
          event.preventDefault();
          update.mutate();
        }}
      >
        <TextField label="Name" value={name} onValueChange={setName} />
        <TextField label="Slug" value={slug} onValueChange={setSlug} />
        <SelectField
          label="Type"
          value={kind}
          options={libraryKindOptions}
          onValueChange={setKind}
        />
        <CheckboxField label="Enabled" checked={isEnabled} onCheckedChange={setIsEnabled} />
        <Button type="submit" disabled={update.isPending || remove.isPending}>
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="ghost"
          disabled={scan.isPending || roots.isLoading || (roots.data?.length ?? 0) === 0}
          onClick={() => scan.mutate()}
        >
          {scan.isPending ? "Scanning…" : "Scan now"}
        </Button>
        <Button
          variant="danger"
          disabled={remove.isPending || scan.isPending}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </Button>
      </Form>
      <div className="root-editor">
        <div className="root-heading">
          <div>
            <h4>Media folders</h4>
            <p>Folders scanned for this library.</p>
          </div>
        </div>
        {scan.isError ? (
          <p className="error-message" role="alert">
            {errorMessage(scan.error, "Could not scan library")}
          </p>
        ) : null}
        {roots.data?.length === 0 ? (
          <p className="muted">No folders configured yet.</p>
        ) : (
          roots.data?.map((value) => {
            const root = value as { id: string; path: string };
            return (
              <div className="root-row" key={root.id}>
                <Folder aria-hidden="true" size={16} />
                <code>{root.path}</code>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void bridge.admin
                      .deleteRoot(root.id)
                      .then(() =>
                        queryClient.invalidateQueries({
                          queryKey: [...scope, "admin", "roots", library.id],
                        }),
                      )
                  }
                >
                  Remove
                </Button>
              </div>
            );
          })
        )}
        <Form
          className="root-form"
          onSubmit={(event) => {
            event.preventDefault();
            addRoot.mutate();
          }}
        >
          <TextField
            hideLabel
            label="Filesystem path"
            value={rootPath}
            onValueChange={setRootPath}
            placeholder="/media/movies"
          />
          <Button disabled={addRoot.isPending || rootPath.trim() === ""} type="submit">
            <Plus aria-hidden="true" size={15} />
            {addRoot.isPending ? "Adding…" : "Add folder"}
          </Button>
        </Form>
      </div>
      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${library.name}?`}
        description="This removes the library and its configured roots. Your media files will not be deleted."
      >
        <div className="confirm-actions">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? "Deleting…" : "Delete library"}
          </Button>
        </div>
      </Modal>
    </article>
  );
};

const PageHeader = ({
  eyebrow,
  title,
  description,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
}): React.ReactElement => (
  <header className="page-header">
    <span className="eyebrow">{eyebrow}</span>
    <h1>{title}</h1>
    <p>{description}</p>
  </header>
);

const EmptyState = ({
  icon: Icon,
  title,
  message,
}: {
  readonly icon: typeof SearchIcon;
  readonly title: string;
  readonly message: string;
}): React.ReactElement => (
  <div className="empty-state">
    <span>
      <Icon aria-hidden="true" size={24} />
    </span>
    <h3>{title}</h3>
    <p>{message}</p>
  </div>
);

const InfoCard = ({
  icon: Icon,
  title,
  rows,
}: {
  readonly icon: typeof SearchIcon;
  readonly title: string;
  readonly rows: ReadonlyArray<readonly [string, string]>;
}): React.ReactElement => (
  <section className="info-card">
    <div className="panel-heading">
      <span className="panel-icon">
        <Icon aria-hidden="true" size={19} />
      </span>
      <h2>{title}</h2>
    </div>
    <div className="info-rows">
      {rows.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  </section>
);

const extractItems = (value: unknown): ReadonlyArray<IpcItem> => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("items" in value) ||
    !Array.isArray(value.items)
  )
    return [];
  return value.items.filter(
    (item): item is IpcItem =>
      typeof item === "object" &&
      item !== null &&
      typeof item.id === "string" &&
      typeof item.title === "string" &&
      typeof item.libraryId === "string" &&
      typeof item.kind === "string",
  );
};
const titleCase = (value: string): string =>
  value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.trim() !== "" ? cause.message : fallback;
const formatTime = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const formatDuration = (milliseconds: number): string => {
  const minutes = Math.round(milliseconds / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes} min`;
};
