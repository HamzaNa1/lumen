import type { IpcLibrary, User } from "@lumen/contracts";
import {
  Avatar,
  Button,
  DropdownItem,
  DropdownMenu,
  DropdownSeparator,
  EmptyState,
  Form,
  Modal,
  SelectField,
  StatusState,
  SwitchField,
  TextField,
} from "@lumen/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  Folder,
  LibraryBig,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  ShieldAlert,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { useState } from "react";
import { errorMessage, libraryKindLabels, plural, roleLabels, slugify } from "./format";
import { libraryIcon } from "./Sidebar";
import { bridge, PageHeader, useWorkspace } from "./Workspace";

const roleOptions = [
  { value: "user", label: roleLabels.user },
  { value: "guest", label: roleLabels.guest },
  { value: "admin", label: roleLabels.admin },
] as const;
const libraryKindOptions = [
  { value: "movies", label: libraryKindLabels.movies },
  { value: "shows", label: libraryKindLabels.shows },
  { value: "music", label: libraryKindLabels.music },
] as const;

const FormError = ({ error, fallback }: { readonly error: unknown; readonly fallback: string }) => (
  <p className="form-error" role="alert">
    <CircleAlert aria-hidden="true" size={15} />
    <span>{errorMessage(error, fallback)}</span>
  </p>
);

export const AdminOnly = ({ children }: { readonly children: React.ReactNode }) => {
  const { account } = useWorkspace();
  if (account.role === "admin") return children;
  return (
    <div className="page">
      <EmptyState
        icon={ShieldAlert}
        title="Administrator access required"
        message="Only server administrators can open this page."
      />
    </div>
  );
};

const MetadataPanel = ({
  configured,
  scope,
}: {
  readonly configured: boolean;
  readonly scope: readonly unknown[];
}): React.ReactElement => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const update = useMutation({
    mutationFn: (tmdbApiKey: string | null) => bridge.admin.updateMetadataSettings({ tmdbApiKey }),
    onSuccess: async () => {
      setKey("");
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "metadata"] });
      await queryClient.invalidateQueries({ queryKey: [...scope, "item"] });
    },
  });
  return (
    <section className="panel metadata-panel">
      <div className="metadata-panel-text">
        <h2>
          Metadata
          <span className={`status-pill${configured ? " is-positive" : ""}`}>
            {configured ? "TMDb connected" : "Not configured"}
          </span>
        </h2>
        <p>
          {configured
            ? "Descriptions, artwork, and ratings for movies and shows are fetched from TMDb."
            : "Add a TMDb API key to fetch descriptions, artwork, and ratings for movies and shows. Local .nfo files and artwork are always used."}
        </p>
      </div>
      <Button
        onClick={() => {
          update.reset();
          setOpen(true);
        }}
      >
        {configured ? "Change key…" : "Add API key…"}
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={configured ? "Change TMDb API key" : "Add TMDb API key"}
        description="The key is stored on the server and never sent to other devices."
      >
        <Form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate(key.trim());
          }}
        >
          <TextField
            label="TMDb API key (v3)"
            type="password"
            value={key}
            onValueChange={setKey}
            autoComplete="off"
            description="Saving starts fetching details for everything already scanned."
          />
          {update.isError ? (
            <FormError error={update.error} fallback="Could not save the key" />
          ) : null}
          <div className="dialog-actions">
            {configured ? (
              <Button
                className="dialog-actions-start"
                variant="danger"
                disabled={update.isPending}
                onClick={() => update.mutate(null)}
              >
                Remove key
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={update.isPending || key.trim() === ""}
            >
              {update.isPending ? "Saving…" : "Save key"}
            </Button>
          </div>
        </Form>
      </Modal>
    </section>
  );
};

