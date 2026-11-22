import { adaptiveRenditionsFor, type TrackPreferencesPatch } from "@lumen/contracts";
import { Button, Form, Modal, SelectField, TextField } from "@lumen/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleArrowUp,
  Cpu,
  HardDrive,
  Info,
  type LucideIcon,
  Play,
  Route,
  Server,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { AppUpdateSettings, useAppUpdateStatus } from "./AppUpdates";
import { DownloadSettingsSection } from "./Downloads";
import { errorMessage, hostOf } from "./format";
import { useRuntime } from "./Runtime";
import { ServerRoutesSection } from "./ServerRoutes";
import { TranscodingSettingsPanel } from "./TranscodingSettingsPanel";
import { useClientVersions } from "./versions";
import { ACCOUNTS_KEY, useWorkspace } from "./Workspace";

const SettingsRow = ({
  label,
  description,
  children,
}: {
  readonly label: string;
  readonly description?: string;
  readonly children: ReactNode;
}): React.ReactElement => (
  <div className="settings-row">
    <div className="settings-row-text">
      <span>{label}</span>
      {description === undefined ? null : <p>{description}</p>}
    </div>
    <div className="settings-row-value">{children}</div>
  </div>
);

const RenameServer = ({ serverName }: { readonly serverName: string }): React.ReactElement => {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(serverName);
  const rename = useMutation({
    mutationFn: () => runtime.admin.renameServer(name.trim()),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    },
  });
  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          rename.reset();
          setName(serverName);
          setOpen(true);
        }}
      >
        Rename…
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Rename server"
        description="Everyone who connects to this server sees this name."
      >
        <Form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate();
          }}
        >
          <TextField label="Server name" value={name} onValueChange={setName} autoFocus />
          {rename.isError ? (
            <p className="form-error" role="alert">
              <CircleAlert aria-hidden="true" size={15} />
              <span>{errorMessage(rename.error, "Could not rename the server")}</span>
            </p>
          ) : null}
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={rename.isPending || name.trim() === "" || name.trim() === serverName}
            >
              {rename.isPending ? "Renaming…" : "Rename"}
            </Button>
          </div>
        </Form>
      </Modal>
    </>
  );
};

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
const letters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(97 + index));
const languageCodes = letters
  .flatMap((first) => letters.map((second) => first + second))
  .filter((code) => languageNames.of(code) !== code && new Intl.Locale(code).language === code);
const languageOptions = languageCodes
  .map((value) => ({ value, label: languageNames.of(value) ?? value }))
  .sort((a, b) => a.label.localeCompare(b.label));

const qualityOptions = [
  { value: "original", label: "Original" },
  { value: "auto", label: "Auto" },
  ...adaptiveRenditionsFor(null).map((rendition) => ({ value: rendition.id, label: rendition.id })),
];

const TrackSettings = ({ connectionId }: { readonly connectionId: string }): React.ReactElement => {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const queryKey = ["track-preferences", connectionId];
  const preferences = useQuery({ queryKey, queryFn: () => runtime.trackSettings.read() });
  const update = useMutation({
    mutationFn: (input: TrackPreferencesPatch) => runtime.trackSettings.update(input),
    onSuccess: (value) => queryClient.setQueryData(queryKey, value),
  });
  if (preferences.isPending) return <p role="status">Loading audio and subtitle settings…</p>;
  if (preferences.isError)
    return (
      <div role="alert">
        {errorMessage(preferences.error, "Could not load playback settings")}
        <Button onClick={() => void preferences.refetch()}>Retry</Button>
      </div>
    );
  if (preferences.data === null)
    return <p>This server does not support saved audio and subtitle settings.</p>;
  const options = [...languageOptions];
  for (const language of [preferences.data.audioLanguage, preferences.data.subtitleLanguage]) {
    if (language !== null && !options.some((option) => option.value === language))
      options.push({ value: language, label: languageNames.of(language) ?? language });
  }
  return (
    <>
      <SettingsRow
        label="Preferred audio"
        description="Used when this show or movie has no available saved choice."
      >
        <SelectField
          label="Preferred audio language"
          hideLabel
          value={preferences.data.audioLanguage}
          disabled={update.isPending}
          options={options}
          onValueChange={(audioLanguage) => update.mutate({ audioLanguage })}
        />
      </SettingsRow>
      <SettingsRow
        label="Preferred subtitles"
        description="Your saved show and movie choices stay in place when you change these settings."
      >
        <SelectField
          label="Preferred subtitles"
          hideLabel
          value={preferences.data.subtitleLanguage ?? "off"}
          disabled={update.isPending}
          options={[{ value: "off", label: "Off" }, ...options]}
          onValueChange={(value) =>
            update.mutate({ subtitleLanguage: value === "off" ? null : value })
          }
        />
      </SettingsRow>
      {preferences.data.quality === undefined ? null : (
        <SettingsRow
          label="Quality"
          description="Used when this show or movie has no saved choice. Original plays the file without converting it."
        >
          <SelectField
            label="Quality"
            hideLabel
            value={preferences.data.quality}
            disabled={update.isPending}
            options={qualityOptions}
            onValueChange={(quality) => update.mutate({ quality })}
          />
        </SettingsRow>
      )}
      {update.isError ? (
        <p className="form-error" role="alert">
          {errorMessage(update.error, "Could not save playback settings")}
          <Button
            onClick={() => {
              if (update.variables !== undefined) update.mutate(update.variables);
            }}
          >
            Retry
          </Button>
        </p>
      ) : null}
    </>
  );
};

