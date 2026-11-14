import type { AppUpdatesRuntime } from "@lumen/client/runtime";
import type { AccountSummary, LibrarySummary } from "@lumen/contracts";
import { AccountMenu } from "@lumen/ui";
import { Link, useCanGoBack, useMatchRoute, useNavigate, useRouter } from "@tanstack/react-router";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  CircleArrowUp,
  Cpu,
  Film,
  FolderCog,
  HardDrive,
  House,
  type LucideIcon,
  Music,
  Play,
  Search,
  Server,
  Tv,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { AppUpdateButton, useAppUpdateStatus } from "./AppUpdates";
import { DeviceOnly } from "./Downloads";
import { LumenMark } from "./LumenMark";
import { useRuntime } from "./Runtime";
import { WatchGroups } from "./WatchGroups";
import { useLibraries } from "./Workspace";

export const libraryIcon = (kind: LibrarySummary["kind"]): LucideIcon =>
  kind === "shows" ? Tv : kind === "music" ? Music : Film;

const NavLabel = ({
  icon: Icon,
  children,
  trailing,
}: {
  readonly icon: LucideIcon;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
}): React.ReactElement => (
  <>
    <Icon aria-hidden="true" size={16} strokeWidth={1.85} />
    <span className="nav-item-label">{children}</span>
    {trailing}
  </>
);

const UpdatesNavItem = ({
  updates,
}: {
  readonly updates: AppUpdatesRuntime;
}): React.ReactElement | null => {
  const status = useAppUpdateStatus(updates);
  if (status.data?.automatic == null) return null;
  return (
    <DeviceOnly>
      <Link className="nav-item" to="/settings/updates" replace>
        <NavLabel icon={CircleArrowUp}>Updates</NavLabel>
      </Link>
    </DeviceOnly>
  );
};

/** Replaces the primary navigation while a settings page is open. */
const SettingsNav = ({
  account,
  offline,
}: {
  readonly account: AccountSummary;
  readonly offline: boolean;
}): React.ReactElement => {
  const { downloads, appUpdates } = useRuntime();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  // Categories replace each other in history, so one step back leaves settings.
  const leave = () => {
    if (canGoBack) router.history.back();
    else void router.navigate({ to: offline ? "/downloads" : "/", replace: true });
  };
  return (
    <nav className="nav" aria-label="Settings">
      <div className="nav-group">
        <button type="button" className="nav-item nav-back" onClick={leave}>
          <NavLabel icon={ArrowLeft}>Back</NavLabel>
        </button>
      </div>
      <div className="nav-group">
        <span className="nav-heading">Settings</span>
        <Link className="nav-item" to="/settings/playback" replace>
          <NavLabel icon={Play}>Playback</NavLabel>
        </Link>
        {downloads === null ? null : (
          <DeviceOnly>
            <Link className="nav-item" to="/settings/downloads" replace>
              <NavLabel icon={HardDrive}>Downloads</NavLabel>
            </Link>
          </DeviceOnly>
        )}
        {account.role === "admin" ? (
          <Link className="nav-item" to="/settings/transcoding" replace>
            <NavLabel icon={Cpu}>Transcoding</NavLabel>
          </Link>
        ) : null}
        {appUpdates === null ? null : <UpdatesNavItem updates={appUpdates} />}
        <Link className="nav-item" to="/settings/server" replace>
          <NavLabel icon={Server}>Server</NavLabel>
        </Link>
      </div>
    </nav>
  );
};

export const Sidebar = ({
  account,
  accounts,
  scope,
  offline,
  onActivate,
  onRemove,
  onAddServer,
}: {
  /** The server cannot be reached: only what is on this device is offered. */
  readonly offline: boolean;
  readonly account: AccountSummary;
  readonly accounts: ReadonlyArray<AccountSummary>;
  readonly scope: readonly unknown[];
  readonly onActivate: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onAddServer: () => void;
}): React.ReactElement => {
  const navigate = useNavigate();
  const runtime = useRuntime();
  const libraries = useLibraries(scope);
  const inSettings = useMatchRoute()({ to: "/settings", fuzzy: true }) !== false;
  return (
    <>
      <div className="sidebar-brand">
        <LumenMark />
        {runtime.appUpdates === null ? null : <AppUpdateButton updates={runtime.appUpdates} />}
      </div>
      {inSettings ? (
        <SettingsNav account={account} offline={offline} />
      ) : (
        <nav className="nav" aria-label="Primary">
          <div className="nav-group">
            {offline ? null : (
              <>
                <Link className="nav-item" to="/" activeOptions={{ exact: true }}>
                  <NavLabel icon={House}>Home</NavLabel>
                </Link>
                <Link className="nav-item" to="/search">
                  <NavLabel icon={Search} trailing={<kbd className="nav-shortcut">⌘K</kbd>}>
                    Search
                  </NavLabel>
                </Link>
              </>
            )}
            {runtime.downloads === null ? null : (
              <DeviceOnly>
                <Link className="nav-item" to="/downloads">
                  <NavLabel icon={ArrowDownToLine}>Downloads</NavLabel>
                </Link>
              </DeviceOnly>
            )}
          </div>
          {offline ? null : (
            <div className="nav-group">
              <span className="nav-heading">Libraries</span>
              {libraries.data?.map((library) => (
                <Link
                  className="nav-item"
                  key={library.id}
                  to="/library/$libraryId"
                  params={{ libraryId: library.id }}
                >
                  <NavLabel icon={libraryIcon(library.kind)}>{library.name}</NavLabel>
                </Link>
              ))}
              {libraries.data?.length === 0 ? (
                <span className="nav-empty">No libraries yet</span>
              ) : null}
            </div>
          )}
          {account.role === "admin" && !offline ? (
            <div className="nav-group">
              <span className="nav-heading">Administration</span>
              <Link className="nav-item" to="/admin" activeOptions={{ exact: true }}>
                <NavLabel icon={FolderCog}>Libraries</NavLabel>
              </Link>
              <Link className="nav-item" to="/admin/users">
                <NavLabel icon={Users}>Users</NavLabel>
              </Link>
              <Link className="nav-item" to="/admin/jobs">
                <NavLabel icon={Activity}>Job log</NavLabel>
              </Link>
            </div>
          ) : null}
        </nav>
      )}
      <div className="sidebar-footer">
        <WatchGroups placement="sidebar" />
        <AccountMenu
          accounts={accounts}
          active={account}
          onActivate={onActivate}
          onRemove={onRemove}
          onAddServer={onAddServer}
          onOpenSettings={() => void navigate({ to: "/settings", replace: inSettings })}
          canSwitchServers={runtime.capabilities.serverSwitching}
        />
      </div>
    </>
  );
};