const LibraryDialog = ({
  library,
  open,
  onOpenChange,
  scope,
}: {
  readonly library: IpcLibrary | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly scope: readonly unknown[];
}): React.ReactElement => {
  const queryClient = useQueryClient();
  const [name, setName] = useState(library?.name ?? "");
  const [slug, setSlug] = useState(library?.slug ?? "");
  const [kind, setKind] = useState<IpcLibrary["kind"]>(library?.kind ?? "movies");
  const [isEnabled, setIsEnabled] = useState(library?.isEnabled ?? true);
  const save = useMutation({
    mutationFn: async () => {
      if (library === null) {
        await bridge.admin.createLibrary({ id: crypto.randomUUID(), name, slug, kind });
      } else {
        await bridge.admin.updateLibrary({ libraryId: library.id, name, slug, kind, isEnabled });
      }
    },
    onSuccess: async () => {
      onOpenChange(false);
      if (library === null) {
        setName("");
        setSlug("");
      }
      await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "libraries"] });
      await queryClient.invalidateQueries({ queryKey: [...scope, "libraries"] });
    },
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={library === null ? "New library" : `Edit ${library.name}`}
      description={
        library === null
          ? "After creating the library, add the folders Lumen should scan."
          : undefined
      }
    >
      <Form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <TextField
          label="Name"
          value={name}
          placeholder="Movies"
          onValueChange={(value) => {
            setName(value);
            if (slug === "" || slug === slugify(name)) setSlug(slugify(value));
          }}
        />
        <TextField
          label="Slug"
          value={slug}
          onValueChange={setSlug}
          description="A stable identifier used in links. Lowercase letters, numbers, and dashes."
        />
        <SelectField
          label="Media type"
          value={kind}
          options={libraryKindOptions}
          onValueChange={setKind}
        />
        {library === null ? null : (
          <SwitchField
            label="Enabled"
            description="Disabled libraries are hidden from everyone and skipped by scans."
            checked={isEnabled}
            onCheckedChange={setIsEnabled}
          />
        )}
        {save.isError ? (
          <FormError
            error={save.error}
            fallback={library === null ? "Could not create library" : "Could not save library"}
          />
        ) : null}
        <div className="dialog-actions">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={save.isPending || name.trim() === "" || slug.trim() === ""}
          >
            {save.isPending ? "Saving…" : library === null ? "Create library" : "Save changes"}
          </Button>
        </div>
      </Form>
    </Modal>
  );
};

