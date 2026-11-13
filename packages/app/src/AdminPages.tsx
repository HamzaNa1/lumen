import { randomId } from "@lumen/client";
import type { LibraryAccess, LibrarySummary, ManagedUser, UserRole } from "@lumen/contracts";
import {
  Avatar,
  Button,
  CheckboxField,
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
import {
  errorMessage,
  libraryKindLabels,
  passwordRule,
  plural,
  roleLabels,
  slugify,
} from "./format";
import {
  type FolderSelection,
  FolderSelectionNote,
  folderName,
  useFolderPicker,
} from "./LibraryFolders";
import { useRuntime } from "./Runtime";
import { libraryIcon } from "./Sidebar";
import { PageHeader, useWorkspace } from "./Workspace";

const roleOptions = [
  { value: "user", label: roleLabels.user },
  { value: "admin", label: roleLabels.admin },
] as const;
const libraryScopeOptions = [
  { value: "all", label: "All libraries" },
  { value: "selected", label: "Selected libraries" },
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
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const update = useMutation({
    mutationFn: (tmdbApiKey: string | null) => runtime.admin.updateMetadataSettings({ tmdbApiKey }),
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
  readonly library: LibrarySummary;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly scope: readonly unknown[];
}): React.ReactElement => {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const [name, setName] = useState(library.name);
  const [slug, setSlug] = useState(library.slug);
  const [kind, setKind] = useState<LibrarySummary["kind"]>(library.kind);
  const [isEnabled, setIsEnabled] = useState(library.isEnabled);
  const save = useMutation({
    mutationFn: () =>
      runtime.admin.updateLibrary({ libraryId: library.id, name, slug, kind, isEnabled }),
    onSuccess: async () => {
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "libraries"] });
      await queryClient.invalidateQueries({ queryKey: [...scope, "libraries"] });
    },
  });
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={`Edit ${library.name}`}>
      <Form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <LibraryFields
          name={name}
          slug={slug}
          kind={kind}
          onNameChange={(value) => {
            setName(value);
            if (slug === "" || slug === slugify(name)) setSlug(slugify(value));
          }}
          onSlugChange={setSlug}
          onKindChange={setKind}
        />
        <SwitchField
          label="Enabled"
          description="Disabled libraries are hidden from everyone and skipped by scans."
          checked={isEnabled}
          onCheckedChange={setIsEnabled}
        />
        {save.isError ? <FormError error={save.error} fallback="Could not save library" /> : null}
        <div className="dialog-actions">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={save.isPending || name.trim() === "" || slug.trim() === ""}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </Form>
    </Modal>
  );
};

const LibraryFields = ({
  name,
  slug,
  kind,
  onNameChange,
  onSlugChange,
  onKindChange,
}: {
  readonly name: string;
  readonly slug: string;
  readonly kind: LibrarySummary["kind"];
  readonly onNameChange: (name: string) => void;
  readonly onSlugChange: (slug: string) => void;
  readonly onKindChange: (kind: LibrarySummary["kind"]) => void;
}): React.ReactElement => (
  <>
    <TextField label="Name" value={name} placeholder="Movies" onValueChange={onNameChange} />
    <TextField
      label="Slug"
      value={slug}
      onValueChange={onSlugChange}
      description="A stable identifier used in links. Lowercase letters, numbers, and dashes."
    />
    <SelectField
      label="Media type"
      value={kind}
      options={libraryKindOptions}
      onValueChange={onKindChange}
    />
  </>
);

const kindOfFolder = (name: string): LibrarySummary["kind"] =>
  /music|audio|songs/iu.test(name)
    ? "music"
    : /tv|shows?\b|series/iu.test(name)
      ? "shows"
      : "movies";

