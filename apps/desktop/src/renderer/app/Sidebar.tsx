import type { IpcAccount, IpcLibrary } from "@lumen/contracts";
import { AccountMenu } from "@lumen/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  Film,
  FolderCog,
  House,
  type LucideIcon,
  Music,
  Search,
  Tv,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { LumenMark } from "./LumenMark";
import { useLibraries } from "./Workspace";

export const libraryIcon = (kind: IpcLibrary["kind"]): LucideIcon =>
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

export const Sidebar = ({
  account,
  accounts,
  scope,
  onActivate,
  onRemove,
  onAddServer,
}: {
  readonly account: IpcAccount;
  readonly accounts: ReadonlyArray<IpcAccount>;
  readonly scope: readonly unknown[];
  readonly onActivate: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onAddServer: () => void;
}): React.ReactElement => {
  const navigate = useNavigate();
  const libraries = useLibraries(scope);
  return (
    <>
      <div className="sidebar-brand">
        <LumenMark />
        <span>Lumen</span>
      </div>
      <nav className="nav" aria-label="Primary">
        <div className="nav-group">
          <Link className="nav-item" to="/" activeOptions={{ exact: true }}>
            <NavLabel icon={House}>Home</NavLabel>
          </Link>
          <Link className="nav-item" to="/search">
            <NavLabel icon={Search} trailing={<kbd className="nav-shortcut">⌘K</kbd>}>
              Search
            </NavLabel>
          </Link>
        </div>
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
        {account.role === "admin" ? (
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
      <div className="sidebar-footer">
        <AccountMenu
          accounts={accounts}
          active={account}
          onActivate={onActivate}
          onRemove={onRemove}
          onAddServer={onAddServer}
          onOpenSettings={() => void navigate({ to: "/settings" })}
        />
      </div>
    </>
  );
};