const LibraryCard = ({
  library,
  scope,
}: {
  readonly library: IpcLibrary;
  readonly scope: readonly unknown[];
}): React.ReactElement => {
  const queryClient = useQueryClient();
  const [rootPath, setRootPath] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const Icon = libraryIcon(library.kind);
  const roots = useQuery({
    queryKey: [...scope, "admin", "roots", library.id],
    queryFn: () => bridge.admin.listRoots(library.id),
  });
  const rootList = (roots.data ?? []) as ReadonlyArray<{ id: string; path: string }>;
  const refreshLibraries = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "libraries"] });
    await queryClient.invalidateQueries({ queryKey: [...scope, "libraries"] });
  };
  const toggle = useMutation({
    mutationFn: () =>
      bridge.admin.updateLibrary({ libraryId: library.id, isEnabled: !library.isEnabled }),
    onSuccess: refreshLibraries,
  });
  const addRoot = useMutation({
    mutationFn: () =>
      bridge.admin.addRoot({
        id: crypto.randomUUID(),
        libraryId: library.id,
        path: rootPath.trim(),
        priority: rootList.length,
      }),
    onSuccess: async () => {
      setRootPath("");
      await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "roots", library.id] });
    },
  });
  const removeRoot = useMutation({
    mutationFn: (rootId: string) => bridge.admin.deleteRoot(rootId),
    onSuccess: async () => {
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
      await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "jobs"] });
    },
  });
  const remove = useMutation({
    mutationFn: () => bridge.admin.deleteLibrary(library.id),
    onSuccess: async () => {
      setConfirmDelete(false);
      await refreshLibraries();
    },
  });
  return (
    <article className={`panel library-card${library.isEnabled ? "" : " is-disabled"}`}>
      <header className="library-card-header">
        <span className="library-card-icon">
          <Icon aria-hidden="true" size={17} />
        </span>
        <div className="library-card-title">
          <h3>
            {library.name}
            {library.isEnabled ? null : <span className="status-pill">Disabled</span>}
          </h3>
          <p>
            {library.name.toLowerCase() === libraryKindLabels[library.kind].toLowerCase()
              ? plural(rootList.length, "folder")
              : `${libraryKindLabels[library.kind]} · ${plural(rootList.length, "folder")}`}
          </p>
        </div>
        <div className="library-card-actions">
          <Button
            size="sm"
            disabled={scan.isPending || rootList.length === 0 || !library.isEnabled}
            onClick={() => scan.mutate()}
          >
            <RefreshCw
              aria-hidden="true"
              size={14}
              className={scan.isPending ? "spinner" : undefined}
            />
            {scan.isPending ? "Scanning…" : "Scan"}
          </Button>
          <DropdownMenu
            trigger={
              <Button variant="icon" size="sm" aria-label={`More options for ${library.name}`}>
                <MoreHorizontal aria-hidden="true" size={16} />
              </Button>
            }
          >
            <DropdownItem
              icon={<Pencil aria-hidden="true" size={15} />}
              onClick={() => setEditing(true)}
            >
              Edit library…
            </DropdownItem>
            <DropdownItem
              icon={<Power aria-hidden="true" size={15} />}
              disabled={toggle.isPending}
              onClick={() => toggle.mutate()}
            >
              {library.isEnabled ? "Disable" : "Enable"}
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem
              icon={<Trash2 aria-hidden="true" size={15} />}
              tone="danger"
              disabled={scan.isPending}
              onClick={() => setConfirmDelete(true)}
            >
              Delete library…
            </DropdownItem>
          </DropdownMenu>
        </div>
      </header>
      {scan.isError ? <FormError error={scan.error} fallback="Could not scan library" /> : null}
      {scan.isSuccess ? (
        <p className="form-success" role="status">
          Scan finished.
        </p>
      ) : null}
      {toggle.isError ? (
        <FormError error={toggle.error} fallback="Could not update library" />
      ) : null}
      <div className="folder-list">
        {roots.isLoading ? null : rootList.length === 0 ? (
          <p className="folder-empty">No folders yet. Add the path to a folder on the server.</p>
        ) : (
          rootList.map((root) => (
            <div className="folder-row" key={root.id}>
              <Folder aria-hidden="true" size={15} />
              <code title={root.path}>{root.path}</code>
              <Button
                variant="icon"
                size="sm"
                aria-label={`Remove ${root.path}`}
                disabled={removeRoot.isPending}
                onClick={() => removeRoot.mutate(root.id)}
              >
                <X aria-hidden="true" size={14} />
              </Button>
            </div>
          ))
        )}
        <Form
          className="folder-add"
          onSubmit={(event) => {
            event.preventDefault();
            addRoot.mutate();
          }}
        >
          <TextField
            hideLabel
            label={`Add a folder to ${library.name}`}
            value={rootPath}
            onValueChange={setRootPath}
            placeholder={library.kind === "shows" ? "/media/tv" : `/media/${library.kind}`}
            spellCheck={false}
          />
          <Button type="submit" disabled={addRoot.isPending || rootPath.trim() === ""}>
            <Plus aria-hidden="true" size={15} />
            {addRoot.isPending ? "Adding…" : "Add folder"}
          </Button>
        </Form>
        {addRoot.isError ? (
          <FormError error={addRoot.error} fallback="Could not add folder" />
        ) : null}
        {removeRoot.isError ? (
          <FormError error={removeRoot.error} fallback="Could not remove folder" />
        ) : null}
      </div>
      {editing ? (
        <LibraryDialog library={library} open onOpenChange={setEditing} scope={scope} />
      ) : null}
      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${library.name}?`}
        description="The library and its folder list are removed from Lumen. Media files on disk are not touched."
      >
        {remove.isError ? (
          <FormError error={remove.error} fallback="Could not delete library" />
        ) : null}
        <div className="dialog-actions">
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

export const AdminLibrariesPage = (): React.ReactElement => (
  <AdminOnly>
    <AdminLibraries />
  </AdminOnly>
);

const AdminLibraries = (): React.ReactElement => {
  const { scope } = useWorkspace();
  const [creating, setCreating] = useState(false);
  const metadata = useQuery({
    queryKey: [...scope, "admin", "metadata"],
    queryFn: () => bridge.admin.metadataSettings(),
  });
  const libraries = useQuery({
    queryKey: [...scope, "admin", "libraries"],
    queryFn: () => bridge.admin.listLibraries(),
  });
  return (
    <div className="page page-narrow">
      <PageHeader
        title="Libraries"
        subtitle="Choose which folders on the server Lumen scans for media."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" size={16} />
            New library
          </Button>
        }
      />
      {libraries.isError || metadata.isError ? (
        <StatusState
          title="Couldn’t load server settings"
          message="Check your connection to the server."
          action={
            <Button
              onClick={() => {
                void libraries.refetch();
                void metadata.refetch();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : libraries.isLoading || metadata.isLoading ? (
        <div className="panel-skeleton" aria-hidden="true" />
      ) : (
        <div className="admin-stack">
          {libraries.data?.length === 0 ? (
            <EmptyState
              icon={LibraryBig}
              title="No libraries yet"
              message="A library groups one or more folders of the same kind of media."
              action={
                <Button variant="primary" onClick={() => setCreating(true)}>
                  New library
                </Button>
              }
            />
          ) : (
            libraries.data?.map((library) => (
              <LibraryCard key={library.id} library={library} scope={scope} />
            ))
          )}
          <MetadataPanel configured={metadata.data?.tmdbConfigured ?? false} scope={scope} />
        </div>
      )}
      <LibraryDialog library={null} open={creating} onOpenChange={setCreating} scope={scope} />
    </div>
  );
};

const UserDialog = ({
  user,
  open,
  onOpenChange,
  scope,
}: {
  readonly user: User | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly scope: readonly unknown[];
}): React.ReactElement => {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<User["role"]>(user?.role ?? "user");
  const [isActive, setIsActive] = useState(user?.isActive ?? true);
  const save = useMutation({
    mutationFn: async () => {
      if (user === null) {
        await bridge.admin.createUser({
          username,
          displayName: displayName || username,
          password,
          role,
        });
      } else {
        await bridge.admin.updateUser({
          userId: user.id,
          displayName,
          password: password === "" ? undefined : password,
          role,
          isActive,
        });
      }
    },
    onSuccess: async () => {
      setPassword("");
      if (user === null) {
        setUsername("");
        setDisplayName("");
        setRole("user");
      }
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "users"] });
    },
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={user === null ? "Add user" : `Edit ${user.displayName}`}
      description={
        user === null
          ? "They can sign in from any Lumen app with these details."
          : `@${user.username}`
      }
    >
      <Form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        {user === null ? (
          <TextField
            label="Username"
            value={username}
            onValueChange={setUsername}
            autoComplete="off"
            spellCheck={false}
          />
        ) : null}
        <TextField
          label="Display name"
          value={displayName}
          onValueChange={setDisplayName}
          placeholder={user === null && username !== "" ? username : undefined}
        />
        <TextField
          label={user === null ? "Password" : "New password"}
          type="password"
          value={password}
          onValueChange={setPassword}
          autoComplete="new-password"
          placeholder={user === null ? undefined : "Leave blank to keep the current password"}
          description={user === null ? "At least 12 characters." : undefined}
        />
        <SelectField label="Role" value={role} options={roleOptions} onValueChange={setRole} />
        {user === null ? null : (
          <SwitchField
            label="Can sign in"
            description="Turn off to block this account without deleting it."
            checked={isActive}
            onCheckedChange={setIsActive}
          />
        )}
        {save.isError ? (
          <FormError
            error={save.error}
            fallback={user === null ? "Could not create user" : "Could not save changes"}
          />
        ) : null}
        <div className="dialog-actions">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={
              save.isPending ||
              (user === null && (username.trim() === "" || password === "")) ||
              (user !== null && displayName.trim() === "")
            }
          >
            {save.isPending ? "Saving…" : user === null ? "Add user" : "Save changes"}
          </Button>
        </div>
      </Form>
    </Modal>
  );
};

export const AdminUsersPage = (): React.ReactElement => (
  <AdminOnly>
    <AdminUsers />
  </AdminOnly>
);

const AdminUsers = (): React.ReactElement => {
  const { account, scope } = useWorkspace();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const users = useQuery({
    queryKey: [...scope, "admin", "users"],
    queryFn: () => bridge.admin.listUsers(),
  });
  return (
    <div className="page page-narrow">
      <PageHeader
        title="Users"
        subtitle={users.data === undefined ? undefined : plural(users.data.length, "account")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <UserPlus aria-hidden="true" size={16} />
            Add user
          </Button>
        }
      />
      {users.isError ? (
        <StatusState
          title="Couldn’t load users"
          message="Check your connection to the server."
          action={<Button onClick={() => void users.refetch()}>Try again</Button>}
        />
      ) : users.isLoading ? (
        <div className="panel-skeleton" aria-hidden="true" />
      ) : (
        <div className="panel table-panel">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.data?.map((user) => (
                <tr key={user.id}>
                  <td>
                    <div className="user-cell">
                      <Avatar name={user.displayName} />
                      <div>
                        <strong>
                          {user.displayName}
                          {user.id === account.userId ? (
                            <span className="you-badge">You</span>
                          ) : null}
                        </strong>
                        <span>@{user.username}</span>
                      </div>
                    </div>
                  </td>
                  <td>{roleLabels[user.role]}</td>
                  <td>
                    <span className="status-dot" data-tone={user.isActive ? "positive" : "muted"}>
                      {user.isActive ? "Active" : "Disabled"}
                    </span>
                  </td>
                  <td className="cell-actions">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(user)}>
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <UserDialog user={null} open={creating} onOpenChange={setCreating} scope={scope} />
      {editing === null ? null : (
        <UserDialog
          key={editing.id}
          user={editing}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          scope={scope}
        />
      )}
    </div>
  );
};