const NewLibraryDialog = ({
  onClose,
  scope,
}: {
  readonly onClose: () => void;
  readonly scope: readonly unknown[];
}): React.ReactElement => {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const picker = useFolderPicker({ start: null });
  const [folder, setFolder] = useState<FolderSelection | null>(null);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [slug, setSlug] = useState("");
  const [kind, setKind] = useState<LibrarySummary["kind"]>("movies");
  const [kindEdited, setKindEdited] = useState(false);
  const save = useMutation({
    mutationFn: (path: string) =>
      runtime.admin.createLibrary({
        id: randomId(),
        name,
        slug,
        kind,
        root: { id: randomId(), path },
      }),
    onSuccess: async () => {
      onClose();
      await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "libraries"] });
      await queryClient.invalidateQueries({ queryKey: [...scope, "libraries"] });
    },
  });
  const selection = picker.selection;
  const next = (chosen: FolderSelection): void => {
    setFolder(chosen);
    const named = folderName(chosen.path);
    // Name and type follow the folder until the administrator changes them.
    if (!nameEdited) {
      const suggested = named.charAt(0).toUpperCase() + named.slice(1);
      setName(suggested);
      setSlug(slugify(suggested));
    }
    if (!kindEdited) setKind(kindOfFolder(named));
  };
  return (
    <Modal
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      className="folder-dialog"
      title="New library"
      description={
        folder === null
          ? "Choose the folder on the server that holds this library’s media."
          : "Name the library and choose what kind of media it holds."
      }
    >
      {folder === null ? (
        <div className="dialog-form">
          {picker.view}
          <div className="dialog-actions">
            <FolderSelectionNote
              selection={selection}
              hint="Open the folder that holds this library’s media."
            />
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={selection === null || selection.overlaps !== null}
              onClick={() => (selection === null ? undefined : next(selection))}
            >
              Next
            </Button>
          </div>
        </div>
      ) : (
        <Form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(folder.path);
          }}
        >
          <div className="folder-summary">
            <Folder aria-hidden="true" size={16} />
            <div>
              <code title={folder.path}>{folder.label}</code>
              {folder.summary === "" ? null : <span>{folder.summary}</span>}
            </div>
            <Button size="sm" variant="ghost" onClick={() => setFolder(null)}>
              Change
            </Button>
          </div>
          <LibraryFields
            name={name}
            slug={slug}
            kind={kind}
            onNameChange={(value) => {
              setName(value);
              setNameEdited(true);
              if (slug === "" || slug === slugify(name)) setSlug(slugify(value));
            }}
            onSlugChange={setSlug}
            onKindChange={(value) => {
              setKind(value);
              setKindEdited(true);
            }}
          />
          {save.isError ? (
            <FormError error={save.error} fallback="Could not create library" />
          ) : null}
          <div className="dialog-actions">
            <Button
              className="dialog-actions-start"
              variant="ghost"
              onClick={() => setFolder(null)}
            >
              Back
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={save.isPending || name.trim() === "" || slug.trim() === ""}
            >
              {save.isPending ? "Creating…" : "Create library"}
            </Button>
          </div>
        </Form>
      )}
    </Modal>
  );
};

interface Root {
  readonly id: string;
  readonly path: string;
  readonly priority: number;
}

const FolderDialog = ({
  library,
  root,
  priority,
  onClose,
  scope,
}: {
  readonly library: LibrarySummary;
  /** The folder being changed, or null to add another. */
  readonly root: Root | null;
  readonly priority: number;
  readonly onClose: () => void;
  readonly scope: readonly unknown[];
}): React.ReactElement => {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const picker = useFolderPicker({ start: root?.path ?? null, replacing: root?.id });
  const save = useMutation({
    mutationFn: (path: string) =>
      root === null
        ? runtime.admin.addRoot({ id: randomId(), libraryId: library.id, path, priority })
        : runtime.admin.replaceRoot({
            id: randomId(),
            libraryId: library.id,
            path,
            priority: root.priority,
            replacesRootId: root.id,
          }),
    onSuccess: async () => {
      onClose();
      await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "roots", library.id] });
      await queryClient.invalidateQueries({ queryKey: [...scope, "items", library.id] });
    },
  });
  const selection = picker.selection;
  return (
    <Modal
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      className="folder-dialog"
      title={root === null ? `Add a folder to ${library.name}` : `Change ${library.name} folder`}
      description={
        root === null
          ? "Lumen scans every folder in a library together."
          : "Anything found only in the current folder is removed from the library."
      }
    >
      <div className="dialog-form">
        {picker.view}
        {save.isError ? (
          <FormError
            error={save.error}
            fallback={root === null ? "Could not add folder" : "Could not change folder"}
          />
        ) : null}
        <div className="dialog-actions">
          <FolderSelectionNote selection={selection} hint="Open a folder to choose it." />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              save.isPending ||
              selection === null ||
              selection.overlaps !== null ||
              selection.path === root?.path
            }
            onClick={() => (selection === null ? undefined : save.mutate(selection.path))}
          >
            {root === null ? "Add folder" : "Use this folder"}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