const ServerSettings = (): React.ReactElement => {
  const { account, openConnections } = useWorkspace();
  const { capabilities } = useRuntime();
  return (
    <div className="settings-stack">
      <div className="settings-card">
        <SettingsRow label={account.serverName} description={hostOf(account.origin)}>
          {account.role === "admin" ? <RenameServer serverName={account.serverName} /> : null}
        </SettingsRow>
        {capabilities.serverSwitching ? (
          <div className="settings-row settings-row-actions">
            <Button onClick={() => openConnections("saved")}>Switch server…</Button>
            <Button variant="ghost" onClick={() => openConnections("add")}>
              Add server…
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

const AboutSettings = (): React.ReactElement => {
  const { accounts } = useRuntime();
  const { account } = useWorkspace();
  const client = useClientVersions();
  // Asked fresh each time, since the server may have been upgraded since this client connected.
  const server = useQuery({
    queryKey: ["server-version", account.connectionId, account.origin],
    queryFn: async () =>
      (await accounts.discoverServer(account.origin)).identity.serverVersion ?? null,
    retry: false,
  });
  const mpv = client.data?.mpv ?? null;
  return (
    <div className="settings-card">
      <SettingsRow label="App">{client.data?.client ?? null}</SettingsRow>
      <SettingsRow label="Server" description={account.serverName}>
        {server.isPending
          ? "Checking…"
          : server.isError
            ? "Unavailable"
            : (server.data ?? "Unknown")}
      </SettingsRow>
      {mpv === null ? null : <SettingsRow label="MPV">{mpv.version ?? "Unknown"}</SettingsRow>}
    </div>
  );
};

interface Category {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly content: () => ReactNode;
}

const useCategoryGroups = (): ReadonlyArray<{
  readonly title: string;
  readonly categories: ReadonlyArray<Category>;
}> => {
  const { account } = useWorkspace();
  const { capabilities, downloads, appUpdates, routes } = useRuntime();
  const updates = useAppUpdateStatus(appUpdates);
  // Read while Settings opens, so About shows them in the frame it is chosen.
  useClientVersions();
  const client: Category[] = [
    {
      id: "playback",
      label: "Playback",
      icon: Play,
      content: () => (
        <div className="settings-card">
          <TrackSettings key={account.connectionId} connectionId={account.connectionId} />
        </div>
      ),
    },
  ];
  if (downloads !== null)
    client.push({
      id: "downloads",
      label: "Downloads",
      icon: HardDrive,
      content: () => <DownloadSettingsSection />,
    });
  if (routes !== null)
    client.push({
      id: "routes",
      label: "Routes",
      icon: Route,
      content: () => <ServerRoutesSection account={account} />,
    });
  if (appUpdates !== null && updates.data?.automatic != null)
    client.push({
      id: "updates",
      label: "Updates",
      icon: CircleArrowUp,
      content: () => <AppUpdateSettings updates={appUpdates} />,
    });
  client.push({ id: "about", label: "About", icon: Info, content: () => <AboutSettings /> });
  const serverCategories: Category[] = [];
  if (account.role === "admin" || capabilities.serverSwitching) {
    serverCategories.push({
      id: "general",
      label: "General",
      icon: Server,
      content: () => <ServerSettings />,
    });
  }
  if (account.role === "admin") {
    serverCategories.push({
      id: "transcoding",
      label: "Transcoding",
      icon: Cpu,
      content: () => (
        <TranscodingSettingsPanel key={account.connectionId} connectionId={account.connectionId} />
      ),
    });
  }
  if (serverCategories.length === 0) return [{ title: "Client", categories: client }];
  return [
    { title: "Client", categories: client },
    { title: "Server", categories: serverCategories },
  ];
};

export const SettingsDialog = ({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.ReactElement => {
  const groups = useCategoryGroups();
  const [selected, setSelected] = useState("playback");
  const categories = groups.flatMap((group) => group.categories);
  // A category that went away, such as server settings after switching to a viewer account,
  // falls back to the first one.
  const current = categories.find((category) => category.id === selected) ?? categories[0];
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      hideHeader
      className="settings-dialog"
    >
      <nav className="settings-dialog-nav" aria-label="Settings">
        {groups.map((group) => (
          <div className="nav-group" key={group.title}>
            <span className="nav-heading">{group.title}</span>
            {group.categories.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                className="nav-item"
                key={id}
                aria-current={id === current?.id ? "page" : undefined}
                onClick={() => setSelected(id)}
              >
                <Icon aria-hidden="true" size={16} strokeWidth={1.85} />
                <span className="nav-item-label">{label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="settings-dialog-main">
        <div className="settings-dialog-header">
          <span>Settings</span>
          <span aria-hidden="true">/</span>
          <h2>{current?.label}</h2>
        </div>
        <div className="settings-dialog-body">{current?.content()}</div>
      </div>
    </Modal>
  );
};