const LibraryCard = ({
  library,
  scope,
}: {
  readonly library: LibrarySummary;
  readonly scope: readonly unknown[];
}): React.ReactElement => {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [folder, setFolder] = useState<{ readonly root: Root | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const Icon = libraryIcon(library.kind);
  const roots = useQuery({
    queryKey: [...scope, "admin", "roots", library.id],
    queryFn: () => runtime.admin.listRoots(library.id),
  });
  const rootList = (roots.data ?? []) as ReadonlyArray<Root>;
  const refreshLibraries = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "libraries"] });
    await queryClient.invalidateQueries({ queryKey: [...scope, "libraries"] });
  };
  const toggle = useMutation({
    mutationFn: () =>
      runtime.admin.updateLibrary({ libraryId: library.id, isEnabled: !library.isEnabled }),
    onSuccess: refreshLibraries,
  });
  const removeRoot = useMutation({
    mutationFn: (rootId: string) => runtime.admin.deleteRoot(rootId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [...scope, "admin", "roots", library.id] });
    },
  });
  const scan = useMutation({
    mutationFn: async () => {
      const { runId } = await runtime.admin.startScan({ libraryId: library.id, mode: "full" });
      while (true) {
        const run = await runtime.admin.scanStatus(runId);
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
    mutationFn: () => runtime.admin.deleteLibrary(library.id),
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
          <p className="folder-empty">
            No folder yet. Choose the folder on the server that holds this library’s media.
          </p>
        ) : (
          rootList.map((root) => (
            <div className="folder-row" key={root.id}>
              <Folder aria-hidden="true" size={15} />
              <code title={root.path}>{root.path}</code>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Change ${root.path}`}
                onClick={() => setFolder({ root })}
              >
                <Pencil aria-hidden="true" size={13} />
                Change…
              </Button>
              <Button
                variant="icon"
                size="sm"
                aria-label={`Remove ${root.path}`}
                title={
                  rootList.length === 1
                    ? "A library needs a folder. Change it instead of removing it."
                    : undefined
                }
                disabled={removeRoot.isPending || rootList.length === 1}
                onClick={() => removeRoot.mutate(root.id)}
              >
                <X aria-hidden="true" size={14} />
              </Button>
            </div>
          ))
        )}
        <button
          type="button"
          className="folder-add"
          disabled={!library.isEnabled}
          onClick={() => setFolder({ root: null })}
        >
          <Plus aria-hidden="true" size={14} />
          {rootList.length === 0 ? "Choose folder…" : "Add another folder"}
        </button>
        {removeRoot.isError ? (
          <FormError error={removeRoot.error} fallback="Could not remove folder" />
        ) : null}
      </div>
      {folder === null ? null : (
        <FolderDialog
          library={library}
          root={folder.root}
          priority={rootList.length}
          onClose={() => setFolder(null)}
          scope={scope}
        />
      )}
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
  const runtime = useRuntime();
  const { scope } = useWorkspace();
  const [creating, setCreating] = useState(false);
  const metadata = useQuery({
    queryKey: [...scope, "admin", "metadata"],
    queryFn: () => runtime.admin.metadataSettings(),
  });
  const libraries = useQuery({
    queryKey: [...scope, "admin", "libraries"],
    queryFn: () => runtime.admin.listLibraries(),
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
      {creating ? <NewLibraryDialog onClose={() => setCreating(false)} scope={scope} /> : null}
    </div>
  );
};

const libraryAccessSummary = (user: ManagedUser): string => {
  if (user.role === "admin" || user.libraryAccess.scope === "all") return "All libraries";
  const count = user.libraryAccess.libraryIds.length;
  return count === 0 ? "None" : plural(count, "library", "libraries");
};

const LibraryAccessField = ({
  role,
  access,
  onAccessChange,
  scope,
}: {
  readonly role: UserRole;
  readonly access: LibraryAccess;
  readonly onAccessChange: (access: LibraryAccess) => void;
  readonly scope: readonly unknown[];
}): React.ReactElement => {
  const runtime = useRuntime();
  const libraries = useQuery({
    queryKey: [...scope, "admin", "libraries"],
    queryFn: () => runtime.admin.listLibraries(),
  });
  if (role === "admin")
    return (
      <div className="field">
        <span className="field-label">Library access</span>
        <p className="field-description">Administrators can always use every library.</p>
      </div>
    );
  const selected = access.scope === "selected" ? access.libraryIds : [];
  return (
    <>
      <SelectField
        label="Library access"
        value={access.scope}
        options={libraryScopeOptions}
        onValueChange={(value) =>
          onAccessChange(
            value === "all" ? { scope: "all" } : { scope: "selected", libraryIds: selected },
          )
        }
      />
      {access.scope === "all" ? (
        <p className="field-description">Includes libraries added later.</p>
      ) : libraries.isError ? (
        <FormError error={libraries.error} fallback="Could not load libraries" />
      ) : libraries.data === undefined ? null : libraries.data.length === 0 ? (
        <p className="field-description">This server has no libraries yet.</p>
      ) : (
        <fieldset className="checkbox-list">
          <legend className="sr-only">Libraries this user can use</legend>
          {libraries.data.map((library) => (
            <CheckboxField
              key={library.id}
              label={library.name}
              checked={selected.includes(library.id)}
              onCheckedChange={(checked) =>
                onAccessChange({
                  scope: "selected",
                  libraryIds: checked
                    ? [...selected, library.id]
                    : selected.filter((id) => id !== library.id),
                })
              }
            />
          ))}
        </fieldset>
      )}
    </>
  );
};

const defaultLibraryAccess: LibraryAccess = { scope: "all" };

const UserDialog = ({
  user,
  open,
  onOpenChange,
  scope,
}: {
  readonly user: ManagedUser | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly scope: readonly unknown[];
}): React.ReactElement => {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>(user?.role ?? "user");
  const [libraryAccess, setLibraryAccess] = useState<LibraryAccess>(
    user?.libraryAccess ?? defaultLibraryAccess,
  );
  const [isActive, setIsActive] = useState(user?.isActive ?? true);
  const [canDownload, setCanDownload] = useState(user?.canDownload ?? true);
  const save = useMutation({
    mutationFn: async () => {
      if (user === null) {
        await runtime.admin.createUser({
          username,
          displayName: displayName || username,
          password,
          role,
          libraryAccess,
          canDownload,
        });
      } else {
        await runtime.admin.updateUser({
          userId: user.id,
          displayName,
          ...(password === "" ? {} : { password }),
          role,
          libraryAccess,
          isActive,
          canDownload,
        });
      }
    },
    onSuccess: async () => {
      setPassword("");
      if (user === null) {
        setUsername("");
        setDisplayName("");
        setRole("user");
        setLibraryAccess(defaultLibraryAccess);
        setCanDownload(true);
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
          description={user === null ? passwordRule : undefined}
        />
        <SelectField label="Role" value={role} options={roleOptions} onValueChange={setRole} />
        <LibraryAccessField
          role={role}
          access={libraryAccess}
          onAccessChange={setLibraryAccess}
          scope={scope}
        />
        {role === "admin" ? null : (
          <SwitchField
            label="Can download"
            description="Lets them keep movies and episodes on their devices to watch later."
            checked={canDownload}
            onCheckedChange={setCanDownload}
          />
        )}
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
  const runtime = useRuntime();
  const { account, scope } = useWorkspace();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const users = useQuery({
    queryKey: [...scope, "admin", "users"],
    queryFn: () => runtime.admin.listUsers(),
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
                <th scope="col">Libraries</th>
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
                  <td>{libraryAccessSummary(user)}</td>
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
